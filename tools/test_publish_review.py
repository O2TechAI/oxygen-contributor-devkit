import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


MODULE_PATH = Path(__file__).with_name("publish-review.py")
SPEC = importlib.util.spec_from_file_location("publish_review", MODULE_PATH)
PUBLISH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PUBLISH)


class PublishReviewTest(unittest.TestCase):
    def test_saved_review_comparison_import_is_a_separate_unredacted_draft(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            case = root / "case"
            case.mkdir()
            inputs = {
                "summary.md": b"Context.\n", "summary_labeled.md": b"L001 Context.\n",
                "review-snapshot.json": json.dumps({"insights": [
                    {"id": "I001", "authorship": "reviewer", "status": "accepted"}]}).encode(),
            }
            for name, data in inputs.items():
                (case / name).write_bytes(data)
            (case / "after.md").write_text("Rewritten card")
            manifest = {"kind": "single", "sourceKind": "current-saved-review",
                        "inputHashes": {name: PUBLISH.sha256(data) for name, data in inputs.items()}}
            state = {"status": "accepted", "outputHashes": {"after.md": PUBLISH.sha256(b"Rewritten card")}}
            (case / "manifest.json").write_text(json.dumps(manifest))
            (case / "state.json").write_text(json.dumps(state))
            (root / "instructions.md").write_text("Frozen instructions")
            experiment = {"protectedHashes": {"instructions.md": PUBLISH.sha256(b"Frozen instructions")},
                          "settings": {"model": "test-model", "reasoning_effort": "high"}}
            (root / "experiment.json").write_text(json.dumps(experiment))
            args = argparse.Namespace(humanize_comparison=case, project="Test", source="safe-label")
            payload = PUBLISH.comparison_payload(args)
            imported = json.loads(payload["manifestJson"])
            self.assertEqual(payload["stage"], "humanize")
            self.assertEqual(imported["format"], "oxygen-review-humanization/v1")
            self.assertFalse(imported["complete"])
            self.assertNotIn("input_sha256", imported)
            self.assertEqual(imported["reviewerAddedIds"], ["I001"])
            self.assertNotIn(str(root), json.dumps(payload))
            self.assertNotIn('"accepted"', json.dumps(payload))
            for path in (case / "after.md", case / "summary.md", root / "instructions.md"):
                original = path.read_bytes()
                path.write_text("changed")
                with self.assertRaisesRegex(ValueError, "hash mismatch"):
                    PUBLISH.comparison_payload(args)
                path.write_bytes(original)
            state["status"] = "running"
            (case / "state.json").write_text(json.dumps(state))
            with self.assertRaisesRegex(ValueError, "not been accepted"):
                PUBLISH.comparison_payload(args)

    def test_humanize_import_uses_its_own_hashes_and_requires_acceptance(self):
        with tempfile.TemporaryDirectory() as temporary:
            run = Path(temporary)
            for stage in ("insight", "humanize"):
                (run / stage).mkdir()
            files = {"summary.md": "Context.\n", "summary_labeled.md": "L001 Context.\n",
                     "insight.md": "humanized content"}
            for name, data in files.items():
                (run / "humanize" / name).write_text(data)
                (run / "insight" / name).write_text("original extraction")
            stage = {"status": "complete", "outputs": {"sha256": {
                name: hashlib.sha256(data.encode()).hexdigest() for name, data in files.items()}}}
            manifest = {"complete": False, "configuration": {"protocol_version": 9},
                        "stages": {"humanize": stage}}
            args = argparse.Namespace(run_dir=run, stage="humanize", project="example", source="safe")
            (run / "manifest.json").write_text(json.dumps(manifest))
            payload = PUBLISH.v5_payload(args)
            self.assertEqual(payload["stage"], "humanize")
            self.assertEqual(payload["insightMarkdown"], "humanized content")
            (run / "humanize/insight.md").write_text("tampered")
            with self.assertRaisesRegex(ValueError, "hash mismatch"):
                PUBLISH.v5_payload(args)
            stage["status"] = "issued"
            (run / "manifest.json").write_text(json.dumps(manifest))
            with self.assertRaisesRegex(ValueError, "not complete"):
                PUBLISH.v5_payload(args)

    def test_payload_preserves_protocol_version_and_verifies_redaction_artifacts(self):
        with tempfile.TemporaryDirectory() as temporary:
            run = Path(temporary)
            stage = run / "redaction"
            stage.mkdir()
            files = {
                "summary_redacted.md": "# Overview\n\nContext.\n",
                "summary_redacted_labeled.md": (
                    "L001 # Overview\nL002 \nL003 Context.\n"
                ),
                "insight_redacted.md": "",
            }
            hashes = {}
            for name, value in files.items():
                data = value.encode()
                (stage / name).write_bytes(data)
                hashes[name] = hashlib.sha256(data).hexdigest()
            manifest = {
                "complete": True,
                "input_sha256": "a" * 64,
                "configuration": {"protocol_version": 5},
                "stages": {
                    "redaction": {
                        "status": "complete",
                        "outputs": {"sha256": hashes},
                    }
                },
            }
            (run / "manifest.json").write_text(json.dumps(manifest))
            args = argparse.Namespace(
                run_dir=run,
                stage="redaction",
                project="example",
                source="safe-source",
            )

            for version in (5, 6, 7, 12):
                with self.subTest(version=version):
                    manifest["configuration"]["protocol_version"] = version
                    (run / "manifest.json").write_text(json.dumps(manifest))
                    payload = PUBLISH.v5_payload(args)

                    self.assertEqual(payload["format"], "v5")
                    self.assertEqual(payload["protocolVersion"], version)
                    self.assertEqual(payload["sourcePath"], "safe-source")
                    self.assertEqual(payload["summaryMarkdown"], files["summary_redacted.md"])

    def test_payload_rejects_invalid_protocol_metadata(self):
        with tempfile.TemporaryDirectory() as temporary:
            run = Path(temporary)
            args = argparse.Namespace(run_dir=run, stage="insight")
            for version in (None, True, "7", 0, -1, 7.5, 9007199254740992):
                with self.subTest(version=version):
                    (run / "manifest.json").write_text(json.dumps({
                        "configuration": {"protocol_version": version},
                    }))
                    with self.assertRaisesRegex(ValueError, "positive safe integer"):
                        PUBLISH.v5_payload(args)

    def test_v5_payload_rejects_changed_artifact(self):
        with tempfile.TemporaryDirectory() as temporary:
            run = Path(temporary)
            stage = run / "insight"
            stage.mkdir()
            for name in ("summary.md", "summary_labeled.md", "insight.md"):
                (stage / name).write_text("changed")
            manifest = {
                "complete": False,
                "configuration": {"protocol_version": 7},
                "stages": {
                    "insight": {
                        "status": "complete",
                        "outputs": {
                            "sha256": {
                                "summary.md": "0" * 64,
                                "summary_labeled.md": "0" * 64,
                                "insight.md": "0" * 64,
                            }
                        },
                    }
                },
            }
            (run / "manifest.json").write_text(json.dumps(manifest))
            args = argparse.Namespace(
                run_dir=run,
                stage="insight",
                project="example",
                source=None,
            )

            with self.assertRaisesRegex(ValueError, "hash mismatch"):
                PUBLISH.v5_payload(args)


if __name__ == "__main__":
    unittest.main()
