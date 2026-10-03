import asyncio
import importlib.util
import json
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "trajectory_agents.py"
SPEC = importlib.util.spec_from_file_location("trajectory_agents", SCRIPT)
RUN = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUN)

SUMMARY = (
    "# Overview\n\nThe team agreed to verify a reported result.\n\n"
    "# Detailed summary\n\n## Purpose\n\n- User requested a check.\n\n"
    "## Decision and unresolved work\n\nAgent reported success; independent verification remained pending.\n"
)
INSIGHTS = """# I001

Title: Verify reported results
Type: agent
Description: When relying on an agent-reported result whose independent verification remains pending.
Workflow: Check independent evidence before relying on a reported result.
Example: The user requested a check. The agent reported success while independent verification remained pending.
Evidence: L009, L013
"""
SHORT_INSIGHTS = INSIGHTS.replace("Evidence: L009, L013", "Evidence: L009")
EXAMPLE = (
    "**Verify the reported result:** Check the evidence before relying on the agent's report. "
    "Keep the distinction between a claim and a verified outcome explicit.\n\n"
    "**Preserve qualifications:** Independent verification is still pending; this is a proposal, "
    "not a proven check. Preserve café metrics and inline notation such as `status: pending`."
)
PARAGRAPH_INSIGHTS = INSIGHTS.replace(
    INSIGHTS.split("Example: ", 1)[1].split("\nEvidence:", 1)[0],
    "\n\n" + EXAMPLE + "\n",
).replace("Example: \n", "Example:\n")


class TrajectoryAgentsTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = self.root / "input.jsonl"
        self.original = b'{"type":"session_meta","payload":{"id":"synthetic"}}\n'
        self.source.write_bytes(self.original)
        _, self.run = RUN.paths(self.source)

    def accept(self, source, stage):
        _, run = RUN.paths(source)
        state = json.loads((run / "manifest.json").read_bytes())["stages"].get(stage, {})
        worker_id = "test-" + stage
        if state.get("status") in {"issued", "complete"} and not state.get("origin"):
            RUN.record_worker(source, stage, worker_id)
        return RUN.accept(source, stage, worker_id=worker_id, worker_status="complete")

    def write_summary(self, summary=SUMMARY):
        (self.run / "summary" / "summary.md").write_text(summary)

    def finish_summary(self):
        RUN.prepare(self.source)
        RUN.issue_call(self.source, "summary")
        self.write_summary()
        return self.accept(self.source, "summary")

    def finish_insight(self, insights=INSIGHTS):
        self.finish_summary()
        RUN.issue_call(self.source, "insight")
        (self.run / "insight" / "insight.md").write_text(insights)
        return self.accept(self.source, "insight")

    def write_redaction(self, summary=SUMMARY, insights=INSIGHTS):
        directory = self.run / "redaction"
        (directory / "summary_redacted.md").write_text(summary)
        RUN.LABEL.label_file(directory / "summary_redacted.md", directory / "summary_redacted_labeled.md")
        (directory / "insight_redacted.md").write_text(insights)

    def test_only_path_and_derived_task_identity_vary(self):
        for stage in RUN.STAGES:
            first = RUN.call_arguments(stage, self.source)
            second = RUN.call_arguments(stage, self.root / 'spaces "quotes" {braces} $name.md')
            self.assertEqual(first, RUN.call_arguments(stage, self.source))
            prefix_a, data_a = first.pop("message").rsplit("\n", 2)[:2]
            prefix_b, data_b = second.pop("message").rsplit("\n", 2)[:2]
            self.assertEqual(prefix_a, prefix_b)
            self.assertEqual(set(json.loads(data_a)), {"input_path"})
            self.assertEqual(set(json.loads(data_b)), {"input_path"})
            self.assertNotEqual(first.pop("task_name"), second.pop("task_name"))
            self.assertEqual(first, second)
            self.assertEqual(first, {"model": "gpt-6.1-sol", "reasoning_effort": "high", "fork_turns": "none"})

    def test_repository_prompts_are_embedded_verbatim(self):
        for stage, (name, _) in RUN.STAGES.items():
            self.assertIn((RUN.KIT / "prompts" / name).read_bytes(), RUN.fixed_template(stage))
            if stage in {"insight", "redaction"}:
                self.assertIn(RUN.CARD_FORMAT.read_bytes(), RUN.fixed_template(stage))

    def test_paragraph_cards_complete_both_stages_without_companion_files(self):
        self.assertEqual(self.finish_insight(PARAGRAPH_INSIGHTS)["insights"], 1)
        RUN.issue_call(self.source, "redaction")
        self.write_redaction(insights=PARAGRAPH_INSIGHTS)
        self.assertTrue(self.accept(self.source, "redaction")["run_complete"])
        self.assertTrue(RUN.verify_resume(self.source)["run_complete"])
        for stage in ("insight", "redaction"):
            self.assertEqual({p.name for p in (self.run / stage).iterdir()}, set(RUN.STAGES[stage][1]))

    def test_supplied_label_commands_execute_identically_for_both_workers(self):
        source = self.root / 'summary with "quotes".md'
        source.write_text(SUMMARY)
        results = []
        for stage in ("insight", "redaction"):
            template = RUN.fixed_template(stage).decode()
            encoded = template.split("# Label helper command (JSON argv prefix)\n")[1].split("# Per-item input")[0]
            prefix = json.loads(encoded)
            destination = self.root / f"{stage}-labeled.md"
            subprocess.run(prefix + [str(source), str(destination)], check=True, capture_output=True)
            results.append(destination.read_bytes())
        self.assertEqual(results[0], RUN.LABEL.label_bytes(source.read_bytes()))
        self.assertEqual(results[0], results[1])

    def test_insight_revises_working_summary_relabels_and_hands_off_final_trio(self):
        self.finish_summary()
        RUN.issue_call(self.source, "insight")
        directory = self.run / "insight"
        self.assertEqual((directory / "summary.md").read_text(), SUMMARY)
        revised = SUMMARY.replace("\n## Purpose\n\n- User requested a check.\n", "")
        (directory / "summary.md").write_text(revised)
        (directory / "insight.md").write_text(SHORT_INSIGHTS)
        with self.assertRaisesRegex(RUN.RunError, "labeled_summary_mismatch"):
            self.accept(self.source, "insight")
        (directory / "summary_labeled.md").unlink()
        RUN.LABEL.label_file(directory / "summary.md", directory / "summary_labeled.md")
        result = self.accept(self.source, "insight")
        self.assertEqual(result["summary_lines"], 9)
        self.assertEqual((self.run / "summary/summary.md").read_text(), SUMMARY)
        RUN.issue_call(self.source, "redaction")
        self.write_redaction(revised, (directory / "insight.md").read_text())
        self.assertTrue(self.accept(self.source, "redaction")["run_complete"])

    def test_stale_insight_references_after_relabeling_are_rejected(self):
        self.finish_summary()
        RUN.issue_call(self.source, "insight")
        directory = self.run / "insight"
        (directory / "summary.md").write_text(SUMMARY.replace("\n## Purpose\n\n- User requested a check.\n", ""))
        (directory / "summary_labeled.md").unlink()
        RUN.LABEL.label_file(directory / "summary.md", directory / "summary_labeled.md")
        (directory / "insight.md").write_text(INSIGHTS)
        with self.assertRaisesRegex(RUN.RunError, "invalid_evidence_references"):
            self.accept(self.source, "insight")

    def test_resume_detects_changed_final_summary(self):
        self.finish_insight()
        directory = self.run / "insight"
        (directory / "summary.md").write_text(SUMMARY.replace("reported success", "reported failure"))
        with self.assertRaisesRegex(RUN.RunError, "insight_outputs_changed"):
            RUN.verify_resume(self.source)

    def test_insight_does_not_overwrite_existing_output_but_ignores_notes(self):
        self.finish_summary()
        (self.run / "insight/notes.txt").write_text("incidental")
        (self.run / "insight/summary.md").write_text("existing output")
        with self.assertRaises(FileExistsError):
            RUN.issue_call(self.source, "insight")
        self.assertEqual((self.run / "insight/summary.md").read_text(), "existing output")
        (self.run / "insight/summary.md").unlink()
        RUN.issue_call(self.source, "insight")
        (self.run / "insight/insight.md").write_text(INSIGHTS)
        self.accept(self.source, "insight")

    def test_complete_pipeline_labels_before_insights_and_guards_stages(self):
        result = RUN.prepare(self.source)
        self.assertEqual(result["input_bytes"], len(self.original))
        self.assertEqual((self.run / "trajectory.json").read_bytes(), self.original)
        for stage in ("insight", "redaction"):
            with self.assertRaisesRegex(RUN.RunError, "summary_not_complete"):
                RUN.issue_call(self.source, stage)
        call = RUN.issue_call(self.source, "summary")
        self.assertEqual(json.loads((self.run / "summary-call.json").read_bytes()), call)
        with self.assertRaisesRegex(RUN.RunError, "dispatch_already_issued"):
            RUN.issue_call(self.source, "summary")
        with self.assertRaises(FileNotFoundError):
            self.accept(self.source, "summary")
        self.write_summary()
        self.assertFalse((self.run / "summary/summary_labeled.md").exists())
        result = self.accept(self.source, "summary")
        self.assertEqual(result["summary_lines"], 13)
        self.assertEqual(result["evidence_lines"], 3)
        self.assertEqual((self.run / "summary/summary.md").read_text(), SUMMARY)
        self.assertEqual((self.run / "summary/summary_labeled.md").read_bytes(), RUN.LABEL.label_bytes(SUMMARY.encode()))
        with self.assertRaisesRegex(RUN.RunError, "insight_not_complete"):
            RUN.issue_call(self.source, "redaction")
        RUN.issue_call(self.source, "insight")
        (self.run / "insight/insight.md").write_text(INSIGHTS)
        self.assertFalse(self.accept(self.source, "insight")["run_complete"])
        RUN.issue_call(self.source, "redaction")
        self.write_redaction()
        result = self.accept(self.source, "redaction")
        self.assertTrue(result["run_complete"])
        self.assertEqual(result["insights"], 1)
        self.assertEqual(self.accept(self.source, "redaction"), result)
        self.assertEqual(self.source.read_bytes(), self.original)
        for path in self.run.rglob("*"):
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o700 if path.is_dir() else 0o600)

    def test_rich_markdown_and_existing_summary_source(self):
        self.source = self.root / "source.MD"
        self.source.write_text("L001 Original source evidence only.\n")
        _, self.run = RUN.paths(self.source)
        RUN.prepare(self.source)
        self.assertEqual((self.run / "source.md").read_bytes(), self.source.read_bytes())
        self.assertFalse((self.run / "trajectory.json").exists())
        RUN.issue_call(self.source, "summary")
        rich = SUMMARY.replace("- User requested a check.", "**User:** requested a check.\n\n| Option | Decision |\n| --- | --- |\n| Retry | Deferred |")
        self.write_summary(rich)
        self.accept(self.source, "summary")
        self.assertEqual((self.run / "summary/summary_labeled.md").read_bytes(), RUN.LABEL.label_bytes(rich.encode()))

    def test_imported_v5_summary_allows_direct_insights_and_preserves_original_run(self):
        self.finish_summary()
        manifest = json.loads((self.run / "manifest.json").read_bytes())
        manifest["configuration"]["protocol_version"] = 5
        RUN.save_manifest(self.run, manifest)
        before = {p.relative_to(self.run): p.read_bytes() for p in self.run.rglob("*") if p.is_file()}
        source = self.root / "new-input.jsonl"
        result = RUN.prepare_insight(source, self.run)
        _, imported = RUN.paths(source)
        self.assertEqual(result["summary_origin"], "imported_summary")
        self.assertEqual((imported / "trajectory.json").read_bytes(), self.original)
        self.assertEqual((imported / "summary/summary.md").read_text(), SUMMARY)
        self.assertFalse((imported / "summary-call.json").exists())
        state = json.loads((imported / "manifest.json").read_bytes())["stages"]["summary"]
        self.assertEqual(state["provenance"]["protocol_version"], 5)
        self.assertEqual(state["provenance"]["manifest_sha256"], RUN.sha(before[Path("manifest.json")]))
        with self.assertRaisesRegex(RUN.RunError, "summary_imported"):
            self.accept(source, "summary")
        with self.assertRaisesRegex(RUN.RunError, "insight_not_complete"):
            RUN.issue_call(source, "redaction")
        RUN.issue_call(source, "insight")
        (imported / "insight/insight.md").write_text(INSIGHTS)
        self.assertEqual(self.accept(source, "insight")["insights"], 1)
        self.assertFalse(list(imported.rglob("*.html")))
        self.assertEqual(before, {
            p.relative_to(self.run): p.read_bytes() for p in self.run.rglob("*") if p.is_file()
        })
        with self.assertRaisesRegex(RUN.RunError, "destination_already_exists"):
            RUN.prepare_insight(source, self.run)

    def test_import_checks_prior_completion_source_summary_labels_and_destination(self):
        RUN.prepare(self.source)
        destination = self.root / "new.jsonl"
        with self.assertRaisesRegex(RUN.RunError, "prior_summary_not_complete"):
            RUN.prepare_insight(destination, self.run)
        RUN.issue_call(self.source, "summary")
        self.write_summary()
        self.accept(self.source, "summary")
        for relative, reason in (
            ("trajectory.json", "prior_input_hash_mismatch"),
            ("summary/summary.md", "prior_summary_hash_mismatch"),
            ("summary/summary_labeled.md", "prior_summary_hash_mismatch"),
        ):
            path = self.run / relative
            original = path.read_bytes()
            path.write_bytes(original + b"changed")
            with self.subTest(relative=relative), self.assertRaisesRegex(RUN.RunError, reason):
                RUN.prepare_insight(destination, self.run)
            self.assertFalse(destination.exists())
            path.write_bytes(original)
        with self.assertRaisesRegex(RUN.RunError, "suffix_mismatch"):
            RUN.prepare_insight(self.root / "wrong.md", self.run)
        # Matching hashes alone cannot authorize an incorrectly labeled pair.
        labeled = self.run / "summary/summary_labeled.md"
        labeled.write_text("L001 incorrect")
        manifest = json.loads((self.run / "manifest.json").read_bytes())
        manifest["stages"]["summary"]["outputs"]["sha256"]["summary_labeled.md"] = RUN.sha(labeled.read_bytes())
        RUN.save_manifest(self.run, manifest)
        with self.assertRaisesRegex(RUN.RunError, "prior_labeled_summary_mismatch"):
            RUN.prepare_insight(destination, self.run)
        self.assertFalse(destination.exists())

    def test_saved_configuration_and_prompts_survive_repository_changes(self):
        RUN.prepare(self.source)
        with patch.object(RUN, "EFFORT", "low"), patch.object(RUN, "fixed_template", side_effect=AssertionError("must use saved template")):
            call = RUN.issue_call(self.source, "summary")
        self.assertEqual(call["reasoning_effort"], "high")
        self.assertEqual(call["model"], "gpt-6.1-sol")
        self.assertIn((RUN.KIT / "prompts/summary.md").read_text(), call["message"])
        manifest = json.loads((self.run / "manifest.json").read_bytes())
        manifest["configuration"]["protocol_version"] = 6
        RUN.save_manifest(self.run, manifest)
        with self.assertRaisesRegex(RUN.RunError, "unsupported_run_protocol"):
            RUN.verify_resume(self.source)

    def test_v7_run_resumes_with_frozen_legacy_parser_and_prompts(self):
        self.finish_summary()
        manifest = json.loads((self.run / "manifest.json").read_bytes())
        manifest["configuration"]["protocol_version"] = 7
        parser = (Path(__file__).parent / "fixtures/insight_cards_v7.py").read_bytes()
        (self.run / "protocol/insight_cards.py").write_bytes(parser)
        manifest["protocol_sha256"]["insight_cards.py"] = RUN.sha(parser)
        template = b"Frozen v7 worker contract; use Scope and Takeaway.\n"
        (self.run / "protocol/insight-template.md").write_bytes(template)
        manifest["protocol_sha256"]["insight-template.md"] = RUN.sha(template)
        RUN.save_manifest(self.run, manifest)
        RUN.verify_resume(self.source)
        call = RUN.issue_call(self.source, "insight")
        self.assertTrue(call["message"].startswith(template.decode()))
        legacy = INSIGHTS.replace("Workflow: Check independent evidence before relying on a reported result.\n", "").replace("Type: agent", "Type: agent encountered").replace("Description:", "Scope:").replace("Example:", "Takeaway:")
        (self.run / "insight/insight.md").write_text(legacy)
        self.assertEqual(self.accept(self.source, "insight")["insights"], 1)
        self.assertEqual((self.run / "protocol/insight_cards.py").read_bytes(), parser)

    def test_v8_run_resumes_with_frozen_five_field_parser(self):
        self.finish_summary()
        manifest = json.loads((self.run / "manifest.json").read_bytes())
        manifest["configuration"]["protocol_version"] = 8
        parser = (Path(__file__).parent / "fixtures/insight_cards_v8.py").read_bytes()
        (self.run / "protocol/insight_cards.py").write_bytes(parser)
        manifest["protocol_sha256"]["insight_cards.py"] = RUN.sha(parser)
        template = b"Frozen v8 worker; use Description and Example without Workflow.\n"
        (self.run / "protocol/insight-template.md").write_bytes(template)
        manifest["protocol_sha256"]["insight-template.md"] = RUN.sha(template)
        RUN.save_manifest(self.run, manifest)
        RUN.verify_resume(self.source)
        call = RUN.issue_call(self.source, "insight")
        self.assertTrue(call["message"].startswith(template.decode()))
        old = INSIGHTS.replace("Workflow: Check independent evidence before relying on a reported result.\n", "")
        (self.run / "insight/insight.md").write_text(old)
        self.assertEqual(self.accept(self.source, "insight")["insights"], 1)
        self.assertEqual((self.run / "protocol/insight_cards.py").read_bytes(), parser)

    def test_fenced_headings_do_not_change_summary_structure(self):
        summary = SUMMARY + "\n```markdown\n# Example heading\n## Example topic\n```\n"
        RUN.validate_summary(summary.encode())

    def test_changed_or_deleted_original_is_ignored_but_resume_checks_frozen_copy(self):
        RUN.prepare(self.source)
        self.source.write_bytes(b"changed original")
        RUN.verify_resume(self.source)
        self.source.unlink()
        RUN.issue_call(self.source, "summary")
        self.write_summary()
        self.accept(self.source, "summary")
        RUN.verify_resume(self.source)
        (self.run / "trajectory.json").write_bytes(b"{}\n")
        with self.assertRaisesRegex(RUN.RunError, "input_hash_mismatch"):
            RUN.verify_resume(self.source)

    def test_accepted_artifacts_are_checked_on_resume_only(self):
        self.finish_summary()
        with patch.object(RUN, "validate_outputs", side_effect=AssertionError("already accepted")):
            RUN.issue_call(self.source, "insight")
        labeled = self.run / "summary/summary_labeled.md"
        labeled.write_bytes(labeled.read_bytes().replace(b"User requested", b"User cancelled"))
        with self.assertRaisesRegex(RUN.RunError, "summary_outputs_changed"):
            RUN.verify_resume(self.source)

    def test_accept_does_not_revalidate_previous_stages(self):
        self.finish_summary()
        RUN.issue_call(self.source, "insight")
        (self.run / "insight/insight.md").write_text(INSIGHTS)
        validate = RUN.validate_outputs
        with patch.object(RUN, "validate_outputs", wraps=validate) as checked:
            self.accept(self.source, "insight")
        self.assertEqual([call.args[1] for call in checked.call_args_list], ["insight"])

    def test_summary_gate_accepts_plain_text_and_extra_files_but_rejects_empty_or_invalid_utf8(self):
        RUN.prepare(self.source)
        RUN.issue_call(self.source, "summary")
        for content in (b"", b" \n", b"\xff"):
            (self.run / "summary/summary.md").write_bytes(content)
            with self.assertRaises((RUN.RunError, UnicodeError)):
                self.accept(self.source, "summary")
        self.write_summary("A readable summary without mandatory headings.\n")
        (self.run / "summary/notes.txt").write_text("incidental")
        result = self.accept(self.source, "summary")
        self.assertEqual(result["summary_lines"], 1)
        self.assertEqual((self.run / "summary/summary_labeled.md").read_text(),
                         "L001 A readable summary without mandatory headings.\n")

    def test_invalid_evidence_blank_headings_ranges_and_ids_are_rejected(self):
        self.finish_summary()
        RUN.issue_call(self.source, "insight")
        for insight in (
            INSIGHTS.replace("L009, L013", "L999"),
            INSIGHTS.replace("L009, L013", "L007"),
            INSIGHTS.replace("L009, L013", "L008"),
            INSIGHTS.replace("L009, L013", "L009-L013"),
            INSIGHTS.replace("L009, L013", "L009, L009"),
            INSIGHTS.replace("I001", "I002"),
            "# I001\nEvidence: L009\n", "Unstructured insight",
        ):
            (self.run / "insight/insight.md").write_text(insight)
            with self.assertRaises(RUN.RunError):
                self.accept(self.source, "insight")

    def test_redaction_references_follow_new_lines(self):
        self.finish_insight()
        RUN.issue_call(self.source, "redaction")
        shorter = SUMMARY.replace("\n## Purpose\n\n- User requested a check.\n", "")
        self.write_redaction(shorter, SHORT_INSIGHTS)
        result = self.accept(self.source, "redaction")
        self.assertEqual(result["summary_lines"], 9)
        self.assertTrue(result["run_complete"])

    def test_redaction_labels_and_stale_citations_are_checked(self):
        self.finish_insight()
        RUN.issue_call(self.source, "redaction")
        shorter = SUMMARY.replace("\n## Purpose\n\n- User requested a check.\n", "")
        self.write_redaction(shorter)
        with self.assertRaisesRegex(RUN.RunError, "invalid_evidence_references"):
            self.accept(self.source, "redaction")
        (self.run / "redaction/insight_redacted.md").write_text("")
        (self.run / "redaction/summary_redacted_labeled.md").write_text("L001 Incorrect.\n")
        with self.assertRaisesRegex(RUN.RunError, "labeled_summary_mismatch"):
            self.accept(self.source, "redaction")

    def test_empty_insights_and_fully_removed_redaction(self):
        result = self.finish_insight("")
        self.assertEqual(result["insights"], 0)
        RUN.issue_call(self.source, "redaction")
        self.write_redaction("", "")
        result = self.accept(self.source, "redaction")
        self.assertTrue(result["run_complete"])
        self.assertEqual(result["summary_lines"], 0)

    def test_output_gates_ignore_incidental_files(self):
        self.finish_summary()
        RUN.issue_call(self.source, "insight")
        (self.run / "insight/insight.md").write_text(INSIGHTS)
        (self.run / "insight/notes.txt").write_text("incidental")
        result = self.accept(self.source, "insight")
        self.assertEqual(set(result["sha256"]), {"summary.md", "summary_labeled.md", "insight.md"})
        RUN.issue_call(self.source, "redaction")
        self.write_redaction()
        (self.run / "redaction/notes.txt").write_text("incidental")
        self.assertTrue(self.accept(self.source, "redaction")["run_complete"])

    def test_run_uses_saved_labeler_and_card_parser(self):
        RUN.prepare(self.source)
        RUN.issue_call(self.source, "summary")
        self.write_summary()
        with patch.object(RUN.LABEL, "label_file", side_effect=AssertionError("use snapshot")):
            self.accept(self.source, "summary")
        call = RUN.issue_call(self.source, "insight")
        prefix = json.loads(call["message"].split("# Label helper command (JSON argv prefix)\n")[1].split("# Per-item input")[0])
        self.assertEqual(prefix, ["python3", str(self.run / "protocol/label_summary_lines.py")])
        (self.run / "insight/insight.md").write_text(INSIGHTS)
        with patch.object(RUN.CARDS, "parse_cards", side_effect=AssertionError("use snapshot")):
            self.assertEqual(self.accept(self.source, "insight")["insights"], 1)
        saved = self.run / "protocol/insight_cards.py"
        saved.write_bytes(saved.read_bytes() + b"\n# modified")
        with self.assertRaisesRegex(RUN.RunError, "saved_protocol_changed"):
            RUN.verify_resume(self.source)

    def test_call_records_are_provenance_and_worker_completion_is_required(self):
        RUN.prepare(self.source)
        RUN.issue_call(self.source, "summary")
        self.write_summary()
        with self.assertRaisesRegex(RUN.RunError, "worker_not_recorded"):
            RUN.accept(self.source, "summary", worker_id="actual", worker_status="complete")
        RUN.record_worker(self.source, "summary", "actual")
        for status in (None, "running", "error"):
            with self.assertRaisesRegex(RUN.RunError, "worker_not_complete"):
                RUN.accept(self.source, "summary", worker_id="actual", worker_status=status)
        with self.assertRaisesRegex(RUN.RunError, "worker_id_mismatch"):
            RUN.accept(self.source, "summary", worker_id="wrong", worker_status="complete")
        with self.assertRaisesRegex(RUN.RunError, "worker_id_mismatch"):
            RUN.record_worker(self.source, "summary", "different")
        (self.run / "summary-call.json").unlink()
        self.assertEqual(RUN.accept(self.source, "summary", worker_id="actual", worker_status="complete")["status"], "complete")

    def test_existing_runs_locks_and_symlinks_are_refused(self):
        RUN.prepare(self.source)
        with self.assertRaises(FileExistsError):
            RUN.prepare(self.source)
        (self.run / ".operation-lock").write_text("")
        with self.assertRaises(FileExistsError):
            RUN.issue_call(self.source, "summary")
        link = self.root / "link.jsonl"
        link.symlink_to(self.source)
        with self.assertRaisesRegex(RUN.RunError, "input_symlink"):
            RUN.prepare(link)

    def test_json_documents_and_escaped_paths_are_supported(self):
        source = self.root / 'strange "name"\n{input}.json'
        source.write_text('[{"role":"user","text":"synthetic"}]')
        RUN.prepare(source)
        call = RUN.issue_call(source, "summary")
        value = json.loads(call["message"].splitlines()[-1])
        self.assertEqual(value["input_path"], str(source))

    def test_malformed_input_and_live_storage_fail_before_creating_run(self):
        self.source.write_bytes(b"not json\n")
        with self.assertRaisesRegex(RUN.RunError, "malformed_input"):
            RUN.prepare(self.source)
        self.assertFalse(self.run.exists())
        with self.assertRaisesRegex(RUN.RunError, "collect_live_rollout_first"):
            RUN.prepare(self.root / ".codex" / "sessions" / "live.jsonl")

    def host_adapters(self, events, *, failed_stage=None, invalid_stage=None):
        async def dispatch(arguments):
            stage = arguments["task_name"].split("_")[1]
            manifest = json.loads((self.run / "manifest.json").read_bytes())
            for previous in list(RUN.STAGES)[:list(RUN.STAGES).index(stage)]:
                self.assertEqual(manifest["stages"][previous]["status"], "complete")
            events.append(("dispatch", stage))
            return "host-" + stage

        async def wait(worker_id):
            stage = worker_id.removeprefix("host-")
            events.append(("wait", stage))
            if stage == failed_stage:
                return {"status": "error"}
            if stage == "summary":
                self.write_summary("" if stage == invalid_stage else SUMMARY)
            elif stage == "insight":
                (self.run / "insight/insight.md").write_text(INSIGHTS)
            else:
                self.write_redaction()
            return {"status": "complete"}
        return dispatch, wait

    def test_orchestrator_runs_all_stages_in_order_and_completed_resume_is_idle(self):
        events = []
        dispatch, wait = self.host_adapters(events)
        result = asyncio.run(RUN.orchestrate(self.source, dispatch, wait))
        self.assertTrue(result["run_complete"])
        self.assertEqual(events, [(action, stage) for stage in RUN.STAGES for action in ("dispatch", "wait")])
        manifest = json.loads((self.run / "manifest.json").read_bytes())
        for stage in RUN.STAGES:
            self.assertEqual(manifest["stages"][stage]["worker_id"], "host-" + stage)
        events.clear()
        asyncio.run(RUN.orchestrate(self.source, dispatch, wait))
        self.assertEqual(events, [])

    def test_orchestrator_stops_on_worker_error_and_resumes_same_worker(self):
        events = []
        dispatch, wait = self.host_adapters(events, failed_stage="summary")
        with self.assertRaisesRegex(RUN.RunError, "worker_not_complete"):
            asyncio.run(RUN.orchestrate(self.source, dispatch, wait))
        self.assertEqual(events, [("dispatch", "summary"), ("wait", "summary")])
        events.clear()
        dispatch, wait = self.host_adapters(events)
        result = asyncio.run(RUN.orchestrate(self.source, dispatch, wait, redact=False))
        self.assertFalse(result["run_complete"])
        self.assertEqual(events, [("wait", "summary"), ("dispatch", "insight"), ("wait", "insight")])

    def test_orchestrator_stops_on_invalid_output(self):
        events = []
        dispatch, wait = self.host_adapters(events, invalid_stage="summary")
        with self.assertRaisesRegex(RUN.RunError, "empty_summary"):
            asyncio.run(RUN.orchestrate(self.source, dispatch, wait))
        self.assertEqual(events, [("dispatch", "summary"), ("wait", "summary")])
        self.assertTrue((self.run / "summary/summary.md").exists())

    def test_orchestrator_never_reissues_uncertain_dispatch(self):
        events = []
        _, wait = self.host_adapters(events)

        async def dispatch(arguments):
            events.append("dispatched")
            raise ConnectionError("lost dispatch response")

        with self.assertRaises(ConnectionError):
            asyncio.run(RUN.orchestrate(self.source, dispatch, wait))
        with self.assertRaisesRegex(RUN.RunError, "dispatch_uncertain"):
            asyncio.run(RUN.orchestrate(self.source, dispatch, wait))
        self.assertEqual(events, ["dispatched"])

    def test_orchestrator_checks_integrity_before_resuming(self):
        self.finish_summary()
        self.write_summary("changed")
        events = []
        dispatch, wait = self.host_adapters(events)
        with self.assertRaisesRegex(RUN.RunError, "summary_outputs_changed"):
            asyncio.run(RUN.orchestrate(self.source, dispatch, wait))
        self.assertEqual(events, [])

    def test_orchestrator_skips_imported_supported_summaries(self):
        self.finish_summary()
        prior = self.run
        manifest = json.loads((prior / "manifest.json").read_bytes())
        for version in (5, 6, 7, 8, 9):
            with self.subTest(version=version):
                manifest["configuration"]["protocol_version"] = version
                RUN.save_manifest(prior, manifest)
                source = self.root / f"imported-v{version}.jsonl"
                RUN.prepare_insight(source, prior)
                _, self.run = RUN.paths(source)
                events = []
                dispatch, wait = self.host_adapters(events)
                result = asyncio.run(RUN.orchestrate(source, dispatch, wait, redact=False))
                self.assertFalse(result["run_complete"])
                self.assertEqual(events, [("dispatch", "insight"), ("wait", "insight")])

    def test_cli_requires_worker_receipt_then_accepts_plain_summary(self):
        def cli(*arguments):
            return subprocess.run(["python3", str(SCRIPT), *map(str, arguments)], capture_output=True, text=True)

        self.assertEqual(cli("prepare", self.source).returncode, 0)
        self.assertEqual(cli("summary-call", self.source).returncode, 0)
        self.write_summary("Plain summary.\n")
        self.assertNotEqual(cli("accept-summary", self.source).returncode, 0)
        self.assertEqual(cli("record-worker", self.source, "--stage", "summary", "--worker-id", "host-summary").returncode, 0)
        self.assertNotEqual(cli("accept-summary", self.source, "--worker-id", "host-summary", "--worker-status", "error").returncode, 0)
        result = cli("accept-summary", self.source, "--worker-id", "host-summary", "--worker-status", "complete")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["summary_lines"], 1)
        self.assertEqual(cli("verify-resume", self.source).returncode, 0)


if __name__ == "__main__":
    unittest.main()
