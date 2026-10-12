"""Evidence-policy tests; these do not claim an installed WebView proof."""
import copy
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest

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
                "frameNativeAttemptMethod": "unprivileged-parent-relay", "defaultMainCspUnchanged": True,
                "artifactWindowClosed": True, "excludedDocumentReady": True, "mainReceivedTargetedServiceEvent": True,
                "mainPositiveControls": dict.fromkeys(("transportAvailable", "desktopAccepted", "statusAccepted", "listenAccepted"), True),
                "sameLocalOriginExcludedWebview": dict.fromkeys(("transportAvailable", "desktopDenied", "statusDenied", "listenDenied"), True),
                "sandboxedArtifactFrame": dict.fromkeys(("transportAvailable", "frameLoaded", "parentAccessDenied", "parentGlobalDenied",
                                                        "frameBridgeAbsent", "relayDesktopDenied", "relayStatusDenied", "relayListenDenied"), True),
            }
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
        for section in ("mainPositiveControls", "sameLocalOriginExcludedWebview", "sandboxedArtifactFrame"):
            for key in authority[section]:
                report = copy.deepcopy(original)
                report["runtime"]["artifactAuthorizationProof"][section][key] = False
                with self.subTest(section=section, key=key), self.assertRaises(AssertionError):
                    self.verify(report, mode)

    def test_does_not_allow_broader_frame_isolation_claim(self):
        mode = "artifact-authorization-proof"
        report = self.report(mode)
        report["runtime"]["artifactAuthorizationProof"]["sameMainIframeIsolationProven"] = True
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


if __name__ == "__main__":
    unittest.main()
