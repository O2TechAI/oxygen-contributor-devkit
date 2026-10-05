import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


TOOLS = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


COLLECT = load("collect_claude_test", TOOLS / "collect_claude_sessions.py")
STRIP = load("strip_claude_test", TOOLS / "strip_claude_tool_outputs.py")


def jsonl(records):
    return b"".join((json.dumps(item, ensure_ascii=False) + "\n").encode() for item in records)


def user(text, **extra):
    return {"type": "user", "message": {"role": "user", "content": text}, **extra}


def assistant(*blocks, **extra):
    return {"type": "assistant", "message": {"role": "assistant", "model": "claude", "content": list(blocks)}, **extra}


def tool_use(call_id, name, **arguments):
    return {"type": "tool_use", "id": call_id, "name": name, "input": arguments}


def tool_result(call_id, content, result=None, is_error=None):
    block = {"type": "tool_result", "tool_use_id": call_id, "content": content}
    if is_error is not None:
        block["is_error"] = is_error
    record = {"type": "user", "message": {"role": "user", "content": [block]}}
    if result is not None:
        record["toolUseResult"] = result
    return record


def session(cwd, session_id="s1", **extra):
    return [
        {"type": "queue-operation", "operation": "enqueue", "content": "hello"},
        {"type": "ai-title", "aiTitle": "Title"},
        {**user("hello"), "cwd": cwd, "sessionId": session_id, "timestamp": "2026-01-01T00:00:00Z", **extra},
        {**assistant({"type": "text", "text": "Hi."}), "cwd": cwd, "sessionId": session_id},
    ]


class CollectTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.workspace = self.root / "work"
        (self.workspace / "child").mkdir(parents=True)
        self.config = self.root / "config"
        self.projects = self.config / "projects" / "-work"
        self.projects.mkdir(parents=True)

    def write(self, name, records):
        path = self.projects / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(jsonl(records))
        return path

    def test_selects_main_sessions_by_first_recorded_cwd(self):
        inside = self.write("a.jsonl", session(str(self.workspace / "child"), "a"))
        # A later directory change does not move a session into the workspace.
        moved = session("/elsewhere", "b") + [{**user("cd"), "cwd": str(self.workspace)}]
        self.write("b.jsonl", moved)
        self.write("a/subagents/agent-x.jsonl", session(str(self.workspace), "a"))
        self.write("agent-legacy.jsonl", session(str(self.workspace), "a"))
        self.write("c.jsonl", session(str(self.workspace), "c", isSidechain=True))
        self.write("titles.jsonl", [{"type": "ai-title", "aiTitle": "only metadata"}])
        manifest = COLLECT.collect(self.workspace, [self.config], self.root / "run")
        self.assertTrue(manifest["complete"])
        self.assertEqual(manifest["format"], "claude-code")
        self.assertEqual([entry["session_id"] for entry in manifest["sessions"]], ["a"])
        entry = manifest["sessions"][0]
        self.assertEqual(entry["first_timestamp"], "2026-01-01T00:00:00Z")
        snapshot = self.root / "run" / entry["snapshot_path"]
        self.assertEqual(snapshot.read_bytes(), inside.read_bytes())
        self.assertEqual(snapshot.stat().st_mode & 0o777, 0o600)
        self.assertEqual(manifest["counts"]["excluded_by_reason"],
                         {"no_conversation_records": 1, "outside_workspace": 1, "subagent": 3})

    def test_refuses_output_inside_session_storage(self):
        with self.assertRaisesRegex(COLLECT.CollectionError, "output_inside_session_storage"):
            COLLECT.collect(self.workspace, [self.config], self.projects / "run")

    def test_missing_projects_root_is_incomplete(self):
        manifest = COLLECT.collect(self.workspace, [self.root / "absent"], dry_run=True)
        self.assertFalse(manifest["complete"])


class StripTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)

    def run_filter(self, records, markdown=True):
        source = self.root / "input.jsonl"
        source.write_bytes(jsonl(records))
        output = self.root / "output.jsonl"
        md = self.root / "trajectory-001.md" if markdown else None
        report = STRIP.filter_session(source, output, self.root / "report.json", markdown_path=md)
        lines = [json.loads(line) for line in output.read_bytes().splitlines()]
        return lines, (md.read_text() if md else None), report

    def test_removes_outputs_and_retains_human_input(self):
        records = [
            {"type": "attachment", "attachment": {"type": "skill_listing", "content": "skills"}},
            user("<local-command-caveat>Caveat</local-command-caveat>", isMeta=True),
            user("<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>"),
            user("<local-command-stdout>Set model to opus</local-command-stdout>"),
            user("<system-reminder>Message sent at noon.</system-reminder>\nPlease fix the build."),
            assistant({"type": "thinking", "thinking": "", "signature": "opaque"},
                      {"type": "thinking", "thinking": "Check the log.", "signature": "opaque2"},
                      tool_use("t1", "Bash", command="make", description="Build")),
            tool_result("t1", "SECRET BUILD OUTPUT", {"stdout": "SECRET BUILD OUTPUT"}),
            assistant(tool_use("t2", "AskUserQuestion", questions=[{"question": "Deploy?"}])),
            tool_result("t2", 'Your questions have been answered: "Deploy?"="Yes".',
                        {"questions": [{"question": "Deploy?"}], "answers": {"Deploy?": "Yes"}}),
            assistant(tool_use("t3", "Bash", command="rm -rf build")),
            tool_result("t3", "The user doesn't want to proceed with this tool use.", "User rejected tool use", True),
            assistant(tool_use("t4", "Agent", prompt="Investigate.", description="probe")),
            user("<task-notification><result>SUBAGENT REPORT</result></task-notification>",
                 origin={"kind": "task-notification"}),
            {"type": "attachment", "attachment": {"type": "queued_command", "commandMode": "task-notification",
                                                  "prompt": "<task-notification>QUEUED REPORT</task-notification>"}},
            {"type": "attachment", "attachment": {"type": "queued_command", "commandMode": "prompt",
                                                  "origin": {"kind": "human"}, "prompt": "Also add tests."}},
            {"type": "user", "message": {"role": "user", "content": [
                {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "QUJD"}},
                {"type": "text", "text": "See screenshot."}]}},
            {"type": "system", "subtype": "compact_boundary", "content": "Conversation compacted"},
            user("Summary of earlier work.", isCompactSummary=True),
            assistant({"type": "text", "text": "API Error"}, isApiErrorMessage=True),
            {"type": "file-history-snapshot", "snapshot": {"backups": {"a.py": "contents"}}},
            {"type": "brand-new-metadata", "value": 1},
        ]
        lines, markdown, report = self.run_filter(records)
        dumped = json.dumps(lines)
        for leaked in ("SECRET BUILD OUTPUT", "SUBAGENT REPORT", "QUEUED REPORT", "opaque", "QUJD",
                       "Set model to opus", "skills", "contents"):
            self.assertNotIn(leaked, dumped)
            self.assertNotIn(leaked, markdown)
        self.assertEqual(report["inventory"]["user_input_results_retained"],
                         {"AskUserQuestion": 1, "rejected:Bash": 1})
        self.assertEqual(report["removed"]["opaque_signatures"], 2)
        self.assertEqual(report["removed"]["embedded_media"], {"image": 1})
        self.assertEqual(report["removed"]["metadata_records"], {"brand-new-metadata": 1, "file-history-snapshot": 1})
        self.assertEqual(report["markdown"]["roles"], {
            "assistant reasoning": 1, "compaction summary": 1, "tool call": 4,
            "user": 4, "user input result": 2})
        self.assertTrue(markdown.startswith("# trajectory-001\n\n## user\n\n/model opus\n\n---"))
        self.assertIn("## user\n\nPlease fix the build.", markdown)
        self.assertNotIn("system-reminder", markdown)
        self.assertIn("## user\n\nAlso add tests.", markdown)
        self.assertIn("## user\n\n[image omitted]\n\nSee screenshot.", markdown)
        self.assertIn("**Outcome:** answered", markdown)
        self.assertIn('"Deploy?":"Yes"', markdown)
        self.assertIn("**Tool:** Bash\n\n**Call ID:** t3\n\n**Outcome:** rejected by user", markdown)
        self.assertIn("## compaction summary\n\nSummary of earlier work.", markdown)
        self.assertIn("### prompt\n\n```text\nInvestigate.\n```", markdown)
        self.assertNotIn("API Error", markdown)

    def test_unchanged_records_are_byte_identical(self):
        records = [user("Plain request"), assistant({"type": "text", "text": "Done."})]
        source = self.root / "input.jsonl"
        source.write_bytes(jsonl(records))
        STRIP.filter_session(source, self.root / "out.jsonl")
        self.assertEqual((self.root / "out.jsonl").read_bytes(), source.read_bytes())

    def test_error_from_question_tool_is_not_a_rejection(self):
        records = [user("Ask me."), assistant(tool_use("q", "AskUserQuestion", questions=[])),
                   tool_result("q", "Tool permission stream closed", None, True)]
        _, markdown, _ = self.run_filter(records)
        self.assertIn("**Outcome:** error", markdown)

    def test_result_identity_comes_from_the_call_not_the_wording(self):
        records = [user("Run it."), assistant(tool_use("b", "Bash", command="echo")),
                   tool_result("b", "Your questions have been answered: yes", {"answers": {"q": "yes"}})]
        lines, markdown, report = self.run_filter(records)
        self.assertEqual(report["inventory"]["user_input_results_retained"], {})
        self.assertNotIn("answered", markdown)

    def test_unsupported_blocks_abort(self):
        records = [user("x"), assistant({"type": "mystery", "data": 1})]
        with self.assertRaisesRegex(STRIP.FilterError, "unsupported assistant block"):
            self.run_filter(records, markdown=False)
        self.assertFalse((self.root / "output.jsonl").exists())

    def test_markdown_requires_a_user_request(self):
        records = [user("caveat", isMeta=True), assistant({"type": "text", "text": "Hi"})]
        with self.assertRaisesRegex(STRIP.FilterError, "no original user input"):
            self.run_filter(records)
        self.assertFalse((self.root / "output.jsonl").exists())


if __name__ == "__main__":
    unittest.main()
