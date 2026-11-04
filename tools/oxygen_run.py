#!/usr/bin/env python3
"""Find a contributor's local agent sessions and run the Oxygen pipeline over them.

The Oxygen review app's local service calls these subcommands; each prints JSON.

  workspaces                       projects that have recorded Codex / Claude Code sessions
  sessions --workspace PATH        the sessions of one project
  run --run-dir DIR                convert and process the sessions chosen in DIR/config.json
  payloads --run-dir DIR --index N review payloads for one finished trajectory

Sessions are read from $OXYGEN_CODEX_HOME or $CODEX_HOME (default ~/.codex) and
$OXYGEN_CLAUDE_CONFIG_DIR or $CLAUDE_CONFIG_DIR (default ~/.claude). The workers keep
using the CLIs' own login. Only the sessions a contributor selects are copied into the
run directory, and nothing leaves this machine except through the contributor's
own Codex or Claude Code login, which runs the workers.
"""

from __future__ import annotations

import argparse
import asyncio
import functools
import importlib.util
import json
import os
import re
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

TOOLS = Path(__file__).resolve().parent
KIT = TOOLS.parent
AGENTS_SCRIPT = KIT / "skills/oxygen-deterministic-trajectory-agents/scripts/trajectory_agents.py"

MAX_MARKDOWN_BYTES = 2_000_000
WORKER_TIMEOUT_SECONDS = 60 * 60
TITLE_RECORDS = 400
TITLE_LENGTH = 110
SAMPLE_SIZE = 3
STAGES = ("summary", "insight", "humanize", "redaction")


def load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


CODEX = load("oxygen_collect_codex_sessions", TOOLS / "collect_workspace_sessions.py")
CLAUDE = load("oxygen_collect_claude_sessions", TOOLS / "collect_claude_sessions.py")
CollectionError = CODEX.CollectionError


def iso(seconds: float) -> str:
    return datetime.fromtimestamp(seconds, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def oxygen_home() -> Path:
    return Path(os.environ.get("OXYGEN_HOME") or Path.home() / ".oxygen").expanduser()


# ---------------------------------------------------------------------------
# Discovering sessions


def _quiet_manifest() -> dict:
    return {"missing_roots": [], "errors": []}


def scan() -> list[dict]:
    """Every main session on this machine, one entry per (source, session id)."""
    found: dict[tuple[str, str], dict] = {}

    def keep(entry: dict) -> None:
        key = (entry["source"], entry["id"])
        if key not in found or entry["bytes"] > found[key]["bytes"]:
            found[key] = entry

    codex_home = CODEX.normalized(
        os.environ.get("OXYGEN_CODEX_HOME") or os.environ.get("CODEX_HOME") or Path.home() / ".codex")
    for path in CODEX.discover([codex_home / "sessions", codex_home / "archived_sessions"], _quiet_manifest()):
        try:
            with CODEX.open_source(path) as stream:
                info = os.fstat(stream.fileno())
                meta = CODEX.read_metadata(stream, info.st_size)
        except (CollectionError, OSError, ValueError, RecursionError):
            continue
        cwd, identifier, origin = meta.get("cwd"), meta.get("id"), meta.get("source")
        # Sub-agent sessions record a structured source rather than a plain string.
        if not isinstance(origin, str) or origin not in CODEX.MAIN_SOURCES:
            continue
        if not isinstance(identifier, str) or not identifier:
            continue
        if not isinstance(cwd, str) or not cwd or "\x00" in cwd or not Path(cwd).is_absolute():
            continue
        keep({"source": "codex", "id": identifier, "cwd": cwd, "path": str(path), "bytes": info.st_size,
              "started": meta.get("timestamp") or iso(info.st_mtime), "modified": info.st_mtime})

    claude_homes = ([CODEX.normalized(os.environ["OXYGEN_CLAUDE_CONFIG_DIR"])]
                    if os.environ.get("OXYGEN_CLAUDE_CONFIG_DIR") else CLAUDE.default_config_dirs())
    for home in claude_homes:
        for path in CLAUDE.discover([home / "projects"], _quiet_manifest()):
            if "subagents" in path.parts or path.name.startswith("agent-"):
                continue
            try:
                with CODEX.open_source(path) as stream:
                    info = os.fstat(stream.fileno())
                    meta = CLAUDE.read_metadata(stream, info.st_size)
            except (CollectionError, OSError, ValueError, RecursionError):
                continue
            if not meta or meta.get("isSidechain") or meta.get("agentId"):
                continue
            cwd, identifier = meta.get("cwd"), meta.get("sessionId")
            if not isinstance(identifier, str) or not identifier:
                continue
            if not isinstance(cwd, str) or not cwd or "\x00" in cwd or not Path(cwd).is_absolute():
                continue
            keep({"source": "claude", "id": identifier, "cwd": cwd, "path": str(path), "bytes": info.st_size,
                  "started": meta.get("timestamp") or iso(info.st_mtime), "modified": info.st_mtime})
    return list(found.values())


@functools.lru_cache(maxsize=None)
def project_root(cwd: str) -> str:
    """The repository a working directory belongs to, or the directory itself."""
    if Path(cwd).is_dir():
        try:
            result = subprocess.run(["git", "-C", cwd, "rev-parse", "--show-toplevel"],
                                    capture_output=True, text=True, timeout=3)
        except (OSError, subprocess.SubprocessError):
            return cwd
        top = result.stdout.strip()
        if result.returncode == 0 and top:
            return top
    return cwd


def workspaces() -> list[dict]:
    groups: dict[str, dict] = {}
    for session in scan():
        root = project_root(session["cwd"])
        group = groups.setdefault(root, {
            "path": root, "name": Path(root).name or root, "exists": Path(root).is_dir(),
            "sessions": {"codex": 0, "claude": 0}, "lastActivity": "", "bytes": 0,
        })
        group["sessions"][session["source"]] += 1
        group["lastActivity"] = max(group["lastActivity"], iso(session["modified"]))
        group["bytes"] += session["bytes"]
    return sorted(groups.values(), key=lambda group: group["lastActivity"], reverse=True)


def _first_line(text: str) -> str:
    for line in text.strip().splitlines():
        line = line.strip().lstrip("#").strip()
        if line:
            return line if len(line) <= TITLE_LENGTH else line[: TITLE_LENGTH - 1].rstrip() + "…"
    return ""


def _setup_text(text: str) -> bool:
    stripped = text.lstrip()
    return not stripped or stripped.startswith(("<", "# AGENTS.md", "The following is the Codex agent"))


def first_request(path: str, source: str) -> str:
    """The contributor's first real request, used only as a label in the session list."""
    try:
        with open(path, "rb") as stream:
            for _ in range(TITLE_RECORDS):
                raw = stream.readline(4 * 1024 * 1024)
                if not raw:
                    break
                try:
                    row = json.loads(raw)
                except ValueError:
                    continue
                if not isinstance(row, dict):
                    continue
                if source == "codex":
                    payload = row.get("payload")
                    if row.get("type") != "response_item" or not isinstance(payload, dict):
                        continue
                    if payload.get("type") != "message" or payload.get("role") != "user":
                        continue
                    blocks = payload.get("content")
                    texts = [b.get("text", "") for b in blocks if isinstance(b, dict)] if isinstance(blocks, list) else []
                else:
                    if row.get("type") != "user" or row.get("isMeta"):
                        continue
                    content = (row.get("message") or {}).get("content")
                    if isinstance(content, str):
                        texts = [content]
                    elif isinstance(content, list):
                        texts = [b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"]
                    else:
                        continue
                for text in texts:
                    if isinstance(text, str) and not _setup_text(text):
                        return _first_line(text)
    except OSError:
        pass
    return ""


def suggested_sample(count: int) -> list[int]:
    """Early, middle and latest positions among `count` chronologically ordered sessions."""
    if count <= SAMPLE_SIZE:
        return list(range(count))
    return [0, count // 2, count - 1]


def workspace_sessions(workspace: str) -> list[dict]:
    root = str(Path(workspace).expanduser())
    members = sorted((s for s in scan() if project_root(s["cwd"]) == root), key=lambda s: s["started"])
    chosen = set(suggested_sample(len(members)))
    return [{
        "source": s["source"], "id": s["id"], "started": s["started"], "bytes": s["bytes"],
        "title": first_request(s["path"], s["source"]), "suggested": index in chosen,
    } for index, s in enumerate(members)]


# ---------------------------------------------------------------------------
# Run state


class State:
    """The run's progress, written atomically for the local service to read."""

    def __init__(self, directory: Path, config: dict):
        self.path = directory / "state.json"
        self.data = {
            "id": config["id"], "workspace": config["workspace"],
            "workspaceName": Path(config["workspace"]).name or config["workspace"],
            "language": config["language"], "host": config["host"], "model": config["model"],
            "effort": config["effort"], "concurrency": config["concurrency"],
            "createdAt": config.get("createdAt") or iso(time.time()),
            "startedAt": iso(time.time()), "finishedAt": None, "pid": os.getpid(),
            "heartbeat": time.time(), "phase": "preparing", "error": None, "trajectories": [],
        }

    def save(self) -> None:
        self.data["heartbeat"] = time.time()
        temporary = self.path.with_name(".state.tmp")
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(self.data, stream, ensure_ascii=False)
        os.replace(temporary, self.path)

    def set(self, **changes) -> None:
        self.data.update(changes)
        self.save()

    def trajectory(self, index: int) -> dict:
        return self.data["trajectories"][index]

    def change(self, index: int, **changes) -> None:
        self.data["trajectories"][index].update(changes)
        self.save()


# ---------------------------------------------------------------------------
# Workers: headless Codex / Claude Code processes standing in for spawned agents

# Claude Code has no operating-system sandbox here, so its shell access is limited to
# reading helpers and the run's own label script. Codex runs in its workspace sandbox.
CLAUDE_READ_ONLY_SHELL = ["Bash(wc *)", "Bash(head *)", "Bash(tail *)", "Bash(cut *)", "Bash(sed -n *)"]


def claude_tools(run: Path) -> list[str]:
    label = run / "protocol" / "label_summary_lines.py"
    interpreters = dict.fromkeys(["python3", sys.executable])
    return ["Read", "Write", "Edit", "Bash(chmod 600 *)",
            *[f"Bash({interpreter} {label} *)" for interpreter in interpreters],
            *CLAUDE_READ_ONLY_SHELL]


class WorkerError(Exception):
    pass


def failure_text(out: bytes, err: bytes) -> str:
    """A short reason for a worker that exited with an error."""
    text = err.decode("utf-8", "replace").strip()
    if not text:
        text = out.decode("utf-8", "replace").strip()
        try:
            text = str(json.loads(text).get("result") or text)
        except (ValueError, AttributeError):
            pass
    return " ".join(text.split("\n")[-3:])[:300]


class Workers:
    def __init__(self, host: str, workdir: Path):
        self.host = host
        self.workdir = workdir
        self.live: dict[str, asyncio.subprocess.Process] = {}
        self.counter = 0

    def adapters(self, source: Path):
        run = Path(str(source) + ".oxygen-agents")
        pending: dict[str, tuple[asyncio.subprocess.Process, asyncio.Task, Path]] = {}

        async def dispatch(args: dict) -> str:
            self.counter += 1
            worker_id = f"{self.host}-{os.getpid()}-{self.counter}"
            last = self.workdir / f"{worker_id}.last.txt"
            if self.host == "codex":
                command = [os.environ.get("OXYGEN_CODEX_BIN", "codex"), "exec", "--ephemeral",
                           "--skip-git-repo-check", "--ignore-rules", "--sandbox", "workspace-write",
                           "--model", args["model"], "-c",
                           f"model_reasoning_effort={json.dumps(args['reasoning_effort'])}",
                           "-o", str(last), "-C", str(run), "-"]
                prompt = args["message"]
                environment = os.environ.copy()
            else:
                command = [os.environ.get("OXYGEN_CLAUDE_BIN", "claude"), "-p", "--model", args["model"],
                           "--no-session-persistence", "--output-format", "json",
                           "--allowedTools", *claude_tools(run), "--disallowedTools", "WebFetch", "WebSearch", "Agent",
                           "--add-dir", str(run), "--disable-slash-commands", "--strict-mcp-config", "--no-chrome"]
                if args.get("reasoning_effort"):
                    command[4:4] = ["--effort", args["reasoning_effort"]]
                prompt = args["prompt"]
                environment = {**os.environ, "CLAUDE_CODE_DISABLE_CLAUDE_MDS": "1",
                               "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "1"}
            process = await asyncio.create_subprocess_exec(
                *command, cwd=str(run), env=environment, start_new_session=True,
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            self.live[worker_id] = process
            pending[worker_id] = (process, asyncio.create_task(process.communicate(prompt.encode())), last)
            return worker_id

        async def wait(worker_id: str) -> dict:
            process, task, last = pending.pop(worker_id)
            try:
                try:
                    out, err = await asyncio.wait_for(asyncio.shield(task), WORKER_TIMEOUT_SECONDS)
                except asyncio.TimeoutError:
                    self.stop(worker_id)
                    raise WorkerError("worker_timed_out")
                if process.returncode != 0:
                    raise WorkerError(f"worker_exited_{process.returncode}: {failure_text(out, err)}")
                text = out.decode("utf-8", "replace")
                if self.host == "codex":
                    text = last.read_text(encoding="utf-8") if last.exists() else ""
                else:
                    envelope = json.loads(text)
                    if envelope.get("is_error"):
                        raise WorkerError("worker_reported_error: " + str(envelope.get("result", ""))[:300])
                    text = str(envelope.get("result", ""))
                found = re.findall(r"\{[^{}]*\"status\"[^{}]*\}", text)
                return json.loads(found[-1]) if found else {"status": "error"}
            finally:
                self.live.pop(worker_id, None)
                last.unlink(missing_ok=True)

        return dispatch, wait

    def stop(self, worker_id: str | None = None) -> None:
        for key, process in list(self.live.items()):
            if worker_id in (None, key) and process.returncode is None:
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except (ProcessLookupError, PermissionError):
                    pass


# ---------------------------------------------------------------------------
# The run


def freeze(session: dict, snapshots: Path) -> Path:
    module = CODEX if session["source"] == "codex" else CLAUDE
    path = Path(session["path"])
    with CODEX.open_source(path) as stream:
        initial = os.fstat(stream.fileno())
        meta = module.read_metadata(stream, initial.st_size)
        target, _, _ = module.freeze_source(stream, path, initial, meta, snapshots)
    return target


async def convert(session: dict, snapshot: Path, output: Path) -> int:
    """Write the stripped transcript and return the Markdown size."""
    script = "strip_tool_outputs.py" if session["source"] == "codex" else "strip_claude_tool_outputs.py"
    stem = output.with_suffix("")
    process = await asyncio.create_subprocess_exec(
        sys.executable, str(TOOLS / script), str(snapshot),
        "--output", f"{stem}.jsonl", "--markdown", str(output), "--report", f"{stem}.strip.json",
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
    _, err = await process.communicate()
    if process.returncode != 0:
        reason = err.decode("utf-8", "replace").strip().split("\n")[-1][:200]
        raise WorkerError(f"conversion_failed: {reason}")
    return output.stat().st_size


def stage_numbers(directory: Path) -> dict:
    try:
        manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
        outputs = manifest["stages"]["redaction"]["outputs"]
        return {"insights": outputs["insights"], "summaryLines": outputs["summary_lines"]}
    except (OSError, ValueError, KeyError):
        return {}


async def run(directory: Path, workers_factory=Workers) -> int:
    config = json.loads((directory / "config.json").read_text(encoding="utf-8"))
    agents = load("oxygen_trajectory_agents", AGENTS_SCRIPT)
    state = State(directory, config)
    state.save()
    loop = asyncio.get_running_loop()
    workers = workers_factory(config["host"], directory)
    cancelled = False

    def cancel() -> None:
        nonlocal cancelled
        cancelled = True
        workers.stop()
        for task in asyncio.all_tasks(loop):
            if task is not asyncio.current_task() and getattr(task, "_oxygen_job", False):
                task.cancel()

    for name in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(name, cancel)

    async def beat() -> None:
        while True:
            await asyncio.sleep(5)
            state.save()

    heartbeat = asyncio.create_task(beat())
    try:
        lookup = {(s["source"], s["id"]): s for s in scan()}
        chosen = [lookup[(item["source"], item["id"])] for item in config["sessions"]
                  if (item["source"], item["id"]) in lookup]
        chosen.sort(key=lambda s: s["started"])
        state.data["trajectories"] = [{
            "index": number, "source": s["source"], "sessionId": s["id"], "startedAt": s["started"],
            "title": first_request(s["path"], s["source"]), "bytes": s["bytes"], "status": "queued",
            "stage": None, "stagesDone": [], "stageSeconds": {}, "stageStartedAt": None,
            "startedRunAt": None, "finishedAt": None, "error": None,
        } for number, s in enumerate(chosen, 1)]
        state.save()
        if not chosen:
            state.set(phase="failed", error="no_sessions_found", finishedAt=iso(time.time()))
            return 1

        collection = directory / "collection"
        snapshots = collection / "snapshots"
        trajectories = directory / "trajectories"
        for path in (collection, snapshots, trajectories):
            path.mkdir(mode=0o700, exist_ok=True)

        markdown: dict[int, Path] = {}
        for index, session in enumerate(chosen):
            if cancelled:
                break
            state.change(index, status="converting")
            try:
                snapshot = freeze(session, snapshots)
                target = trajectories / f"trajectory-{index + 1:03d}.md"
                size = await convert(session, snapshot, target)
                if size >= MAX_MARKDOWN_BYTES:
                    raise WorkerError("transcript_larger_than_2mb")
                markdown[index] = target
                state.change(index, status="queued", markdownBytes=size)
            except (WorkerError, CollectionError, OSError, ValueError) as error:
                state.change(index, status="skipped", error=str(error)[:300])

        if cancelled:
            raise asyncio.CancelledError
        state.set(phase="generating")
        semaphore = asyncio.Semaphore(config["concurrency"])

        async def process(index: int) -> None:
            source = markdown[index]
            async with semaphore:
                state.change(index, status="running", startedRunAt=iso(time.time()))
                dispatch, wait = workers.adapters(source)
                started = {}

                def note(stage: str, event: str) -> None:
                    trajectory = state.trajectory(index)
                    if event == "started":
                        started[stage] = time.time()
                        state.change(index, stage=stage, stageStartedAt=iso(started[stage]))
                    else:
                        trajectory["stagesDone"].append(stage)
                        trajectory["stageSeconds"][stage] = round(time.time() - started.get(stage, time.time()))
                        state.save()

                try:
                    await agents.orchestrate(
                        source, dispatch, wait, redact=True, host=config["host"], model=config["model"],
                        effort=config["effort"], language=config["language"], progress=note)
                except (agents.RunError, WorkerError, OSError, ValueError, KeyError) as error:
                    state.change(index, status="failed", error=str(error)[:300], finishedAt=iso(time.time()))
                    return
                state.change(index, status="done", stage=None, finishedAt=iso(time.time()),
                             **stage_numbers(Path(str(source) + ".oxygen-agents")))

        jobs = [asyncio.create_task(process(index)) for index in markdown]
        for job in jobs:
            job._oxygen_job = True
        await asyncio.gather(*jobs, return_exceptions=True)
        if cancelled:
            raise asyncio.CancelledError
        done = sum(1 for t in state.data["trajectories"] if t["status"] == "done")
        state.set(phase="done" if done else "failed", finishedAt=iso(time.time()),
                  error=None if done else "no_trajectory_finished")
        return 0 if done else 1
    except asyncio.CancelledError:
        for trajectory in state.data["trajectories"]:
            if trajectory["status"] in {"queued", "converting", "running"}:
                trajectory.update(status="cancelled", stage=None)
        state.set(phase="cancelled", finishedAt=iso(time.time()))
        return 130
    except Exception as error:  # the service reads this; never leave a run looking active
        state.set(phase="failed", error=f"{type(error).__name__}: {str(error)[:200]}", finishedAt=iso(time.time()))
        return 1
    finally:
        heartbeat.cancel()


# ---------------------------------------------------------------------------
# Review payloads


def payloads(directory: Path, index: int) -> dict:
    config = json.loads((directory / "config.json").read_text(encoding="utf-8"))
    publisher = load("oxygen_publish_review", TOOLS / "publish-review.py")
    run_dir = directory / "trajectories" / f"trajectory-{index:03d}.md.oxygen-agents"
    project = Path(config["workspace"]).name or "project"
    result = {}
    for stage, label in (("humanize", "humanized"), ("redaction", "redacted")):
        arguments = SimpleNamespace(
            run_dir=run_dir, stage=stage, project=project,
            source=f"run-{config['id']}-trajectory-{index:03d}-{label}")
        result[stage] = publisher.v5_payload(arguments)
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("workspaces")
    listing = commands.add_parser("sessions")
    listing.add_argument("--workspace", required=True)
    start = commands.add_parser("run")
    start.add_argument("--run-dir", required=True, type=Path)
    review = commands.add_parser("payloads")
    review.add_argument("--run-dir", required=True, type=Path)
    review.add_argument("--index", required=True, type=int)
    args = parser.parse_args(argv)
    try:
        if args.command == "workspaces":
            print(json.dumps({"workspaces": workspaces()}, ensure_ascii=False))
        elif args.command == "sessions":
            print(json.dumps({"sessions": workspace_sessions(args.workspace)}, ensure_ascii=False))
        elif args.command == "payloads":
            print(json.dumps(payloads(args.run_dir, args.index), ensure_ascii=False))
        else:
            return asyncio.run(run(args.run_dir))
    except (OSError, ValueError, KeyError) as error:
        print(json.dumps({"error": f"{type(error).__name__}: {str(error)[:200]}"}), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
