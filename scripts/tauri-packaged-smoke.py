"""Exercise real packaged resources. No development-root overrides or publishing."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile


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
        raw = subprocess.check_output(["powershell.exe", "-NoProfile", "-Command", script], text=True)
        records = json.loads(raw)
        if isinstance(records, dict):
            records = [records]
        return [str(item["ProcessId"]) for item in records
                if item.get("ExecutablePath") and physical_path(item["ExecutablePath"]) == owned_node]
    if sys.platform == "darwin":
        # lsof reports the mapped executable's txt file (not a truncated ps name).
        raw = subprocess.run(["/usr/sbin/lsof", "-n", "-Fpn", str(owned_node)],
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        if raw.returncode not in (0, 1):
            raise RuntimeError("Owned process observation failed")
        return [line[1:] for line in raw.stdout.splitlines() if line.startswith("p")]
    raise RuntimeError("No owned process observation for this platform")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--kind", choices=["dmg", "nsis", "appimage"], required=True)
    parser.add_argument("--arch", choices=["x64", "arm64"], required=True)
    parser.add_argument("--evidence", type=Path, required=True)
    args = parser.parse_args()
    evidence = args.evidence.resolve()
    evidence.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="21x-packaged-", dir=os.environ.get("RUNNER_TEMP")) as temporary:
        root = Path(temporary).resolve()
        command, installed, executable, extra, artifact, checksum = packaged_executable(args.kind, root, evidence)
        report_path = evidence / "packaged-gui-smoke.json"
        env = {**os.environ, **extra,
               "TWENTYONEX_NATIVE_SMOKE_REPORT": str(report_path),
               "TWENTYONEX_NATIVE_SMOKE_PROFILE": str(root / "profile")}
        run(command, cwd=root, env=env, timeout=120, log=evidence / "packaged-gui-smoke.log")
        report = json.loads(report_path.read_text())
        runtime = report["runtime"]
        assert report["stage"] == "complete" and report["passed"] is True
        assert runtime["initialized"] and runtime["systemNodeHidden"]
        assert runtime["developmentFrontend"] is False
        assert runtime["nativeProbe"]["ok"] is True
        assert runtime["nativeProbe"]["arch"] == args.arch
        resources = physical_path(runtime["resourceRoot"])
        assert resources.is_relative_to(installed)
        assert physical_path(runtime["profileRoot"]) == root / "profile"
        owned_node = resources / "node" / ("node.exe" if sys.platform == "win32" else "node")
        assert owned_node.is_file()
        assert (resources / "node/LICENSE").is_file()
        assert (resources / "service/THIRD_PARTY_NOTICES.json").is_file()
        assert (resources / "service/feasibility.mjs").is_file()
        assert report["shutdown"]["engineUnavailable"] is True
        survivors = running_owned_node(owned_node.resolve())
        report["verification"] = {"packageKind": args.kind, "packageSha256": checksum,
                                  "artifact": artifact.name, "packagedExecutable": str(executable),
                                  "packagedResources": True, "ownedRunningProcessesAfterExit": survivors}
        report_path.write_text(json.dumps(report, indent=2) + "\n")
        assert not survivors, "Owned packaged Node survived native shutdown"
        print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
