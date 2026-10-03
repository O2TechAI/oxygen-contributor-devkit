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
