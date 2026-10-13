"""Exercise real packaged resources. No development-root overrides or publishing."""
import argparse
import hashlib
import json
import os
import platform
import re
from pathlib import Path
import subprocess
import sys
import tempfile

PROOF_MODES = ("feasibility", "synthetic-desktop", "synthetic-agent", "artifact-authorization-proof")
DESKTOP_RECEIPTS = (
    "taskCreated", "taskEventObserved", "taskUpdated", "updateEventObserved",
    "projectCreated", "missingResultPreserved", "settingPersisted",
    "transcriptSnapshotRead", "transcriptDeltaRead", "rendererReloaded",
    "rehydrated", "retiredOperationDenied", "staleEpochDenied",
)
AGENT_RECEIPTS = (
    "agentStarted", "approvalRequested", "staleApprovalDenied", "approvalAccepted",
    "agentCompleted", "agentStatusEventObserved", "agentTranscriptRehydrated",
)


def verify_artifact_authority(authority):
    assert authority["passed"] is True and authority["boundary"] == "separate-webview"
    assert authority["sameMainIframeIsolationProven"] is False
    assert authority["policyVersion"] == 2
    assert authority["frameNativeAttemptMethod"] == "parent-relay-and-conditional-direct-frame"
    for key in ("artifactWindowClosed", "excludedDocumentReady", "mainReceivedTargetedServiceEvent", "defaultMainCspUnchanged"):
        assert authority[key] is True
    for section, keys in (
        ("mainPositiveControls", ("transportAvailable", "desktopAccepted", "statusAccepted", "listenAccepted")),
        ("sameLocalOriginExcludedWebview", ("transportAvailable", "desktopDenied", "statusDenied", "listenDenied")),
        ("sandboxedArtifactFrame", ("transportAvailable", "frameLoaded", "parentAccessDenied", "parentGlobalDenied",
                                   "relayDesktopDenied", "relayStatusDenied", "relayListenDenied")),
    ):
        assert all(authority[section][key] is True for key in keys)
    frame = authority["sandboxedArtifactFrame"]
    assert all(frame[key] is False for key in ("directDeadlineReached", "directUnrecognizedFailure", "directAccepted"))
    if frame["frameBridgeAbsent"] is True:
        assert frame["directAttempted"] is False
        assert all(frame[key] is False for key in ("directDesktopDenied", "directStatusDenied", "directListenDenied"))
    else:
        assert frame["frameBridgeAbsent"] is False
        assert all(frame[key] is True for key in ("directAttempted", "directDesktopDenied", "directStatusDenied", "directListenDenied"))


def verify_report(report, *, mode, arch, installed, root):
    """Fail closed if a successful package report exercised a different proof."""
    assert mode in PROOF_MODES
    assert report["stage"] == "complete" and report["passed"] is True
    runtime = report["runtime"]
    assert runtime["initialized"] is True and runtime["systemNodeHidden"] is True
    assert runtime["developmentFrontend"] is False
    assert runtime["hostArch"] == {"x64": "x86_64", "arm64": "aarch64"}[arch]
    for key in ("webviewLoadFinished", "remoteNavigationDenied", "windowCloseRequested", "windowCloseObserved"):
        assert report["gui"][key] is True
    assert report["shutdown"]["engineUnavailable"] is True
    assert report["shutdown"]["ownedChildExited"] is True
    resources = physical_path(runtime["resourceRoot"])
    assert resources.is_relative_to(installed)
    profile = physical_path(runtime["profileRoot"])
    assert runtime["syntheticDesktop"] is (mode != "feasibility")
    assert runtime["syntheticAgent"] is (mode == "synthetic-agent")
    if mode == "feasibility":
        assert profile == root / "profile"
        assert runtime["nativeProbe"]["ok"] is True
        assert runtime["nativeProbe"]["arch"] == arch
        assert report["gui"]["rendererPing"] is True
        assert report["gui"]["restrictedOperationDenied"] is True
    else:
        assert profile.is_relative_to(root) and profile.name.startswith("21x-database-service-")
        keys = DESKTOP_RECEIPTS + (AGENT_RECEIPTS if mode == "synthetic-agent" else ())
        proof = runtime["syntheticDesktopProof"]
        assert set(proof) == set(keys) and all(proof[key] is True for key in keys)
        assert (resources / "service/database-stdio.mjs").is_file()
        assert (resources / "service/database-engine.mjs").is_file()
    if mode == "artifact-authorization-proof":
        verify_artifact_authority(runtime["artifactAuthorizationProof"])
    else:
        assert "artifactAuthorizationProof" not in runtime
    owned_node = verified_owned_node(runtime, installed)
    for required in (owned_node, resources / "node/LICENSE", resources / "service/THIRD_PARTY_NOTICES.json",
                     resources / "service/feasibility.mjs"):
        assert required.is_file()
    return owned_node.resolve()


def verified_owned_node(runtime, installed):
    resources = physical_path(runtime["resourceRoot"])
    assert resources.is_relative_to(installed)
    entry = resources / "node" / ("node.exe" if sys.platform == "win32" else "node")
    assert entry.is_file() and not entry.is_symlink()
    owned_node = entry.resolve()
    assert owned_node.is_relative_to(resources) and owned_node.is_relative_to(installed)
    return owned_node


def observe_package(report, *, installed, arch, provenance, require_versions):
    """Retain failed-run provenance without marking its native proof accepted."""
    owned_node = verified_owned_node(report["runtime"], installed)
    verification = {**provenance, "ownedNodeContained": True,
                    "ownedRunningProcessesAfterExit": running_owned_node(owned_node)}
    if require_versions:
        verification["runtimeVersions"] = runtime_versions(owned_node, report["runtime"], arch)
    report["verification"] = verification
    return owned_node


def run(command, *, cwd=None, env=None, timeout=180, log=None):
    if log:
        with open(log, "ab") as output:
            result = subprocess.run(command, cwd=cwd, env=env, stdout=output,
                                    stderr=subprocess.STDOUT, timeout=timeout)
    else:
        result = subprocess.run(command, cwd=cwd, env=env, timeout=timeout)
    if result.returncode != 0:
        raise RuntimeError(f"Packaged command failed with exit status {result.returncode}")


def one(pattern):
    values = list(Path("src-tauri/target/debug/bundle").glob(pattern))
    if len(values) != 1:
        raise RuntimeError(f"Expected one package for {pattern}; found {len(values)}")
    return values[0].resolve()


def physical_path(value):
    # Rust canonicalize uses Win32 extended-length paths; normalize them before
    # comparing to Python's ordinary runner/installer paths.
    value = str(value)
    if sys.platform == "win32":
        if value.startswith("\\\\?\\UNC\\"):
            value = "\\\\" + value[8:]
        elif value.startswith("\\\\?\\"):
            value = value[4:]
    return Path(value).resolve()


def packaged_executable(kind, root, evidence):
    if kind == "dmg":
        artifact = one("dmg/*.dmg")
        mount = root / "mounted"
        mount.mkdir()
        run(["/usr/bin/hdiutil", "attach", str(artifact), "-readonly", "-nobrowse",
             "-mountpoint", str(mount)], log=evidence / "install.log")
        try:
            apps = list(mount.glob("*.app"))
            if len(apps) != 1:
                raise RuntimeError("Disk image does not contain one application")
            installed = root / apps[0].name
            run(["/usr/bin/ditto", str(apps[0]), str(installed)], log=evidence / "install.log")
        finally:
            run(["/usr/bin/hdiutil", "detach", str(mount)], log=evidence / "install.log")
        executable = installed / "Contents/MacOS/twentyonex-tauri-feasibility"
        command = [str(executable)]
        extra = {}
    elif kind == "nsis":
        artifact = one("nsis/*-setup.exe")
        installed = root / "installed"
        # NSIS requires the unquoted /D argument last. subprocess creates proper
        # Windows quoting; the path intentionally uses a runner temp directory.
        run([str(artifact), "/S", "/D=" + str(installed)], timeout=240,
            log=evidence / "install.log")
        executable = installed / "twentyonex-tauri-feasibility.exe"
        if not executable.is_file():
            alternatives = [path for path in installed.glob("*.exe")
                            if "uninstall" not in path.name.lower()]
            if len(alternatives) != 1:
                raise RuntimeError("Installed NSIS application executable is ambiguous")
            executable = alternatives[0]
        command = [str(executable)]
        extra = {}
    elif kind == "appimage":
        artifact = one("appimage/*.AppImage")
        artifact.chmod(artifact.stat().st_mode | 0o111)
        run([str(artifact), "--appimage-extract"], cwd=root, timeout=180,
            log=evidence / "install.log")
        installed = root / "squashfs-root"
        executable = installed / "usr/bin/twentyonex-tauri-feasibility"
        # AppRun supplies its own library paths and normal APPDIR resolution.
        command = ["/usr/bin/dbus-run-session", "--", "/usr/bin/xvfb-run", "--auto-servernum",
                   "--server-args=-screen 0 1280x720x24", str(installed / "AppRun")]
        extra = {"WEBKIT_DISABLE_COMPOSITING_MODE": "1"}
    else:
        raise RuntimeError("Unsupported package kind")
    if not executable.is_file():
        raise RuntimeError("Packaged executable is missing")
    with open(artifact, "rb") as package_file:
        checksum = hashlib.file_digest(package_file, "sha256").hexdigest()
    return command, installed.resolve(), executable.resolve(), extra, artifact, checksum


def running_owned_node(owned_node):
    """Compare actual executable paths only; never kill by a generic process name."""
    if sys.platform.startswith("linux"):
        found = []
        for process in Path("/proc").iterdir():
            if process.name.isdecimal():
                try:
                    if (process / "exe").resolve(strict=True) == owned_node:
                        found.append(process.name)
                except OSError:
                    pass
        return found
    if sys.platform == "win32":
        script = "$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process | Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress"
        raw = subprocess.check_output(["powershell.exe", "-NoProfile", "-Command", script], text=True, timeout=30)
        records = json.loads(raw)
        if isinstance(records, dict):
            records = [records]
        return [str(item["ProcessId"]) for item in records
                if item.get("ExecutablePath") and physical_path(item["ExecutablePath"]) == owned_node]
    if sys.platform == "darwin":
        # lsof reports the mapped executable's txt file (not a truncated ps name).
        raw = subprocess.run(["/usr/sbin/lsof", "-n", "-Fpn", str(owned_node)],
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=30)
        if raw.returncode not in (0, 1):
            raise RuntimeError("Owned process observation failed")
        return [line[1:] for line in raw.stdout.splitlines() if line.startswith("p")]
    raise RuntimeError("No owned process observation for this platform")


def runtime_versions(owned_node, runtime, arch):
    """Query only the verified packaged binary and native-selected WebView."""
    env = {key: value for key, value in os.environ.items()
           if key.upper() in ("SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR")}
    code = "JSON.stringify({nodeVersion:process.version,nodeAbi:process.versions.modules,platform:process.platform,arch:process.arch})"
    node = json.loads(subprocess.check_output([str(owned_node), "-p", code],
                                             env=env, text=True, timeout=15))
    assert node["arch"] == arch and node["platform"] == sys.platform
    assert isinstance(node["nodeVersion"], str) and re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?", node["nodeVersion"])
    assert isinstance(node["nodeAbi"], str) and node["nodeAbi"].isdecimal()
    webview = runtime.get("webviewVersion")
    assert isinstance(webview, str) and 0 < len(webview) <= 128
    assert runtime.get("webviewDefaultRuntime") is True
    os_version = {"system": platform.system(), "release": platform.release(), "version": platform.version()}
    if sys.platform == "darwin":
        os_version["macOS"] = platform.mac_ver()[0]
    if sys.platform.startswith("linux"):
        distribution = {}
        for line in Path("/etc/os-release").read_text().splitlines():
            key, separator, value = line.partition("=")
            if separator and key in ("ID", "VERSION_ID"):
                distribution[key] = value.strip('"')
        os_version["distribution"] = distribution
        os_version["libc"] = list(platform.libc_ver())
    return {"schemaVersion": 1, "os": os_version, "node": node,
            "webview": {"version": webview, "source": "tauri::webview_version", "defaultRuntime": True}}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--kind", choices=["dmg", "nsis", "appimage"], required=True)
    parser.add_argument("--arch", choices=["x64", "arm64"], required=True)
    parser.add_argument("--mode", choices=PROOF_MODES, default="feasibility")
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--require-runtime-versions", action="store_true")
    args = parser.parse_args()
    evidence = args.evidence.resolve()
    evidence.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="21x-packaged-", dir=os.environ.get("RUNNER_TEMP")) as temporary:
        root = Path(temporary).resolve()
        command, installed, executable, extra, artifact, checksum = packaged_executable(args.kind, root, evidence)
        report_path = evidence / "packaged-gui-smoke.json"
        env = {**os.environ, **extra,
               "TWENTYONEX_NATIVE_SMOKE_REPORT": str(report_path),
               "TWENTYONEX_NATIVE_SMOKE_PROFILE": str(root / "profile"),
               "TMPDIR": str(root), "TMP": str(root), "TEMP": str(root)}
        provenance = {"packageKind": args.kind, "proofMode": args.mode, "packageSha256": checksum,
                      "artifact": artifact.name, "packagedExecutable": str(executable),
                      "smokeCommandSucceeded": False}
        provenance_path = evidence / "package-provenance.json"
        provenance_path.write_text(json.dumps(provenance, indent=2) + "\n")
        try:
            run(command, cwd=root, env=env, timeout=120, log=evidence / "packaged-gui-smoke.log")
        except (RuntimeError, subprocess.TimeoutExpired):
            if report_path.is_file() and report_path.stat().st_size <= 1024 * 1024:
                try:
                    report = json.loads(report_path.read_text())
                    observe_package(report, installed=installed, arch=args.arch, provenance=provenance,
                                    require_versions=args.require_runtime_versions)
                    report_path.write_text(json.dumps(report, indent=2) + "\n")
                except (AssertionError, KeyError, ValueError, OSError, subprocess.SubprocessError):
                    provenance["nativeMetadataUnavailable"] = True
                    provenance_path.write_text(json.dumps(provenance, indent=2) + "\n")
            raise
        provenance["smokeCommandSucceeded"] = True
        provenance_path.write_text(json.dumps(provenance, indent=2) + "\n")
        report = json.loads(report_path.read_text())
        owned_node = verify_report(report, mode=args.mode, arch=args.arch, installed=installed, root=root)
        observe_package(report, installed=installed, arch=args.arch, provenance=provenance,
                        require_versions=args.require_runtime_versions)
        survivors = report["verification"]["ownedRunningProcessesAfterExit"]
        report["verification"]["packagedResources"] = True
        report_path.write_text(json.dumps(report, indent=2) + "\n")
        assert not survivors, "Owned packaged Node survived native shutdown"
        print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
