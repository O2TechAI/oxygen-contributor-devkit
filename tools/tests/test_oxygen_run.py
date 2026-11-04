import asyncio
import importlib.util
import json
import os
from pathlib import Path
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

    def test_long_titles_are_shortened(self):
        path = self.claude_file("l.jsonl", claude_session(str(self.work), "l", "word " * 100))
        title = OXY.first_request(str(path), "claude")
        self.assertLessEqual(len(title), OXY.TITLE_LENGTH)
        self.assertTrue(title.endswith("…"))


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
        for trajectory in state["trajectories"]:
            self.assertEqual(trajectory["status"], "done")
            self.assertEqual(trajectory["stagesDone"], list(OXY.STAGES))
            self.assertEqual(trajectory["insights"], 1)
            self.assertGreater(trajectory["markdownBytes"], 0)
        manifest = json.loads((directory / "trajectories/trajectory-001.md.oxygen-agents/manifest.json").read_text())
        self.assertEqual(manifest["configuration"]["language"], "zh")
        self.assertEqual(manifest["configuration"]["reasoning_effort"], "low")
        self.assertTrue(manifest["complete"])

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
