"""Evidence-policy tests; these do not claim an installed WebView proof."""
import copy
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("packaged_smoke", Path(__file__).with_name("tauri-packaged-smoke.py"))
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


class ReportValidationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="21x-report-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.installed = self.root / "installed"
        self.resources = self.installed / "resources"
        for name in ("node/node.exe" if sys.platform == "win32" else "node/node", "node/LICENSE",
                     "service/THIRD_PARTY_NOTICES.json", "service/feasibility.mjs",
                     "service/database-stdio.mjs", "service/database-engine.mjs"):
            file = self.resources / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text("fixture")

    def report(self, mode):
        runtime = {
            "initialized": True, "systemNodeHidden": True, "developmentFrontend": False,
            "hostArch": "x86_64", "resourceRoot": str(self.resources),
            "profileRoot": str(self.root / ("profile" if mode == "feasibility" else "21x-database-service-test")),
            "syntheticDesktop": mode != "feasibility", "syntheticAgent": mode == "synthetic-agent",
        }
        gui = dict.fromkeys(("webviewLoadFinished", "remoteNavigationDenied", "windowCloseRequested", "windowCloseObserved"), True)
        if mode == "feasibility":
            runtime["nativeProbe"] = {"ok": True, "arch": "x64"}
            gui.update(rendererPing=True, restrictedOperationDenied=True)
        else:
            runtime["syntheticDesktopProof"] = dict.fromkeys(
                smoke.DESKTOP_RECEIPTS + (smoke.AGENT_RECEIPTS if mode == "synthetic-agent" else ()), True)
        if mode == "artifact-authorization-proof":
            runtime["artifactAuthorizationProof"] = {
                "passed": True, "boundary": "separate-webview", "sameMainIframeIsolationProven": False,
                "policyVersion": 3, "frameNativeAttemptMethod": "opaque-rejection-and-valid-origin-frame-acl",
                "authenticatedFrameOrigin": "separate-fixed-protocol", "opaqueFrameAuthenticatedIpcProven": False, "defaultMainCspUnchanged": True,
                "artifactWindowClosed": True, "excludedDocumentReady": True, "mainReceivedTargetedServiceEvent": True,
                "mainPositiveControls": dict.fromkeys(("transportAvailable", "desktopAccepted", "statusAccepted", "listenAccepted"), True),
                "sameLocalOriginExcludedWebview": dict.fromkeys(("transportAvailable", "desktopDenied", "statusDenied", "listenDenied"), True),
                "sandboxedArtifactFrame": dict.fromkeys(("transportAvailable", "frameLoaded", "parentAccessDenied", "parentGlobalDenied",
                                                        "frameBridgeAbsent", "relayDesktopDenied", "relayStatusDenied", "relayListenDenied"), True),
            }
            runtime["artifactAuthorizationProof"]["sandboxedArtifactFrame"].update(
                directAttempted=False, directDesktopDenied=False, directStatusDenied=False, directListenDenied=False,
                directDeadlineReached=False, directUnrecognizedFailure=False, directAccepted=False,
                directDesktopOriginRejected=False, directStatusOriginRejected=False, directListenOriginRejected=False,
                directInvalidOrigin=False, directMissingOrigin=False, opaqueOrigin=True, crossOriginProtocolDocument=False)
            runtime["artifactAuthorizationProof"]["authenticatedCrossOriginFrame"] = copy.deepcopy(
                runtime["artifactAuthorizationProof"]["sandboxedArtifactFrame"])
            runtime["artifactAuthorizationProof"]["authenticatedCrossOriginFrame"]["crossOriginProtocolDocument"] = True
        return {"stage": "complete", "passed": True, "gui": gui, "runtime": runtime,
                "shutdown": {"engineUnavailable": True, "ownedChildExited": True}}

    def verify(self, report, mode):
        return smoke.verify_report(report, mode=mode, arch="x64", installed=self.installed, root=self.root)

    def test_accepts_each_mode_without_requiring_feasibility_probe_in_synthetic_modes(self):
        for mode in smoke.PROOF_MODES:
            with self.subTest(mode=mode):
                self.assertTrue(self.verify(self.report(mode), mode).is_file())

    def test_rejects_any_other_mode_even_when_overall_report_passed(self):
        for expected in smoke.PROOF_MODES:
            for actual in smoke.PROOF_MODES:
                if expected != actual:
                    with self.subTest(expected=expected, actual=actual), self.assertRaises((AssertionError, KeyError)):
                        self.verify(self.report(actual), expected)

    def test_every_required_receipt_must_be_present_and_exactly_true(self):
        for mode in smoke.PROOF_MODES[1:]:
            original = self.report(mode)
            for key in original["runtime"]["syntheticDesktopProof"]:
                for value in (None, False, 1, "true"):
                    report = copy.deepcopy(original)
                    if value is None:
                        del report["runtime"]["syntheticDesktopProof"][key]
                    else:
                        report["runtime"]["syntheticDesktopProof"][key] = value
                    with self.subTest(mode=mode, key=key, value=value), self.assertRaises(AssertionError):
                        self.verify(report, mode)

    def test_rejects_unreviewed_receipt(self):
        report = self.report("synthetic-agent")
        report["runtime"]["syntheticDesktopProof"]["invented"] = True
        with self.assertRaises(AssertionError):
            self.verify(report, "synthetic-agent")

    def test_checks_each_artifact_control_independently_of_overall_pass(self):
        mode = "artifact-authorization-proof"
        original = self.report(mode)
        authority = original["runtime"]["artifactAuthorizationProof"]
        for section in ("mainPositiveControls", "sameLocalOriginExcludedWebview", "sandboxedArtifactFrame", "authenticatedCrossOriginFrame"):
            for key in authority[section]:
                if key.startswith("direct") or key in ("opaqueOrigin", "crossOriginProtocolDocument"):
                    continue
                report = copy.deepcopy(original)
                report["runtime"]["artifactAuthorizationProof"][section][key] = False
                with self.subTest(section=section, key=key), self.assertRaises(AssertionError):
                    self.verify(report, mode)

    def test_injected_frame_requires_each_actual_direct_denial(self):
        mode = "artifact-authorization-proof"
        report = self.report(mode)
        frame = report["runtime"]["artifactAuthorizationProof"]["sandboxedArtifactFrame"]
        frame.update(frameBridgeAbsent=False, directAttempted=True,
                     directDesktopDenied=True, directStatusDenied=True, directListenDenied=True)
        self.verify(report, mode)
        for key in ("directAttempted", "directDesktopDenied", "directStatusDenied", "directListenDenied"):
            for value in (None, False, 1, "true"):
                invalid = copy.deepcopy(report)
                invalid["runtime"]["artifactAuthorizationProof"]["sandboxedArtifactFrame"][key] = value
                with self.subTest(key=key, value=value), self.assertRaises(AssertionError):
                    self.verify(invalid, mode)

    def test_absent_frame_cannot_claim_direct_calls_were_denied(self):
        mode = "artifact-authorization-proof"
        for key in ("directAttempted", "directDesktopDenied", "directStatusDenied", "directListenDenied"):
            report = self.report(mode)
            report["runtime"]["artifactAuthorizationProof"]["sandboxedArtifactFrame"][key] = True
            with self.subTest(key=key), self.assertRaises(AssertionError):
                self.verify(report, mode)

    def test_rejects_older_artifact_policy_as_new_direct_frame_evidence(self):
        mode = "artifact-authorization-proof"
        for value in (None, 1, 2, "3"):
            report = self.report(mode)
            report["runtime"]["artifactAuthorizationProof"]["policyVersion"] = value
            with self.subTest(value=value), self.assertRaises(AssertionError):
                self.verify(report, mode)

    def test_injected_frame_rejects_timeouts_unrecognized_errors_and_accepted_calls(self):
        mode = "artifact-authorization-proof"
        for key in ("directDeadlineReached", "directUnrecognizedFailure", "directAccepted"):
            report = self.report(mode)
            frame = report["runtime"]["artifactAuthorizationProof"]["sandboxedArtifactFrame"]
            frame.update(frameBridgeAbsent=False, directAttempted=True,
                         directDesktopDenied=True, directStatusDenied=True, directListenDenied=True)
            frame[key] = True
            with self.subTest(key=key), self.assertRaises(AssertionError):
                self.verify(report, mode)

    def test_does_not_allow_broader_frame_isolation_claim(self):
        mode = "artifact-authorization-proof"
        report = self.report(mode)
        report["runtime"]["artifactAuthorizationProof"]["sameMainIframeIsolationProven"] = True
        with self.assertRaises(AssertionError):
            self.verify(report, mode)

    def test_opaque_origin_rejection_never_substitutes_for_valid_origin_frame_acl(self):
        mode = "artifact-authorization-proof"
        report = self.report(mode)
        opaque = report["runtime"]["artifactAuthorizationProof"]["sandboxedArtifactFrame"]
        opaque.update(frameBridgeAbsent=False, directAttempted=True, directUnrecognizedFailure=True,
                      directInvalidOrigin=True, directStringError=True, directTypeError=False, directSecurityError=False,
                      directDesktopOriginRejected=True, directStatusOriginRejected=True, directListenOriginRejected=True)
        self.verify(report, mode)
        invalid = copy.deepcopy(report)
        invalid["runtime"]["artifactAuthorizationProof"]["authenticatedCrossOriginFrame"] = copy.deepcopy(opaque)
        invalid["runtime"]["artifactAuthorizationProof"]["authenticatedCrossOriginFrame"]["crossOriginProtocolDocument"] = True
        with self.assertRaises(AssertionError):
            self.verify(invalid, mode)
        for key in ("directDesktopOriginRejected", "directStatusOriginRejected", "directListenOriginRejected"):
            invalid = copy.deepcopy(report)
            invalid["runtime"]["artifactAuthorizationProof"]["sandboxedArtifactFrame"][key] = False
            with self.subTest(key=key), self.assertRaises(AssertionError):
                self.verify(invalid, mode)

    def test_injected_valid_origin_frame_requires_each_real_acl_denial(self):
        mode = "artifact-authorization-proof"
        report = self.report(mode)
        frame = report["runtime"]["artifactAuthorizationProof"]["authenticatedCrossOriginFrame"]
        frame.update(frameBridgeAbsent=False, directAttempted=True, opaqueOrigin=False,
                     directDesktopDenied=True, directStatusDenied=True, directListenDenied=True)
        self.verify(report, mode)
        for key in ("directDesktopDenied", "directStatusDenied", "directListenDenied", "crossOriginProtocolDocument"):
            invalid = copy.deepcopy(report)
            invalid["runtime"]["artifactAuthorizationProof"]["authenticatedCrossOriginFrame"][key] = False
            with self.subTest(key=key), self.assertRaises(AssertionError):
                self.verify(invalid, mode)
        frame["opaqueOrigin"] = True
        with self.assertRaises(AssertionError):
            self.verify(report, mode)

    def test_rejects_resource_root_outside_installed_package(self):
        report = self.report("synthetic-agent")
        report["runtime"]["resourceRoot"] = str(self.root / "development-resources")
        with self.assertRaises(AssertionError):
            self.verify(report, "synthetic-agent")

    def test_rejects_profile_outside_owned_temporary_root(self):
        for mode in smoke.PROOF_MODES:
            report = self.report(mode)
            report["runtime"]["profileRoot"] = str(self.root.parent / "21x-database-service-live")
            with self.subTest(mode=mode), self.assertRaises(AssertionError):
                self.verify(report, mode)

    def test_requires_packaged_synthetic_service_files(self):
        (self.resources / "service/database-engine.mjs").unlink()
        with self.assertRaises(AssertionError):
            self.verify(self.report("synthetic-agent"), "synthetic-agent")

    def test_requires_owned_child_exit_acknowledgement(self):
        report = self.report("synthetic-agent")
        report["shutdown"]["ownedChildExited"] = False
        with self.assertRaises(AssertionError):
            self.verify(report, "synthetic-agent")

    def test_rejects_wrong_installed_host_architecture(self):
        report = self.report("synthetic-agent")
        report["runtime"]["hostArch"] = "aarch64"
        with self.assertRaises(AssertionError):
            self.verify(report, "synthetic-agent")

    def test_runtime_versions_use_the_verified_binary_without_inherited_preloads_or_secrets(self):
        binary = self.resources / "node" / ("node.exe" if sys.platform == "win32" else "node")
        metadata = {"nodeVersion": "v22.23.2", "nodeAbi": "127", "platform": sys.platform, "arch": "x64"}
        runtime = {"webviewVersion": "123.4.5", "webviewDefaultRuntime": True}
        with patch.dict("os.environ", {"NODE_OPTIONS": "--require fixture", "PATH": "/system-node",
                                        "ELECTRON_RUN_AS_NODE": "1", "SECRET_KEY": "not-copied"}), \
                patch.object(smoke.subprocess, "check_output", return_value=smoke.json.dumps(metadata)) as query:
            result = smoke.runtime_versions(binary, runtime, "x64")
        self.assertEqual(result["node"], metadata)
        self.assertEqual(result["webview"]["version"], "123.4.5")
        # Windows platform.version() may query cmd's version afterward too.
        # Assert the explicit packaged-Node query rather than the final OS query.
        node_query = query.call_args_list[0]
        self.assertEqual(node_query.args[0][:2], [str(binary), "-p"])
        for name in ("NODE_OPTIONS", "PATH", "ELECTRON_RUN_AS_NODE", "SECRET_KEY"):
            self.assertNotIn(name, node_query.kwargs["env"])

    def test_runtime_versions_reject_missing_webview_version_and_selected_runtime_override(self):
        metadata = {"nodeVersion": "v22.23.2", "nodeAbi": "127", "platform": sys.platform, "arch": "x64"}
        for version, default in ((None, True), ("", True), (1, True), ("x" * 129, True), ("123", False)):
            with self.subTest(version=version, default=default), \
                    patch.object(smoke.subprocess, "check_output", return_value=smoke.json.dumps(metadata)), \
                    self.assertRaises(AssertionError):
                smoke.runtime_versions(self.resources / "node/node", {"webviewVersion": version, "webviewDefaultRuntime": default}, "x64")

    def test_runtime_versions_reject_wrong_node_arch_platform_and_malformed_versions(self):
        base = {"nodeVersion": "v22.23.2", "nodeAbi": "127", "platform": sys.platform, "arch": "x64"}
        for key, value in (("arch", "arm64"), ("platform", "wrong"), ("nodeVersion", "vUnknown"), ("nodeAbi", "unknown")):
            metadata = {**base, key: value}
            with self.subTest(key=key), patch.object(smoke.subprocess, "check_output", return_value=smoke.json.dumps(metadata)), \
                    self.assertRaises(AssertionError):
                smoke.runtime_versions(self.resources / "node/node", {"webviewVersion": "123", "webviewDefaultRuntime": True}, "x64")

    def test_node_resolving_outside_resources_is_rejected_before_metadata_execution(self):
        entry = self.resources / "node" / ("node.exe" if sys.platform == "win32" else "node")
        original = Path.resolve

        def resolve(path, *args, **kwargs):
            return self.root / "outside-node" if path == entry else original(path, *args, **kwargs)

        with patch.object(Path, "resolve", resolve), patch.object(smoke.subprocess, "check_output") as query:
            with self.assertRaises(AssertionError):
                smoke.observe_package(self.report("synthetic-agent"), installed=self.installed, arch="x64",
                                      provenance={}, require_versions=True)
            query.assert_not_called()

    def test_failed_gui_retains_checksum_and_versions_without_becoming_accepted(self):
        evidence = self.root / "evidence"
        evidence.mkdir()
        failed = self.report("artifact-authorization-proof")
        failed["passed"] = False
        failed["runtime"]["artifactAuthorizationProof"]["passed"] = False
        metadata = {"fixture": "versions"}

        def fail(command, **kwargs):
            (evidence / "packaged-gui-smoke.json").write_text(smoke.json.dumps(failed))
            raise RuntimeError("Packaged command failed with exit status 1")

        executable = self.installed / "fixture-app"
        with patch.object(sys, "argv", ["smoke", "--kind", "nsis", "--arch", "x64", "--mode",
                                       "artifact-authorization-proof", "--evidence", str(evidence), "--require-runtime-versions"]), \
                patch.object(smoke, "packaged_executable", return_value=([str(executable)], self.installed, executable, {}, Path("fixture.exe"), "a" * 64)), \
                patch.object(smoke, "run", side_effect=fail), \
                patch.object(smoke, "running_owned_node", return_value=[]), \
                patch.object(smoke, "runtime_versions", return_value=metadata), \
                self.assertRaisesRegex(RuntimeError, "exit status 1"):
            smoke.main()
        observed = smoke.json.loads((evidence / "packaged-gui-smoke.json").read_text())
        self.assertIs(observed["passed"], False)
        self.assertIs(observed["runtime"]["artifactAuthorizationProof"]["passed"], False)
        self.assertIs(observed["verification"]["smokeCommandSucceeded"], False)
        self.assertEqual(observed["verification"]["packageSha256"], "a" * 64)
        self.assertEqual(observed["verification"]["runtimeVersions"], metadata)
        with self.assertRaises(AssertionError):
            self.verify(observed, "artifact-authorization-proof")

    def test_failure_before_a_native_report_still_retains_package_provenance(self):
        evidence = self.root / "empty-evidence"
        executable = self.installed / "fixture-app"
        with patch.object(sys, "argv", ["smoke", "--kind", "nsis", "--arch", "x64", "--evidence", str(evidence)]), \
                patch.object(smoke, "packaged_executable", return_value=([str(executable)], self.installed, executable, {}, Path("fixture.exe"), "b" * 64)), \
                patch.object(smoke, "run", side_effect=RuntimeError("Packaged command failed")), \
                self.assertRaises(RuntimeError):
            smoke.main()
        provenance = smoke.json.loads((evidence / "package-provenance.json").read_text())
        self.assertEqual(provenance["packageSha256"], "b" * 64)
        self.assertIs(provenance["smokeCommandSucceeded"], False)
        self.assertFalse((evidence / "packaged-gui-smoke.json").exists())


if __name__ == "__main__":
    unittest.main()
