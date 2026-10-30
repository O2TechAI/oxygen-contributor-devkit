"""Exercise the lifecycle with synthetic completed v9 exports and no model calls."""

import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


SKILL = Path(__file__).resolve().parents[1]
SCRIPT = SKILL / "scripts" / "cross_session.py"
sys.path.insert(0, str(SCRIPT.parent))
try:
    SPEC = importlib.util.spec_from_file_location("cross_session_under_test", SCRIPT)
    CROSS = importlib.util.module_from_spec(SPEC)
    SPEC.loader.exec_module(CROSS)
finally:
    sys.path.pop(0)

FIXTURE_SPEC = importlib.util.spec_from_file_location(
    "review_export_fixtures", Path(__file__).with_name("test_review_exports.py")
)
FIXTURES = importlib.util.module_from_spec(FIXTURE_SPEC)
FIXTURE_SPEC.loader.exec_module(FIXTURES)


MARKDOWN = """# C001

Title: Check the claim against independent evidence
Type: agent
Description: Use when a reported outcome needs independent verification.
Workflow: Compare the reported outcome with separately recorded observations.
Example: S001 and S002 each recorded a separate unresolved verification step.
Evidence: S001:L002, S002:L002
"""


def snapshot(root):
    return {str(path.relative_to(root)): path.read_bytes()
            for path in root.rglob("*") if path.is_file()}


class CrossSessionLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.inputs = self.root / "exports"
        self.run = self.root / "run"
        self.live_skill = self.root / "live-skill"
        shutil.copytree(SKILL, self.live_skill,
                        ignore=shutil.ignore_patterns("tests", "__pycache__"))
        self.skill_patch = mock.patch.object(CROSS, "SKILL", self.live_skill)
        self.skill_patch.start()
        self.addCleanup(self.skill_patch.stop)
        self.category_reference = self.root / "shared-prompts/insight_categories.md"
        self.category_reference.parent.mkdir()
        self.category_reference.write_bytes(CROSS.CATEGORY_REFERENCE.read_bytes())
        category_patch = mock.patch.object(CROSS, "CATEGORY_REFERENCE", self.category_reference)
        category_patch.start()
        self.addCleanup(category_patch.stop)
        self.humanizer_root = self.root / "humanizer"
        shutil.copytree(CROSS.HUMANIZER_ROOT, self.humanizer_root)
        self.humanizer_wrapper = self.root / "humanize.md"
        shutil.copy2(CROSS.HUMANIZER_WRAPPER, self.humanizer_wrapper)
        humanizer_patch = mock.patch.object(CROSS, "HUMANIZER_ROOT", self.humanizer_root)
        humanizer_patch.start()
        self.addCleanup(humanizer_patch.stop)
        wrapper_patch = mock.patch.object(CROSS, "HUMANIZER_WRAPPER", self.humanizer_wrapper)
        wrapper_patch.start()
        self.addCleanup(wrapper_patch.stop)
        self.reviews = []
        entries = []
        for suffix, episode in (("a", "The first episode had an unresolved verification step."),
                                ("b", "A separate second episode also needed an independent check.")):
            review = FIXTURES.make_review(review_id="review-" + suffix,
                                          source_path="run/session-" + suffix, episode=episode)
            approval = FIXTURES.approval_for(review)
            FIXTURES.write_export(self.inputs / suffix, review, approval)
            self.reviews.append(review)
            entries.append(FIXTURES.collection_entry(suffix, review, approval))
        FIXTURES.write_manifest(self.inputs, entries)

    def prepare(self):
        return CROSS.prepare(self.inputs, self.run)

    def start_worker(self):
        self.prepare()
        CROSS.issue_call(self.run)
        CROSS.record_worker(self.run, "test-worker-no-model-launched")

    def write_outputs(self, *, empty=False, completion=None):
        (self.run / "cross_session_insights.md").write_text(
            "" if empty else MARKDOWN, encoding="utf-8")
        CROSS.write(self.run / "completion.json", completion if completion is not None else
                    {"status": "complete", "readingComplete": True})

    def read_all(self, *, limit=None):
        for name, item in CROSS.reading_files(self.run).items():
            chunk_limit = max(4, item["bytes"]) if limit is None else limit
            cursor = 0
            while True:
                receipt, _ = CROSS.read_chunk(self.run, name, cursor, chunk_limit)
                cursor = receipt["end"]
                if cursor == item["bytes"]:
                    break

    def accept(self):
        return CROSS.accept(self.run, "test-worker-no-model-launched", "complete")

    def accepted_run(self, *, empty=False):
        self.start_worker()
        self.read_all()
        self.write_outputs(empty=empty)
        return self.accept()

    def humanize(self, text=None):
        CROSS.issue_call(self.run, "humanize")
        CROSS.record_worker(self.run, "humanizer-test-worker", "humanize")
        (self.run / "humanize/cross_session_insights.md").write_bytes(
            (self.run / "cross_session_insights.md").read_bytes() if text is None else text.encode())
        CROSS.write(self.run / "humanize/completion.json", {"status": "complete", "readingComplete": True})
        return CROSS.accept(self.run, "humanizer-test-worker", "complete", "humanize")

    def test_humanizer_finishes_run_and_preserves_extraction_receipts(self):
        self.accepted_run()
        sealed = CROSS.load(self.run / "state.json")["outputHashes"]
        self.assertEqual(CROSS.load(self.run / "state.json")["status"], "extracted")
        self.read_all()
        result = self.humanize(MARKDOWN.replace("Use when a reported outcome", "Use when an outcome"))
        self.assertEqual(result["runStatus"], "accepted")
        self.assertEqual(result["finalOutputs"]["markdown"], str(self.run / "humanize/cross_session_insights.md"))
        self.assertEqual(result["finalOutputs"]["completion"], str(self.run / "humanize/completion.json"))
        self.assertEqual(result["finalOutputs"]["validation"], str(self.run / "humanize/validation.json"))
        for name, expected in sealed.items():
            self.assertEqual(CROSS.digest((self.run / name).read_bytes()), expected)
        CROSS.verify(self.run)

    def test_humanizer_exact_bundle_is_frozen_without_live_dependency(self):
        self.accepted_run()
        for name, data in CROSS.HUMANIZER.bundle(self.humanizer_root, self.humanizer_wrapper).items():
            self.assertEqual((self.run / "protocol/references" / name).read_bytes(), data)
        shutil.rmtree(self.humanizer_root)
        self.humanizer_wrapper.unlink()
        self.humanize()
        CROSS.verify(self.run)

    def test_humanizer_unavailable_reference_prevents_preparation(self):
        (self.humanizer_root / "LICENSE").unlink()
        with self.assertRaisesRegex(ValueError, "humanizer_reference_unavailable"):
            self.prepare()
        self.assertFalse(self.run.exists())

    def test_local_humanizer_edits_apply_only_to_new_runs(self):
        skill = self.humanizer_root / "SKILL.md"
        first = skill.read_bytes()
        self.accepted_run()
        revised = first + b"\nLocal editorial guidance for future runs.\n"
        skill.write_bytes(revised)
        self.humanize()
        self.assertEqual((self.run / "protocol/references/humanizer/SKILL.md").read_bytes(), first)
        new_run = self.root / "next-run"
        CROSS.prepare(self.inputs, new_run)
        self.assertEqual((new_run / "protocol/references/humanizer/SKILL.md").read_bytes(), revised)
        self.assertFalse((new_run / "protocol/references/humanizer/source.json").exists())
        CROSS.verify(self.run)

    def test_humanizer_tampered_instructions_and_summary_are_detected(self):
        self.accepted_run()
        for name in ("protocol/humanizer-instructions.md", "reading/S001/summary.md"):
            path = self.run / name
            original = path.read_bytes()
            path.write_text("changed")
            with self.assertRaisesRegex(ValueError, "frozen_file_changed"):
                CROSS.issue_call(self.run, "humanize")
            path.write_bytes(original)

    def test_humanizer_protects_fields_and_stops_failed_run(self):
        self.accepted_run()
        CROSS.issue_call(self.run, "humanize")
        CROSS.record_worker(self.run, "humanizer-test-worker", "humanize")
        CROSS.write(self.run / "humanize/completion.json", {"status": "complete", "readingComplete": True})
        for text in ("", MARKDOWN.replace("Type: agent", "Type: user-agent"),
                     MARKDOWN.replace("S001:L002, S002:L002", "S002:L002, S001:L002"),
                     MARKDOWN.replace("S001:L002, S002:L002", "S001:L002,S002:L002"),
                     MARKDOWN + MARKDOWN.replace("# C001", "# C002")):
            (self.run / "humanize/cross_session_insights.md").write_text(text)
            with self.assertRaisesRegex(ValueError, "humanizer_changed"):
                CROSS.check(self.run, "humanize")
        with self.assertRaisesRegex(ValueError, "humanizer_changed"):
            CROSS.accept(self.run, "humanizer-test-worker", "complete", "humanize")
        self.assertEqual(CROSS.load(self.run / "state.json")["status"], "failed")
        self.assertNotIn("finalOutputs", CROSS.load(self.run / "state.json"))
        self.assertEqual((self.run / "cross_session_insights.md").read_text(), MARKDOWN)

    def test_humanizer_requires_synthesis_and_no_duplicate_dispatch(self):
        self.start_worker()
        with self.assertRaisesRegex(ValueError, "humanize_dispatch_unavailable"):
            CROSS.issue_call(self.run, "humanize")
        self.read_all()
        self.write_outputs()
        self.accept()
        CROSS.issue_call(self.run, "humanize")
        with self.assertRaisesRegex(ValueError, "humanize_dispatch_unavailable"):
            CROSS.issue_call(self.run, "humanize")
        CROSS.record_worker(self.run, "failed-worker", "humanize")
        with self.assertRaisesRegex(ValueError, "worker_failed"):
            CROSS.accept(self.run, "failed-worker", "failed", "humanize")
        self.assertEqual(CROSS.load(self.run / "state.json")["status"], "failed")

    def test_humanizer_accepts_empty_and_keeps_summary_only_index(self):
        self.accepted_run(empty=True)
        self.assertEqual(self.humanize()["candidateCount"], 0)
        index = CROSS.load(self.run / "humanize-summary-index.json")
        self.assertEqual(len(index["files"]), 2)
        self.assertTrue(all(item["path"].endswith("/summary.md") for item in index["files"]))

    def test_humanizer_frozen_cli_dispatch_record_check_accept(self):
        self.accepted_run()
        for command, extra in (("call", []), ("record-worker", ["--worker-id", "cli-humanizer"])):
            proc = subprocess.run([sys.executable, str(SCRIPT), command, str(self.run), "--stage", "humanize", *extra],
                                  capture_output=True, text=True)
            self.assertEqual(proc.returncode, 0, proc.stderr)
        (self.run / "humanize/cross_session_insights.md").write_text(MARKDOWN)
        CROSS.write(self.run / "humanize/completion.json", {"status": "complete", "readingComplete": True})
        for command, extra in (("check", []), ("accept", ["--worker-id", "cli-humanizer", "--worker-status", "complete"])):
            proc = subprocess.run([sys.executable, str(SCRIPT), command, str(self.run), "--stage", "humanize", *extra],
                                  capture_output=True, text=True)
            self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(CROSS.load(self.run / "state.json")["status"], "accepted")

    def test_legacy_config_completes_without_humanizer(self):
        self.start_worker()
        config = CROSS.load(self.run / "config.json")
        config.pop("stageOrder")
        CROSS.write(self.run / "config.json", config, replace=True)
        manifest = CROSS.load(self.run / "manifest.json")
        manifest["config"] = config
        manifest["frozenHashes"]["config.json"] = CROSS.digest((self.run / "config.json").read_bytes())
        CROSS.write(self.run / "manifest.json", manifest, replace=True)
        self.read_all()
        self.write_outputs()
        self.assertEqual(self.accept()["runStatus"], "accepted")
        with self.assertRaisesRegex(ValueError, "humanize_dispatch_unavailable"):
            CROSS.issue_call(self.run, "humanize")

    def test_prepare_freezes_actual_export_bytes_and_preserves_sources(self):
        (self.inputs / "export-note.txt").write_bytes(b"ancillary export bytes\x00")
        before = snapshot(self.inputs)
        result = self.prepare()
        self.assertEqual(result["status"], "prepared")
        self.assertEqual(result["counts"], {"trajectories": 2, "accepted": 4, "declined": 2})
        manifest = CROSS.load(self.run / "manifest.json")
        self.assertEqual(set(manifest["inputHashes"]), set(before))
        for name, raw in before.items():
            self.assertEqual(manifest["inputHashes"][name], hashlib.sha256(raw).hexdigest())
            self.assertEqual((self.run / "inputs" / name).read_bytes(), raw)
        self.assertNotEqual(manifest["inputHashes"]["a/summary.md"], "f" * 64)
        self.assertEqual(snapshot(self.inputs), before)
        self.assertEqual(stat.S_IMODE(self.run.stat().st_mode), 0o700)
        for path in self.run.rglob("*"):
            if path.is_file():
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertTrue(CROSS.verify(self.run, check_originals=True)["originalsChecked"])

    def test_frozen_prompts_settings_and_dispatch_are_exact(self):
        self.prepare()
        for folder in ("scripts", "references", "agents"):
            for source in (self.live_skill / folder).iterdir():
                if source.is_file() and source.suffix in (".py", ".md", ".json", ".yaml"):
                    self.assertEqual((self.run / "protocol" / folder / source.name).read_bytes(),
                                     source.read_bytes())
        settings = CROSS.load(self.run / "config.json")
        self.assertEqual(settings, {
            "model": "gpt-6.1-sol", "reasoning_effort": "high", "fork_turns": "none",
            "format": "oxygen-cross-session-candidates/v2", "privacyStatus": "private-awaiting-review",
            "stageOrder": ["synthesis", "humanize"],
        })
        dispatch = CROSS.load(self.run / "dispatch.json")
        self.assertEqual({key: dispatch[key] for key in ("model", "reasoning_effort", "fork_turns")},
                         {key: settings[key] for key in ("model", "reasoning_effort", "fork_turns")})
        self.assertEqual(set(dispatch), {"task_name", "model", "reasoning_effort", "fork_turns", "message"})
        prompt = (self.run / "protocol/worker-prompt.md").read_text()
        frozen_worker = (self.run / "protocol/references/synthesis-worker.md").read_text()
        self.assertTrue(prompt.startswith(frozen_worker + "\n\n## This run\n\n"))
        runtime = json.loads(prompt.split("\n\n## This run\n\n", 1)[1])
        self.assertEqual(runtime["runDirectory"], str(self.run))
        self.assertEqual(runtime["index"], str(self.run / "reading/index.json"))
        self.assertTrue(Path(runtime["formatInstructions"]).is_file())
        self.assertTrue(Path(runtime["skillCreatorGuidance"]).is_file())
        self.assertEqual(Path(runtime["categoryInstructions"]),
                         self.run / "protocol/references/insight_categories.md")
        self.assertEqual(Path(runtime["categoryInstructions"]).read_bytes(),
                         self.category_reference.read_bytes())
        self.assertEqual(runtime["readCommand"], [
            sys.executable, str(self.run / "protocol/scripts/cross_session.py"),
            "read", str(self.run), "--file", "PATH_FROM_INDEX", "--start", "BYTE_OFFSET",
            "--limit", "BYTE_COUNT",
        ])
        self.assertIn(str(self.run / "protocol/worker-prompt.md"), dispatch["message"])

    def test_category_reference_is_frozen_and_live_changes_do_not_affect_run(self):
        self.prepare()
        frozen = self.run / "protocol/references/insight_categories.md"
        original = self.category_reference.read_bytes()
        manifest = CROSS.load(self.run / "manifest.json")
        self.assertEqual(manifest["frozenHashes"]["protocol/references/insight_categories.md"],
                         hashlib.sha256(original).hexdigest())
        self.category_reference.unlink()
        CROSS.issue_call(self.run)
        CROSS.verify(self.run)
        self.assertEqual(frozen.read_bytes(), original)

    def test_modified_frozen_categories_fail_verification(self):
        self.prepare()
        (self.run / "protocol/references/insight_categories.md").write_text("Changed criteria\n")
        with self.assertRaisesRegex(ValueError, "frozen_file_changed"):
            CROSS.verify(self.run)

    def test_missing_or_invalid_categories_fail_before_run_creation(self):
        for data in (None, b"", b"\xff"):
            with self.subTest(data=data):
                if data is None:
                    self.category_reference.unlink(missing_ok=True)
                else:
                    self.category_reference.write_bytes(data)
                with self.assertRaisesRegex(ValueError, "category_reference_unavailable"):
                    self.prepare()
                self.assertFalse(self.run.exists())

    def test_insufficient_distinct_trajectories_is_rejected_before_creating_run(self):
        single = self.root / "single"
        FIXTURES.write_export(single)
        with self.assertRaisesRegex(ValueError, "insufficient_distinct_trajectories"):
            CROSS.prepare(single, self.run)
        self.assertFalse(self.run.exists())

    def test_existing_run_and_run_inside_input_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "run_inside_input"):
            CROSS.prepare(self.inputs, self.inputs / "nested-run")
        self.prepare()
        before = snapshot(self.run)
        with self.assertRaisesRegex(ValueError, "run_exists"):
            self.prepare()
        self.assertEqual(snapshot(self.run), before)

    def test_input_change_between_normalization_and_freeze_is_detected(self):
        normalize = CROSS.normalize_export

        def mutate_after_normalize(path):
            result = normalize(path)
            if Path(path) == self.inputs:
                (self.inputs / "a/summary.md").write_bytes(b"changed after validation")
            return result

        with mock.patch.object(CROSS, "normalize_export", side_effect=mutate_after_normalize):
            with self.assertRaisesRegex(ValueError, "input_changed_during_freeze"):
                self.prepare()
        self.assertEqual(CROSS.load(self.run / "preparation_failure.json")["status"], "failed")
        self.assertFalse((self.run / "state.json").exists())

    def test_dispatch_and_record_worker_are_each_issued_once(self):
        self.prepare()
        with self.assertRaisesRegex(ValueError, "worker_not_recordable"):
            CROSS.record_worker(self.run, "too-early")
        self.assertEqual(CROSS.issue_call(self.run), CROSS.load(self.run / "dispatch.json"))
        with self.assertRaisesRegex(ValueError, "dispatch_already_issued"):
            CROSS.issue_call(self.run)
        with self.assertRaisesRegex(ValueError, "empty_worker_id"):
            CROSS.record_worker(self.run, "  ")
        self.assertEqual(CROSS.load(self.run / "state.json")["status"], "dispatched")
        state = CROSS.record_worker(self.run, "dummy-worker")
        self.assertEqual((state["status"], state["workerId"]), ("running", "dummy-worker"))
        record = CROSS.load(self.run / "worker_record.json")
        self.assertEqual(record["workerId"], "dummy-worker")
        self.assertEqual(record["dispatchSha256"], CROSS.digest((self.run / "dispatch.json").read_bytes()))
        with self.assertRaisesRegex(ValueError, "worker_not_recordable"):
            CROSS.record_worker(self.run, "replacement-worker")
        with self.assertRaisesRegex(ValueError, "dispatch_already_issued"):
            CROSS.issue_call(self.run)

    def test_lock_prevents_second_operation_without_changing_state(self):
        self.prepare()
        before = (self.run / "state.json").read_bytes()
        (self.run / ".operation-lock").write_text("other-operation")
        with self.assertRaisesRegex(ValueError, "run_locked"):
            CROSS.issue_call(self.run)
        self.assertEqual((self.run / "state.json").read_bytes(), before)
        self.assertEqual((self.run / ".operation-lock").read_text(), "other-operation")

    def test_accept_requires_running_recorded_worker_and_does_not_consume_wrong_id(self):
        self.prepare()
        with self.assertRaisesRegex(ValueError, "worker_state_mismatch"):
            CROSS.accept(self.run, "dummy-worker", "complete")
        CROSS.issue_call(self.run)
        CROSS.record_worker(self.run, "dummy-worker")
        with self.assertRaisesRegex(ValueError, "worker_state_mismatch"):
            CROSS.accept(self.run, "different-worker", "complete")
        self.assertEqual(CROSS.load(self.run / "state.json")["status"], "running")
        self.assertFalse((self.run / "completion_attestation.json").exists())

    def test_failed_worker_is_recorded_and_never_accepted_or_redispatched(self):
        self.start_worker()
        self.read_all()
        self.write_outputs()
        with self.assertRaisesRegex(ValueError, "worker_failed"):
            CROSS.accept(self.run, "test-worker-no-model-launched", "failed")
        self.assertEqual(CROSS.load(self.run / "state.json")["status"], "failed")
        self.assertEqual(CROSS.load(self.run / "validation.json")["status"], "failed")
        self.assertEqual(CROSS.load(self.run / "completion_attestation.json")["status"], "failed")
        self.assertFalse((self.run / "cross_session_insights.json").exists())
        with self.assertRaisesRegex(ValueError, "dispatch_already_issued"):
            CROSS.issue_call(self.run)
        with self.assertRaisesRegex(ValueError, "worker_state_mismatch"):
            self.accept()

    def test_unicode_bounded_reads_reconstruct_every_byte_without_split_codepoints(self):
        self.reviews[0]["current"]["summaryLines"][1]["text"] = "café 🙂 漢字 " * 12
        FIXTURES.write_export(self.inputs / "a", self.reviews[0])
        self.prepare()
        name = "reading/S001/summary.md"
        expected = (self.run / name).read_bytes()
        chunks, cursor = [], 0
        while cursor < len(expected):
            receipt, content = CROSS.read_chunk(self.run, name, cursor, 7)
            self.assertEqual(receipt["start"], cursor)
            self.assertGreater(receipt["end"], cursor)
            self.assertLessEqual(receipt["end"] - cursor, 7)
            self.assertEqual(content.encode(), expected[cursor:receipt["end"]])
            chunks.append(content)
            cursor = receipt["end"]
        self.assertEqual("".join(chunks).encode(), expected)
        receipt, content = CROSS.read_chunk(self.run, name, cursor, 7)
        self.assertEqual(receipt["end"], cursor)
        self.assertEqual(content, "")

    def test_bounded_read_rejects_unindexed_paths_limits_and_invalid_offsets(self):
        self.reviews[0]["current"]["summaryLines"][1]["text"] = "🙂 Unicode"
        FIXTURES.write_export(self.inputs / "a", self.reviews[0])
        self.prepare()
        name = "reading/S001/summary.md"
        raw = (self.run / name).read_bytes()
        for path, start, limit in (("../exports/a/summary.md", 0, 12),
                                   ("inputs/a/summary.md", 0, 12),
                                   (name, 0, -1), (name, 0, 0), (name, 0, 3),
                                   (name, 0, True), (name, 0, 4.5), (name, 0, "500000"),
                                   (name, -1, 12), (name, len(raw) + 1, 12),
                                   (name, raw.index("🙂".encode()) + 1, 12)):
            with self.subTest(path=path, start=start, limit=limit), self.assertRaises(ValueError):
                CROSS.read_chunk(self.run, path, start, limit)
        self.assertFalse((self.run / "read_receipts.json").exists())

    def test_read_chunk_requires_an_explicit_byte_limit(self):
        self.prepare()
        with self.assertRaises(TypeError):
            CROSS.read_chunk(self.run, "reading/S001/summary.md", 0)
        self.assertFalse((self.run / "read_receipts.json").exists())

    def test_megabyte_utf8_summary_reconstructs_with_half_megabyte_reads(self):
        self.reviews[0]["current"]["summaryLines"][1]["text"] = "café 🙂 漢字 " * 60000
        FIXTURES.write_export(self.inputs / "a", self.reviews[0])
        self.prepare()
        name = "reading/S001/summary.md"
        expected = (self.run / name).read_bytes()
        self.assertGreater(len(expected), 1_000_000)
        self.assertLess(len(expected), 1_100_000)
        chunks, receipts, cursor = [], [], 0
        while cursor < len(expected):
            receipt, content = CROSS.read_chunk(self.run, name, cursor, 500_000)
            self.assertEqual(receipt["path"], name)
            self.assertEqual(receipt["start"], cursor)
            self.assertGreater(receipt["end"], cursor)
            self.assertLessEqual(receipt["end"] - cursor, 500_000)
            self.assertEqual(receipt["totalBytes"], len(expected))
            self.assertEqual(receipt["sha256"], hashlib.sha256(expected).hexdigest())
            self.assertEqual(content.encode("utf-8"), expected[cursor:receipt["end"]])
            chunks.append(content)
            receipts.append(receipt)
            cursor = receipt["end"]
        self.assertEqual(len(receipts), 3)
        self.assertEqual("".join(chunks).encode("utf-8"), expected)
        self.assertEqual(CROSS.load(self.run / "read_receipts.json"), receipts)
        for other, item in CROSS.reading_files(self.run).items():
            if other != name:
                CROSS.read_chunk(self.run, other, 0, max(4, item["bytes"]))
        self.assertTrue(all(item["complete"] for item in CROSS.reading_coverage(self.run)))

    def test_cli_reads_a_file_larger_than_sixteen_kilobytes_in_one_request(self):
        self.reviews[0]["current"]["summaryLines"][1]["text"] = "café 🙂 漢字 " * 2000
        FIXTURES.write_export(self.inputs / "a", self.reviews[0])
        self.prepare()
        name = "reading/S001/summary.md"
        expected = (self.run / name).read_bytes()
        self.assertGreater(len(expected), 16000)
        completed = subprocess.run([
            sys.executable, str(SCRIPT), "read", str(self.run), "--file", name,
            "--start", "0", "--limit", str(len(expected)),
        ], capture_output=True, check=False)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        receipt_line, displayed = completed.stdout.split(b"\n", 1)
        receipt = json.loads(receipt_line)
        self.assertEqual((receipt["start"], receipt["end"], receipt["totalBytes"]),
                         (0, len(expected), len(expected)))
        self.assertEqual(receipt["sha256"], hashlib.sha256(expected).hexdigest())
        self.assertEqual(displayed, expected +
                         f"\n[End of displayed chunk. Next byte offset: {len(expected)}]\n".encode())
        self.assertEqual(CROSS.load(self.run / "read_receipts.json"), [receipt])

    def test_cli_chunk_boundary_reports_exact_next_byte_offset(self):
        self.reviews[0]["current"]["summaryLines"][1]["text"] = "x" * 20000 + "🙂" + "y" * 20000
        FIXTURES.write_export(self.inputs / "a", self.reviews[0])
        self.prepare()
        name = "reading/S001/summary.md"
        expected = (self.run / name).read_bytes()
        emoji_start = expected.index("🙂".encode("utf-8"))
        cursor, chunks, receipts = 0, [], []
        for limit, expected_end in ((emoji_start + 2, emoji_start),
                                    (len(expected) - emoji_start, len(expected))):
            completed = subprocess.run([
                sys.executable, str(SCRIPT), "read", str(self.run), "--file", name,
                "--start", str(cursor), "--limit", str(limit),
            ], capture_output=True, check=False)
            self.assertEqual(completed.returncode, 0, completed.stderr)
            receipt_line, displayed = completed.stdout.split(b"\n", 1)
            receipt = json.loads(receipt_line)
            self.assertEqual((receipt["start"], receipt["end"]), (cursor, expected_end))
            self.assertEqual(receipt["totalBytes"], len(expected))
            marker = f"\n[End of displayed chunk. Next byte offset: {expected_end}]\n".encode()
            self.assertEqual(displayed, expected[cursor:expected_end] + marker)
            chunks.append(displayed[:-len(marker)].decode("utf-8"))
            receipts.append(receipt)
            cursor = receipt["end"]
        self.assertEqual("".join(chunks).encode("utf-8"), expected)
        self.assertEqual(CROSS.load(self.run / "read_receipts.json"), receipts)

    def test_cli_read_without_limit_is_rejected_before_recording_a_receipt(self):
        self.prepare()
        completed = subprocess.run([
            sys.executable, str(SCRIPT), "read", str(self.run),
            "--file", "reading/S001/summary.md", "--start", "0",
        ], capture_output=True, text=True, check=False)
        self.assertEqual(completed.returncode, 1)
        self.assertIn("read_limit_required", completed.stderr)
        self.assertIn("--limit", completed.stderr)
        self.assertEqual(completed.stdout, "")
        self.assertFalse((self.run / "read_receipts.json").exists())

    def test_reading_coverage_rejects_skipped_bytes_until_gap_is_filled(self):
        self.reviews[0]["current"]["summaryLines"][1]["text"] = "A long summary: " + "x" * 40000
        FIXTURES.write_export(self.inputs / "a", self.reviews[0])
        self.prepare()
        name = "reading/S001/summary.md"
        first, _ = CROSS.read_chunk(self.run, name, 0, 20000)
        CROSS.read_chunk(self.run, name, first["end"] + 4, 40000)
        for other, item in CROSS.reading_files(self.run).items():
            if other != name:
                CROSS.read_chunk(self.run, other, 0, max(4, item["bytes"]))
        with self.assertRaisesRegex(ValueError, "incomplete_reading"):
            CROSS.reading_coverage(self.run)
        CROSS.read_chunk(self.run, name, first["end"], 4)
        self.assertEqual(len(CROSS.reading_coverage(self.run)), 4)

    def test_overlapping_and_out_of_order_receipts_cover_a_file(self):
        self.prepare()
        name = "reading/S001/summary.md"
        CROSS.read_chunk(self.run, name, 12, 16000)
        CROSS.read_chunk(self.run, name, 0, 16)
        CROSS.read_chunk(self.run, name, 0, 16)
        for other in CROSS.reading_files(self.run):
            if other != name:
                CROSS.read_chunk(self.run, other, 0, 16000)
        self.assertTrue(all(item["complete"] for item in CROSS.reading_coverage(self.run)))

    def test_receipts_reject_wrong_hash_size_and_invalid_ranges(self):
        self.prepare()
        self.read_all()
        original = CROSS.load(self.run / "read_receipts.json")
        for change in ({"sha256": "0" * 64}, {"totalBytes": 0}, {"start": True},
                       {"start": -1}, {"end": 1000000}, {"start": 20, "end": 10}):
            with self.subTest(change=change):
                receipts = copy.deepcopy(original)
                receipts[0].update(change)
                CROSS.write(self.run / "read_receipts.json", receipts, replace=True)
                with self.assertRaises(ValueError):
                    CROSS.reading_coverage(self.run)

    def test_complete_flag_cannot_substitute_for_full_reading(self):
        self.start_worker()
        self.write_outputs()
        name = next(iter(CROSS.reading_files(self.run)))
        CROSS.read_chunk(self.run, name, 0, 4)
        with self.assertRaisesRegex(ValueError, "incomplete_reading"):
            self.accept()
        self.assertEqual(CROSS.load(self.run / "state.json")["status"], "failed")
        self.assertFalse((self.run / "cross_session_insights.json").exists())

    def test_incomplete_attestation_fails_even_after_every_file_was_read(self):
        self.start_worker()
        self.read_all()
        self.write_outputs(completion={"status": "complete", "readingComplete": False})
        with self.assertRaisesRegex(ValueError, "worker_reading_incomplete"):
            self.accept()
        self.assertEqual(CROSS.load(self.run / "state.json")["status"], "failed")

    def test_success_keeps_candidate_drafts_and_original_source_decisions(self):
        before = snapshot(self.inputs)
        validation = self.accepted_run()
        result = CROSS.load(self.run / "cross_session_insights.json")
        self.assertEqual(result["format"], "oxygen-cross-session-candidates/v2")
        self.assertEqual((result["status"], result["privacyStatus"]),
                         ("draft", "private-awaiting-review"))
        candidate = result["candidates"][0]
        self.assertEqual(candidate["status"], "draft")
        self.assertEqual(candidate["evidence"], ["S001:L002", "S002:L002"])
        self.assertEqual(set(candidate), {
            "id", "title", "type", "description", "workflow", "example", "evidence", "status",
        })
        accepted = next(card for card in result["sources"][0]["cards"] if card["id"] == "I003")
        rejected = next(card for card in result["sources"][0]["cards"] if card["id"] == "I002")
        self.assertEqual((accepted["currentId"], accepted["originalId"], accepted["acceptedExportId"]),
                         ("I003", "I006", "I002"))
        self.assertEqual(accepted["decision"], "accepted")
        self.assertEqual(rejected["decision"], "rejected")
        self.assertIsNone(rejected["acceptedExportId"])
        self.assertIsNone(rejected["rejectionReason"])
        self.assertFalse((self.run / "candidate_provenance.json").exists())
        self.assertNotIn("origin_mappings", validation["checks"])
        self.assertNotIn("declined_reuse", validation["checks"])
        self.assertEqual(result["sources"], CROSS.load(self.run / "corpus.json")["sources"])
        self.assertEqual(validation["candidateCount"], 1)
        self.assertEqual(len(validation["coverage"]), 4)
        self.assertEqual(CROSS.load(self.run / "state.json")["status"], "extracted")
        self.assertEqual(snapshot(self.inputs), before)
        self.assertEqual(CROSS.verify(self.run, check_originals=True)["status"], "verified")
        with self.assertRaisesRegex(ValueError, "worker_state_mismatch"):
            self.accept()

    def test_empty_candidate_set_is_a_valid_completed_draft(self):
        validation = self.accepted_run(empty=True)
        result = CROSS.load(self.run / "cross_session_insights.json")
        self.assertEqual(validation["candidateCount"], 0)
        self.assertEqual(result["candidates"], [])
        self.assertFalse((self.run / "candidate_provenance.json").exists())
        self.assertFalse((self.run / "synthesis_report.md").exists())
        self.assertEqual(result["status"], "draft")
        self.assertEqual(result["privacyStatus"], "private-awaiting-review")

    def test_cli_checks_and_accepts_drafts_without_a_sidecar_or_report(self):
        self.start_worker()
        self.read_all()
        self.write_outputs()
        for command in (
            ["check", str(self.run)],
            ["accept", str(self.run), "--worker-id", "test-worker-no-model-launched",
             "--worker-status", "complete"],
            ["verify", str(self.run), "--check-originals"],
        ):
            completed = subprocess.run([sys.executable, str(SCRIPT), *command],
                                       capture_output=True, text=True, check=False)
            self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertFalse((self.run / "candidate_provenance.json").exists())
        self.assertFalse((self.run / "synthesis_report.md").exists())
        output_hashes = CROSS.load(self.run / "state.json")["outputHashes"]
        self.assertNotIn("candidate_provenance.json", output_hashes)
        self.assertNotIn("synthesis_report.md", output_hashes)
        result = CROSS.load(self.run / "cross_session_insights.json")
        self.assertEqual(result["format"], "oxygen-cross-session-candidates/v2")
        self.assertEqual(result["candidates"][0]["evidence"], ["S001:L002", "S002:L002"])

    def test_live_cli_preserves_a_frozen_sidecar_requirement(self):
        # Simulate an earlier output contract without depending on real run files.
        helper = self.live_skill / "scripts/cross_session.py"
        legacy = helper.read_text().replace(
            'FORMAT = "oxygen-cross-session-candidates/v2"',
            'FORMAT = "oxygen-cross-session-candidates/v1"',
        ).replace(
            'OUTPUTS = ("cross_session_insights.md",',
            'OUTPUTS = ("candidate_provenance.json", "cross_session_insights.md",',
        ).replace(
            'def check(run, stage="synthesis"):\n    verify(run)',
            'def check(run, stage="synthesis"):\n    verify(run)\n    load(run / "candidate_provenance.json")',
        )
        helper.write_text(legacy)
        with mock.patch.object(CROSS, "FORMAT", "oxygen-cross-session-candidates/v1"):
            self.start_worker()
        self.read_all()
        self.write_outputs()
        frozen_before = snapshot(self.run / "protocol")
        checked = subprocess.run([sys.executable, str(SCRIPT), "check", str(self.run)],
                                 capture_output=True, text=True, check=False)
        self.assertEqual(checked.returncode, 1)
        self.assertIn("candidate_provenance.json", checked.stderr)
        CROSS.write(self.run / "candidate_provenance.json", {"candidates": []})
        accepted = subprocess.run([
            sys.executable, str(SCRIPT), "accept", str(self.run), "--worker-id",
            "test-worker-no-model-launched", "--worker-status", "complete",
        ], capture_output=True, text=True, check=False)
        self.assertEqual(accepted.returncode, 0, accepted.stderr)
        self.assertEqual(json.loads(accepted.stdout)["format"], "oxygen-cross-session-candidates/v1")
        self.assertIn("candidate_provenance.json", CROSS.load(self.run / "state.json")["outputHashes"])
        self.assertEqual(snapshot(self.run / "protocol"), frozen_before)
        (self.run / "candidate_provenance.json").write_text("changed")
        verified = subprocess.run([sys.executable, str(SCRIPT), "verify", str(self.run)],
                                  capture_output=True, text=True, check=False)
        self.assertEqual(verified.returncode, 1)
        self.assertIn("accepted_output_changed: candidate_provenance.json", verified.stderr)

    def test_invalid_candidate_content_marks_acceptance_failed(self):
        self.start_worker()
        self.read_all()
        self.write_outputs()
        (self.run / "cross_session_insights.md").write_text(
            MARKDOWN.replace("S001:L002, S002:L002", "S001:L002"))
        with self.assertRaisesRegex(ValueError, "insufficient_distinct_trajectories"):
            self.accept()
        self.assertEqual(CROSS.load(self.run / "validation.json")["status"], "failed")
        self.assertEqual(CROSS.load(self.run / "state.json")["status"], "failed")

    def test_live_cli_preserves_a_frozen_report_requirement(self):
        # Earlier runs keep their report requirement through the frozen helper.
        helper = self.live_skill / "scripts/cross_session.py"
        legacy = helper.read_text().replace(
            'OUTPUTS = ("cross_session_insights.md",',
            'OUTPUTS = ("synthesis_report.md", "cross_session_insights.md",',
        ).replace(
            'def check(run, stage="synthesis"):\n    verify(run)',
            'def check(run, stage="synthesis"):\n    verify(run)\n'
            '    if not regular(run / "synthesis_report.md").decode("utf-8").strip():\n'
            '        raise ValueError("empty_synthesis_report")',
        )
        helper.write_text(legacy)
        self.start_worker()
        self.read_all()
        self.write_outputs()
        for contents, error in ((None, "not_regular_file"), (" \n", "empty_synthesis_report")):
            if contents is not None:
                (self.run / "synthesis_report.md").write_text(contents)
            checked = subprocess.run([sys.executable, str(SCRIPT), "check", str(self.run)],
                                     capture_output=True, text=True, check=False)
            self.assertEqual(checked.returncode, 1)
            self.assertIn(error, checked.stderr)
        (self.run / "synthesis_report.md").write_text("Historical synthesis report.\n")
        accepted = subprocess.run([
            sys.executable, str(SCRIPT), "accept", str(self.run), "--worker-id",
            "test-worker-no-model-launched", "--worker-status", "complete",
        ], capture_output=True, text=True, check=False)
        self.assertEqual(accepted.returncode, 0, accepted.stderr)
        self.assertIn("synthesis_report.md", CROSS.load(self.run / "state.json")["outputHashes"])

    def test_original_export_changes_do_not_replace_frozen_evidence(self):
        self.prepare()
        frozen_before = snapshot(self.run / "inputs")
        (self.inputs / "new-ancillary-file.txt").write_text("added after freezing")
        self.assertEqual(CROSS.verify(self.run)["status"], "verified")
        with self.assertRaisesRegex(ValueError, "original_exports_changed"):
            CROSS.verify(self.run, check_originals=True)
        self.assertEqual(snapshot(self.run / "inputs"), frozen_before)

    def test_tampered_frozen_inputs_prompts_and_dispatch_are_detected(self):
        self.prepare()
        for name in ("inputs/a/summary_labeled.md", "reading/S001/cards.json",
                     "protocol/references/synthesis-worker.md", "protocol/scripts/cross_cards.py",
                     "dispatch.json", "config.json"):
            with self.subTest(name=name):
                path = self.run / name
                original = path.read_bytes()
                path.write_bytes(original + b"\nchanged")
                with self.assertRaisesRegex(ValueError, "frozen_file_changed"):
                    CROSS.verify(self.run)
                path.write_bytes(original)

    def test_symlink_replacement_of_frozen_file_is_rejected(self):
        self.prepare()
        name = self.run / "reading/S001/summary.md"
        target = self.root / "external-summary.md"
        target.write_bytes(name.read_bytes())
        name.unlink()
        name.symlink_to(target)
        with self.assertRaisesRegex(ValueError, "symlink_in_run"):
            CROSS.verify(self.run)

    def test_tampering_with_accepted_outputs_is_detected(self):
        self.accepted_run()
        for name in ("cross_session_insights.md", "cross_session_insights.json", "validation.json",
                     "read_receipts.json", "worker_record.json", "completion_attestation.json"):
            with self.subTest(name=name):
                path = self.run / name
                original = path.read_bytes()
                path.write_bytes(original + b"\nchanged")
                with self.assertRaisesRegex(ValueError, "accepted_output_changed"):
                    CROSS.verify(self.run)
                path.write_bytes(original)

    def test_reading_accepted_run_does_not_mutate_accepted_receipts(self):
        self.accepted_run()
        before = (self.run / "read_receipts.json").read_bytes()
        try:
            CROSS.read_chunk(self.run, "reading/S001/summary.md", 0, 16)
        except ValueError:
            pass  # Rejecting the read or serving it without a new receipt are both safe.
        self.assertEqual((self.run / "read_receipts.json").read_bytes(), before)
        self.assertEqual(CROSS.verify(self.run)["status"], "verified")

    def test_resume_uses_frozen_helper_and_dispatch_after_live_protocol_changes(self):
        self.prepare()
        frozen_prompt = (self.run / "protocol/worker-prompt.md").read_bytes()
        live_helper = self.live_skill / "scripts/cross_session.py"
        live_helper.write_text(live_helper.read_text().replace(
            'MODEL = "gpt-6.1-sol"', 'MODEL = "changed-live-model"'))
        (self.live_skill / "references/synthesis-worker.md").write_text("Changed live instructions")
        (self.live_skill / "references/candidate-format.md").write_text("Changed live format")
        completed = subprocess.run([sys.executable, str(live_helper), "call", str(self.run)],
                                   capture_output=True, text=True, check=False)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(json.loads(completed.stdout), CROSS.load(self.run / "dispatch.json"))
        self.assertEqual(json.loads(completed.stdout)["model"], "gpt-6.1-sol")
        self.assertEqual((self.run / "protocol/worker-prompt.md").read_bytes(), frozen_prompt)
        self.assertEqual(CROSS.load(self.run / "state.json")["status"], "dispatched")

    def test_live_cli_preserves_an_older_frozen_readers_default_limit(self):
        # Build a synthetic old helper before freezing, without opening historical runs.
        old_helper = self.live_skill / "scripts/cross_session.py"
        old_source = old_helper.read_text()
        limit_argument = 'cmd.add_argument("--limit", type=int,'
        self.assertEqual(old_source.count(limit_argument), 1)
        old_helper.write_text(old_source.replace(
            limit_argument, 'cmd.add_argument("--limit", type=int, default=12000,'))
        self.reviews[0]["current"]["summaryLines"][1]["text"] = "x" * 17000
        FIXTURES.write_export(self.inputs / "a", self.reviews[0])
        self.prepare()
        frozen_before = snapshot(self.run / "protocol")
        name = "reading/S001/summary.md"
        completed = subprocess.run([
            sys.executable, str(SCRIPT), "read", str(self.run), "--file", name, "--start", "0",
        ], capture_output=True, check=False)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        receipt_line, displayed = completed.stdout.split(b"\n", 1)
        receipt = json.loads(receipt_line)
        self.assertEqual((receipt["start"], receipt["end"]), (0, 12000))
        self.assertEqual(displayed, (self.run / name).read_bytes()[:12000] +
                         b"\n[End of displayed chunk. Next byte offset: 12000]\n")
        self.assertEqual(snapshot(self.run / "protocol"), frozen_before)
        self.assertEqual(CROSS.verify(self.run)["status"], "verified")

    def test_cli_refuses_modified_frozen_helper_before_executing_it(self):
        self.prepare()
        helper = self.run / "protocol/scripts/cross_session.py"
        helper.write_text("raise RuntimeError('tampered helper executed')\n")
        completed = subprocess.run([sys.executable, str(SCRIPT), "verify", str(self.run)],
                                   capture_output=True, text=True, check=False)
        self.assertEqual(completed.returncode, 1)
        self.assertIn("frozen_file_changed", completed.stderr)
        self.assertNotIn("tampered helper executed", completed.stderr)


if __name__ == "__main__":
    unittest.main()
