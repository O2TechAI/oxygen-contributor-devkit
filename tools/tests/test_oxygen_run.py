import asyncio
import importlib.util
import json
import os
import signal
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


TOOLS = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


OXY = load("oxygen_run_test", TOOLS / "oxygen_run.py")


def jsonl(records):
    return b"".join((json.dumps(item, ensure_ascii=False) + "\n").encode() for item in records)


def claude_session(cwd, session_id, text, started="2026-01-01T00:00:00Z", **extra):
    return [
        {"type": "queue-operation", "operation": "enqueue", "content": "x"},
        {"type": "user", "message": {"role": "user", "content": text}, "cwd": cwd,
         "sessionId": session_id, "timestamp": started, **extra},
        {"type": "assistant", "message": {"role": "assistant", "model": "claude",
                                          "content": [{"type": "text", "text": "Done."}]},
         "cwd": cwd, "sessionId": session_id},
    ]


def claude_records(cwd, session_id, uuids, parent=None, day="01"):
    """A chain of alternating user and assistant records with Claude Code's uuid links."""
    rows = []
    for index, uuid in enumerate(uuids):
        if index % 2 == 0:
            message = {"role": "user", "content": f"Ask {uuid}"}
        else:
            message = {"role": "assistant", "model": "claude", "content": [{"type": "text", "text": f"Reply {uuid}"}]}
        rows.append({"type": message["role"], "message": message, "cwd": cwd, "sessionId": session_id,
                     "timestamp": f"2026-01-{day}T00:00:0{index}Z", "uuid": uuid, "parentUuid": parent})
        parent = uuid
    return rows


def compress_rollout(path):
    """Compress a rollout in place, as Codex does with older sessions; None without zstd."""
    try:
        kind, backend = OXY.CODEX._zstd_backend()
    except OXY.CollectionError:
        return None
    target = path.with_name(path.name + ".zst")
    if kind == "stdlib":
        target.write_bytes(backend.compress(path.read_bytes()))
    elif kind == "zstandard":
        target.write_bytes(backend.ZstdCompressor().compress(path.read_bytes()))
    else:
        subprocess.run([backend, "-q", str(path), "-o", str(target)], check=True)
    path.unlink()
    return target


def codex_session(cwd, session_id, text, started="2026-01-02T00:00:00.000Z", source="cli"):
    def message(role, *texts):
        return {"type": "response_item", "payload": {"type": "message", "role": role,
                "content": [{"type": "input_text", "text": value} for value in texts]}}
    return [
        {"type": "session_meta", "payload": {"id": session_id, "cwd": cwd, "source": source, "timestamp": started}},
        message("developer", "<permissions instructions>"),
        message("user", "# AGENTS.md instructions for /x", "<environment_context></environment_context>"),
        message("user", text),
    ]


SUMMARY = "# Title\n\nFirst content line.\n\nSecond content line.\n"
CARD = """# I001

Title: Check the export
Type: agent
Description:

Check exported values against the source.

Workflow:

1. Compare the export with the source.

Example:

The export was compared with the source.

Evidence: L003
"""


class Environment(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.codex = self.root / "codex"
        self.claude = self.root / "claude"
        self.work = self.root / "work"
        self.other = self.root / "other"
        self.work.mkdir()
        self.other.mkdir()
        (self.codex / "sessions" / "2026").mkdir(parents=True)
        (self.claude / "projects" / "-work").mkdir(parents=True)
        patcher = patch.dict(os.environ, {"OXYGEN_CODEX_HOME": str(self.codex), "OXYGEN_CLAUDE_CONFIG_DIR": str(self.claude),
                                          "OXYGEN_HOME": str(self.root / "home")})
        patcher.start()
        self.addCleanup(patcher.stop)
        OXY.project_root.cache_clear()

    def claude_file(self, name, records, folder="-work"):
        path = self.claude / "projects" / folder / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(jsonl(records))
        return path

    def codex_file(self, name, records):
        path = self.codex / "sessions" / "2026" / name
        path.write_bytes(jsonl(records))
        return path


class DiscoveryTests(Environment):
    def test_workspaces_group_sessions_by_project_and_skip_subagents(self):
        self.claude_file("a.jsonl", claude_session(str(self.work), "a", "First request"))
        self.claude_file("b.jsonl", claude_session(str(self.work), "b", "Second request"))
        self.claude_file("side.jsonl", claude_session(str(self.work), "s", "Side", isSidechain=True))
        self.claude_file("a/subagents/agent-1.jsonl", claude_session(str(self.work), "a", "Agent"))
        self.claude_file("c.jsonl", claude_session(str(self.other), "c", "Elsewhere"), "-other")
        self.codex_file("rollout-1.jsonl", codex_session(str(self.work), "x", "Codex request"))
        self.codex_file("rollout-2.jsonl", codex_session(str(self.work), "y", "Sub", source="subagent"))
        self.codex_file("rollout-3.jsonl", codex_session(
            str(self.work), "z", "Spawned", source={"subagent": {"thread_spawn": {"depth": 1}}}))
        groups = {group["path"]: group for group in OXY.workspaces()}
        self.assertEqual(set(groups), {str(self.work), str(self.other)})
        self.assertEqual(groups[str(self.work)]["sessions"], {"codex": 1, "claude": 2})
        self.assertEqual(groups[str(self.other)]["sessions"], {"codex": 0, "claude": 1})
        self.assertEqual(groups[str(self.work)]["name"], "work")

    def test_sessions_are_ordered_titled_and_sampled(self):
        for number in range(5):
            self.claude_file(f"s{number}.jsonl", claude_session(
                str(self.work), f"s{number}", f"Request {number}\nmore detail",
                started=f"2026-01-0{number + 1}T00:00:00Z"))
        self.codex_file("r.jsonl", codex_session(str(self.work), "r", "Codex asks\nsecond line",
                                                 started="2026-01-06T00:00:00.000Z"))
        sessions = OXY.workspace_sessions(str(self.work))
        self.assertEqual([s["id"] for s in sessions], ["s0", "s1", "s2", "s3", "s4", "r"])
        self.assertEqual(sessions[0]["title"], "Request 0")
        self.assertEqual(sessions[5]["title"], "Codex asks")
        self.assertEqual([s["suggested"] for s in sessions], [True, False, False, True, False, True])

    def test_session_names_use_the_agents_own_latest_titles(self):
        self.claude_file("a.jsonl", [*claude_session(str(self.work), "a", "Hi"),
                                     {"type": "custom-title", "customTitle": "Old name", "sessionId": "a"},
                                     {"type": "custom-title", "customTitle": "Sandbox evaluation", "sessionId": "a"}])
        self.claude_file("b.jsonl", claude_session(str(self.work), "b", "No title here"))
        (self.codex / "session_index.jsonl").write_text("\n".join(json.dumps(row) for row in [
            {"id": "x", "thread_name": "First name", "updated_at": "2026-01-01"},
            {"id": "y", "thread_name": "Unrelated", "updated_at": "2026-01-01"},
            {"id": "x", "thread_name": "Review trajectory insights", "updated_at": "2026-01-02"},
        ]) + "\nnot json\n")
        names = OXY.session_names([("claude", "a"), ("claude", "b"), ("codex", "x"), ("codex", "missing")])
        self.assertEqual(names, {"claude:a": "Sandbox evaluation", "codex:x": "Review trajectory insights"})
        output = subprocess.run([sys.executable, str(TOOLS / "oxygen_run.py"), "session-names",
                                 "--session", "codex:x"], capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(output.stdout), {"names": {"codex:x": "Review trajectory insights"}})

    def test_sample_positions(self):
        self.assertEqual(OXY.suggested_sample(0), [])
        self.assertEqual(OXY.suggested_sample(2), [0, 1])
        self.assertEqual(OXY.suggested_sample(3), [0, 1, 2])
        self.assertEqual(OXY.suggested_sample(10), [0, 5, 9])

    def test_setup_text_is_not_used_as_a_title(self):
        path = self.claude_file("t.jsonl", [
            {"type": "user", "message": {"role": "user", "content": "<command-name>/clear</command-name>"},
             "cwd": str(self.work), "sessionId": "t", "timestamp": "2026-01-01T00:00:00Z"},
            {"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": "  Real ask here"}]},
             "cwd": str(self.work)},
        ])
        self.assertEqual(OXY.first_request(str(path), "claude"), "Real ask here")

    def test_resumed_codex_rollouts_and_compressed_ones_are_one_session(self):
        first = self.codex_file("rollout-2026-01-02T00-00-00-x.jsonl",
                                codex_session(str(self.work), "x", "First part"))
        later = codex_session(str(self.work), "x", "Second part")
        self.codex_file("rollout-2026-01-03T00-00-00-x.jsonl", [later[0], later[3]])
        if compress_rollout(first) is None:
            self.skipTest("no zstd decoder available")
        groups = {group["path"]: group for group in OXY.workspaces()}
        self.assertEqual(groups[str(self.work)]["sessions"], {"codex": 1, "claude": 0})
        [session] = OXY.workspace_sessions(str(self.work))
        self.assertEqual((session["id"], session["title"]), ("x", "First part"))
        snapshots = self.root / "snapshots"
        snapshots.mkdir()
        [entry] = [s for s in OXY.scan() if s["id"] == "x"]
        text = OXY.freeze(entry, snapshots).read_text()
        self.assertLess(text.index("First part"), text.index("Second part"))
        self.assertEqual(text.count('"session_meta"'), 2)

    def test_resumed_and_forked_claude_files_merge_without_losing_records(self):
        root = claude_records(str(self.work), "a", ["a1", "a2", "a3", "a4"])
        resumed = root[:2] + claude_records(str(self.work), "b", ["b1", "b2"], parent="a2", day="02")
        self.claude_file("a.jsonl", root)
        self.claude_file("b.jsonl", resumed)
        [session] = OXY.workspace_sessions(str(self.work))
        self.assertEqual((session["id"], session["title"]), ("a", "Ask a1"))
        [entry] = [s for s in OXY.scan() if s["id"] == "a"]
        snapshots = self.root / "snapshots"
        snapshots.mkdir()
        rows = [json.loads(line) for line in OXY.freeze(entry, snapshots).read_text().splitlines()]
        self.assertEqual([r["uuid"] for r in rows], ["a1", "a2", "a3", "a4", "b1", "b2"])

    def test_headers_are_cached_until_a_file_changes(self):
        self.codex_file("rollout-1.jsonl", codex_session(str(self.work), "x", "Codex request"))
        claude = self.claude_file("a.jsonl", claude_session(str(self.work), "a", "First request"))
        first = sorted((s["source"], s["id"]) for s in OXY.scan())
        cache = self.root / "home" / "cache" / "session-headers.json"
        self.assertEqual(cache.stat().st_mode & 0o777, 0o600)
        with patch.object(OXY.CODEX, "open_source", side_effect=AssertionError("file reopened")):
            self.assertEqual(sorted((s["source"], s["id"]) for s in OXY.scan()), first)
        claude.write_bytes(jsonl(claude_session(str(self.work), "renamed", "First request, edited")))
        self.assertIn(("claude", "renamed"), {(s["source"], s["id"]) for s in OXY.scan()})

    def test_long_titles_are_shortened(self):
        path = self.claude_file("l.jsonl", claude_session(str(self.work), "l", "word " * 100))
        title = OXY.first_request(str(path), "claude")
        self.assertLessEqual(len(title), OXY.TITLE_LENGTH)
        self.assertTrue(title.endswith("…"))


FAKE_CODEX = """#!{python}
import os, pathlib, sys
args = sys.argv[1:]
final = pathlib.Path(args[args.index("-o") + 1])
sys.stdin.read()
count = pathlib.Path(os.environ["FAKE_CODEX_COUNT"])
calls = int(count.read_text()) if count.exists() else 0
count.write_text(str(calls + 1))
mode = os.environ["FAKE_CODEX_MODE"]
if mode == "lock" and calls < 2:
    print("Error: failed to initialize in-process app-server client: No locks available (os error 37)", file=sys.stderr)
    sys.exit(1)
if mode == "broken":
    print("Error: model not found", file=sys.stderr)
    sys.exit(1)
print("worker progress", file=sys.stderr)
final.write_text("The input was too large to finish." if mode == "unfinished" else '{{"status": "complete"}}')
"""


FAKE_CLAUDE = """#!{python}
import json, os, sys
sys.stdin.read()
with open(os.environ["FAKE_CLAUDE_ARGV"], "w") as stream:
    json.dump(sys.argv[1:], stream)
print(json.dumps({{"is_error": False, "result": '{{"status": "complete"}}'}}))
"""


class WorkerProcessTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        binary = self.root / "codex"
        binary.write_text(FAKE_CODEX.format(python=sys.executable))
        binary.chmod(0o700)
        self.source = self.root / "trajectory-001.md"
        Path(str(self.source) + ".oxygen-agents").mkdir()
        patcher = patch.dict(os.environ, {"OXYGEN_CODEX_BIN": str(binary),
                                          "FAKE_CODEX_COUNT": str(self.root / "count")})
        patcher.start()
        self.addCleanup(patcher.stop)

    def run_worker(self, mode):
        workers = OXY.Workers("codex", self.root)
        dispatch, wait = workers.adapters(self.source)

        async def once():
            worker_id = await dispatch({"task_name": "oxygen_summary_abc", "model": "m",
                                        "reasoning_effort": "low", "message": "Summarize."})
            return await wait(worker_id)

        with patch.dict(os.environ, {"FAKE_CODEX_MODE": mode}), patch.object(OXY.random, "uniform", return_value=0):
            return workers, asyncio.run(once())

    def test_startup_lock_errors_are_retried_and_output_is_kept(self):
        workers, result = self.run_worker("lock")
        self.assertEqual(result, {"status": "complete"})
        self.assertEqual((self.root / "count").read_text(), "3")
        [last] = (self.root / "logs").glob("trajectory-001-summary-codex-*.last.txt")
        self.assertEqual(json.loads(last.read_text()), {"status": "complete"})
        self.assertEqual(last.stat().st_mode & 0o777, 0o600)
        self.assertEqual((self.root / "logs").stat().st_mode & 0o777, 0o700)
        self.assertEqual(workers.unfinished, {})

    def test_other_failures_are_not_retried(self):
        with self.assertRaises(OXY.WorkerError) as caught:
            self.run_worker("broken")
        self.assertIn("model not found", str(caught.exception))
        self.assertEqual((self.root / "count").read_text(), "1")

    def test_claude_dispatches_have_no_task_name_and_use_the_run_allowlist(self):
        binary = self.root / "claude"
        binary.write_text(FAKE_CLAUDE.format(python=sys.executable))
        binary.chmod(0o700)
        argv_file = self.root / "argv.json"
        workers = OXY.Workers("claude", self.root)
        dispatch, wait = workers.adapters(self.source)
        reserved = workers.reserve_id()

        async def once():
            worker_id = await dispatch({"description": "Oxygen summary abcd1234", "subagent_type": "general-purpose",
                                        "model": "sonnet", "run_in_background": True, "prompt": "Summarize."},
                                       worker_id=reserved)
            self.assertEqual(worker_id, reserved)
            return await wait(worker_id)

        with patch.dict(os.environ, {"OXYGEN_CLAUDE_BIN": str(binary), "FAKE_CLAUDE_ARGV": str(argv_file)}):
            self.assertEqual(asyncio.run(once()), {"status": "complete"})
        argv = json.loads(argv_file.read_text())
        run = Path(str(self.source) + ".oxygen-agents")
        self.assertEqual(argv[argv.index("--add-dir") + 1], str(run))
        self.assertIn(f"Bash({sys.executable} {run / 'protocol' / 'read_source.py'} *)", argv)
        self.assertEqual(argv[argv.index("--model") + 1], "sonnet")
        [log] = (self.root / "logs").glob(f"trajectory-001-summary-{reserved}.last.txt")
        self.assertIn("complete", log.read_text())

    def test_a_worker_that_does_not_finish_says_why(self):
        workers, result = self.run_worker("unfinished")
        self.assertEqual(result, {"status": "error"})
        why = workers.unfinished[self.source.name]
        self.assertIn("The input was too large to finish.", why)
        self.assertIn("logs/trajectory-001-summary-codex-", why)


class FakeWorkers:
    """Writes valid stage outputs instead of calling a model."""

    failing: set[str] = set()

    def __init__(self, host, workdir):
        self.host = host
        self.calls = []

    def adapters(self, source):
        run = Path(str(source) + ".oxygen-agents")
        results = {}

        async def dispatch(args):
            stage = args["task_name"].split("_")[1]
            self.calls.append((source.name, stage))
            worker = f"{source.name}-{stage}"
            if source.name in self.failing and stage == "insight":
                results[worker] = {"status": "error"}
                return worker
            labeler = OXY.load("fake_labeler", run / "protocol" / "label_summary_lines.py")
            if stage in {"summary", "insight"}:
                reader = OXY.load("fake_reader", run / "protocol" / "read_source.py")
                for number in range(1, len(reader.parts(reader.frozen_source(run).read_bytes())) + 1):
                    reader.read_part(run, stage, number)
            if stage == "summary":
                (run / "summary" / "summary.md").write_text(SUMMARY)
            elif stage == "insight":
                (run / "insight" / "insight.md").write_text(CARD)
            elif stage == "humanize":
                (run / "humanize" / "insight.md").write_text(CARD)
            else:
                (run / "redaction" / "summary_redacted.md").write_text(SUMMARY)
                labeler.label_file(run / "redaction" / "summary_redacted.md",
                                   run / "redaction" / "summary_redacted_labeled.md")
                (run / "redaction" / "insight_redacted.md").write_text(CARD)
            results[worker] = {"status": "complete"}
            return worker

        async def wait(worker):
            await asyncio.sleep(0)
            return results[worker]

        return dispatch, wait

    def stop(self):
        pass


class RunTests(Environment):
    def start(self, sessions, **overrides):
        directory = self.root / "home" / "runs" / "r1"
        directory.mkdir(parents=True)
        config = {"id": "r1", "workspace": str(self.work), "language": "zh", "host": "codex",
                  "model": "gpt-6.1-sol", "effort": "low", "concurrency": 2,
                  "sessions": sessions, **overrides}
        (directory / "config.json").write_text(json.dumps(config))
        return directory

    def execute(self, directory):
        FakeWorkers.failing = set()
        return asyncio.run(OXY.run(directory, workers_factory=FakeWorkers))

    def test_every_selected_session_goes_through_all_four_stages(self):
        for name, when in (("a", "01"), ("b", "02")):
            self.claude_file(f"{name}.jsonl", claude_session(
                str(self.work), name, f"Please fix {name}", started=f"2026-01-{when}T00:00:00Z"))
        self.claude_file("unselected.jsonl", claude_session(str(self.work), "u", "Not chosen"))
        directory = self.start([{"source": "claude", "id": "b"}, {"source": "claude", "id": "a"}])
        self.assertEqual(self.execute(directory), 0)
        state = json.loads((directory / "state.json").read_text())
        self.assertEqual(state["phase"], "done")
        self.assertEqual([t["sessionId"] for t in state["trajectories"]], ["a", "b"])
        self.assertEqual([t["name"] for t in state["trajectories"]], ["", ""])
        for trajectory in state["trajectories"]:
            self.assertEqual(trajectory["status"], "done")
            self.assertEqual(trajectory["stagesDone"], list(OXY.STAGES))
            self.assertEqual(trajectory["insights"], 1)
            self.assertGreater(trajectory["markdownBytes"], 0)
        manifest = json.loads((directory / "trajectories/trajectory-001.md.oxygen-agents/manifest.json").read_text())
        self.assertEqual(manifest["configuration"]["language"], "zh")
        self.assertEqual(manifest["configuration"]["reasoning_effort"], "low")
        self.assertTrue(manifest["complete"])

    def test_sessions_spanning_several_files_convert_to_one_transcript_each(self):
        self.codex_file("rollout-2026-01-02T00-00-00-x.jsonl", codex_session(str(self.work), "x", "First part"))
        later = codex_session(str(self.work), "x", "Second part")
        self.codex_file("rollout-2026-01-03T00-00-00-x.jsonl", [later[0], later[3]])
        root = claude_records(str(self.work), "a", ["a1", "a2", "a3", "a4"])
        self.claude_file("a.jsonl", root)
        self.claude_file("b.jsonl", root[:2] + claude_records(str(self.work), "b", ["b1", "b2"], parent="a2", day="02"))
        directory = self.start([{"source": "codex", "id": "x"}, {"source": "claude", "id": "a"}])
        self.assertEqual(self.execute(directory), 0)
        state = json.loads((directory / "state.json").read_text())
        self.assertEqual([t["status"] for t in state["trajectories"]], ["done", "done"])
        claude, codex = [(directory / "trajectories" / f"trajectory-00{n}.md").read_text() for n in (1, 2)]
        for words in ("Ask a3", "Reply a4", "Ask b1", "Reply b2"):
            self.assertIn(words, claude)
        self.assertEqual(claude.count("Reply a2"), 1)
        self.assertLess(codex.index("First part"), codex.index("Second part"))

    def test_only_selected_sessions_are_copied(self):
        self.claude_file("a.jsonl", claude_session(str(self.work), "a", "Chosen"))
        self.claude_file("u.jsonl", claude_session(str(self.work), "u", "Left alone"))
        directory = self.start([{"source": "claude", "id": "a"}])
        self.execute(directory)
        self.assertEqual(len(list((directory / "collection" / "snapshots").glob("*.jsonl"))), 1)

    def test_one_failure_does_not_stop_the_others(self):
        for name, when in (("a", "01"), ("b", "02")):
            self.claude_file(f"{name}.jsonl", claude_session(
                str(self.work), name, f"Please fix {name}", started=f"2026-01-{when}T00:00:00Z"))
        directory = self.start([{"source": "claude", "id": "a"}, {"source": "claude", "id": "b"}])
        FakeWorkers.failing = {"trajectory-001.md"}
        self.assertEqual(asyncio.run(OXY.run(directory, workers_factory=FakeWorkers)), 0)
        state = json.loads((directory / "state.json").read_text())
        first, second = state["trajectories"]
        self.assertEqual((first["status"], second["status"]), ("failed", "done"))
        self.assertIn("worker_not_complete", first["error"])
        self.assertEqual(first["stagesDone"], ["summary"])
        self.assertEqual(state["phase"], "done")

    def test_missing_sessions_fail_the_run_with_a_reason(self):
        directory = self.start([{"source": "claude", "id": "gone"}])
        self.assertEqual(self.execute(directory), 1)
        state = json.loads((directory / "state.json").read_text())
        self.assertEqual((state["phase"], state["error"]), ("failed", "no_sessions_found"))

    def test_payloads_for_a_finished_trajectory(self):
        self.claude_file("a.jsonl", claude_session(str(self.work), "a", "Please fix a"))
        directory = self.start([{"source": "claude", "id": "a"}])
        self.execute(directory)
        result = OXY.payloads(directory, 1)
        self.assertEqual(set(result), {"humanize", "redaction"})
        self.assertEqual(result["redaction"]["stage"], "redaction")
        self.assertEqual(result["redaction"]["projectName"], "work")
        self.assertEqual(result["redaction"]["sourcePath"], "run-r1-trajectory-001-redacted")
        self.assertEqual(result["redaction"]["protocolVersion"], 9)
        self.assertIn("Check the export", result["humanize"]["insightMarkdown"])

    def test_state_file_is_private(self):
        self.claude_file("a.jsonl", claude_session(str(self.work), "a", "Please fix a"))
        directory = self.start([{"source": "claude", "id": "a"}])
        self.execute(directory)
        self.assertEqual((directory / "state.json").stat().st_mode & 0o777, 0o600)
        self.assertEqual((directory / "trajectories").stat().st_mode & 0o777, 0o700)


if __name__ == "__main__":
    unittest.main()


# ---------------------------------------------------------------------------
# Cross-session insight jobs over a submission's export

FIXTURES = load("review_export_fixtures",
                TOOLS.parent / "skills/oxygen-cross-session-generation/tests/test_review_exports.py")

CROSS_CARDS = """# C001

Title: Check the claim against independent evidence
Type: agent
Description: Use when a reported outcome needs independent verification.
Workflow: Compare the reported outcome with separately recorded observations.
Example: S001 and S002 each recorded a separate unresolved verification step.
Evidence: S001:L002, S002:L002
"""


def write_submission(root, episodes):
    """A submission folder whose export holds one completed review per (suffix, source, episode)."""
    export = root / "export"
    entries = []
    for suffix, source, episode in episodes:
        review = FIXTURES.make_review(review_id="review-" + suffix, source_path=source, episode=episode)
        approval = FIXTURES.approval_for(review)
        FIXTURES.write_export(export / suffix, review, approval)
        entries.append(FIXTURES.collection_entry(suffix, review, approval))
    FIXTURES.write_manifest(export, entries)
    return export


class FakeCrossWorkers:
    """Reads every indexed file through the frozen helper and writes stage outputs, without a model."""

    mode = "complete"

    def __init__(self, host, workdir):
        self.host = host
        self.workdir = workdir
        self.counter = 0
        self.calls = []
        self.unfinished = {}
        self.stopped = False

    def reserve_id(self):
        self.counter += 1
        return f"fake-{self.counter}"

    def stop(self, worker_id=None):
        self.stopped = True

    def adapters_for(self, cwd, *, label, tools, key):
        results = {}

        async def dispatch(args, worker_id=None):
            state = json.loads((cwd / "state.json").read_text())
            current = state if key == "synthesis" else state["humanize"]
            self.calls.append({"stage": key, "args": args, "tools": tools, "label": label(args),
                               "recordedFirst": current == {**current, "status": "running", "workerId": worker_id}})
            helper = cwd / "protocol/scripts/cross_session.py"
            if key == "synthesis":
                index = json.loads((cwd / "reading/index.json").read_text())
                for source in index["sources"]:
                    for item in source["files"]:
                        subprocess.run([sys.executable, str(helper), "read", str(cwd), "--file", item["path"],
                                        "--limit", str(max(4, item["bytes"]))], check=True, capture_output=True)
                cards = "# C001\n\nTitle: Missing fields\n" if self.mode == "bad_cards" else CROSS_CARDS
                (cwd / "cross_session_insights.md").write_text(cards)
                (cwd / "completion.json").write_text('{"status": "complete", "readingComplete": true}')
            else:
                (cwd / "humanize/cross_session_insights.md").write_bytes(
                    (cwd / "cross_session_insights.md").read_bytes())
                (cwd / "humanize/completion.json").write_text('{"status": "complete", "readingComplete": true}')
            failed = self.mode == "fail_synthesis" and key == "synthesis"
            results[worker_id] = {"status": "error"} if failed else {"status": "complete"}
            if failed:
                self.unfinished[key] = "final message: gave up"
            return worker_id

        async def wait(worker_id):
            if self.mode == "cancel":
                os.kill(os.getpid(), signal.SIGTERM)
                await asyncio.sleep(30)
            await asyncio.sleep(0)
            return results[worker_id]

        return dispatch, wait


class CrossSessionJobTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.submission = Path(temporary.name) / "submissions" / "s1"
        self.job = self.submission / "generations" / "j1"
        self.job.mkdir(parents=True)
        FakeCrossWorkers.mode = "complete"
        self.made = []

    def factory(self, host, workdir):
        workers = FakeCrossWorkers(host, workdir)
        self.made.append(workers)
        return workers

    def start(self, *, host="codex", model="gpt-6.1-terra", effort="medium", episodes=None):
        write_submission(self.submission, episodes or [
            ("a", "run/session-a", "The first episode had an unresolved verification step."),
            ("b", "run/session-b", "A separate second episode also needed an independent check.")])
        (self.job / "config.json").write_text(json.dumps(
            {"id": "j1", "submissionId": "s1", "host": host, "model": model, "effort": effort}))
        code = asyncio.run(OXY.cross_session(self.job, self.factory))
        return code, json.loads((self.job / "state.json").read_text())

    def helper_state(self):
        return json.loads((self.job / "run/state.json").read_text())

    def test_both_stages_run_with_the_chosen_model_and_the_result_is_recorded(self):
        code, state = self.start()
        self.assertEqual(code, 0)
        self.assertEqual(state["phase"], "done")
        self.assertEqual(state["stagesDone"], ["synthesis", "humanize"])
        self.assertEqual(state["candidateCount"], 1)
        self.assertEqual(state["counts"]["trajectories"], 2)
        result = json.loads((self.job / state["result"]).read_text())
        self.assertEqual(result["config"]["model"], "gpt-6.1-terra")
        self.assertEqual(result["config"]["reasoning_effort"], "medium")
        calls = self.made[0].calls
        self.assertEqual([call["stage"] for call in calls], ["synthesis", "humanize"])
        self.assertTrue(all(call["recordedFirst"] for call in calls))
        self.assertEqual(calls[0]["args"]["model"], "gpt-6.1-terra")
        self.assertEqual(calls[0]["label"], "cross-session-synthesis")
        helper = self.job / "run/protocol/scripts/cross_session.py"
        self.assertIn(f"Bash({sys.executable} {helper} read *)", calls[0]["tools"])
        self.assertEqual(self.helper_state()["status"], "accepted")

    def test_claude_workers_get_agent_tool_arguments(self):
        code, state = self.start(host="claude", model="opus", effort="")
        self.assertEqual(code, 0, state["error"])
        args = self.made[0].calls[0]["args"]
        self.assertEqual(args["model"], "opus")
        self.assertIn("prompt", args)
        self.assertNotIn("reasoning_effort", args)
        self.assertIsNone(state["effort"])

    def test_unfinished_synthesis_fails_the_job_and_the_helper_run(self):
        FakeCrossWorkers.mode = "fail_synthesis"
        code, state = self.start()
        self.assertEqual(code, 1)
        self.assertEqual(state["phase"], "failed")
        self.assertEqual(state["error"], "synthesis: worker_not_complete: final message: gave up")
        self.assertEqual([call["stage"] for call in self.made[0].calls], ["synthesis"])
        self.assertEqual(self.helper_state()["status"], "failed")

    def test_invalid_cards_fail_acceptance_with_the_helpers_reason(self):
        FakeCrossWorkers.mode = "bad_cards"
        code, state = self.start()
        self.assertEqual(code, 1)
        self.assertTrue(state["error"].startswith("accept: "), state["error"])
        self.assertEqual(self.helper_state()["status"], "failed")

    def test_one_trajectory_cannot_be_generated(self):
        code, state = self.start(episodes=[("a", "run/session-a", "Only one episode.")])
        self.assertEqual(code, 1)
        self.assertIn("insufficient_distinct_trajectories", state["error"])
        self.assertEqual(self.made[0].calls, [])

    def test_cancel_stops_workers_and_gives_up_the_recorded_worker(self):
        FakeCrossWorkers.mode = "cancel"
        code, state = self.start()
        self.assertEqual(code, 130)
        self.assertEqual(state["phase"], "cancelled")
        self.assertTrue(self.made[0].stopped)
        self.assertEqual(self.helper_state()["status"], "failed")

    def test_validate_submission_counts_trajectories_and_refuses_conflicting_copies(self):
        export = write_submission(self.submission, [
            ("a", "run/session-a", "The first episode."), ("b", "run/session-b", "The second episode.")])
        result = OXY.validate_submission(export)
        self.assertEqual(result["counts"]["trajectories"], 2)
        self.assertEqual({item["reviewId"] for item in result["trajectories"]}, {"review-a", "review-b"})
        conflicting = write_submission(Path(self.submission.parent / "s2"), [
            ("a", "run/session-a", "One version."), ("c", "run/session-a", "Another version.")])
        with self.assertRaises(ValueError):
            OXY.validate_submission(conflicting)
        process = subprocess.run([sys.executable, str(TOOLS / "oxygen_run.py"), "validate-submission",
                                  "--dir", str(conflicting)], capture_output=True, text=True)
        self.assertEqual(process.returncode, 1)
        self.assertIn("error", json.loads(process.stderr))
