#!/usr/bin/env python3
"""Find a contributor's local agent sessions and run the Oxygen pipeline over them.

The Oxygen review app's local service calls these subcommands; each prints JSON.

  workspaces                       projects that have recorded Codex / Claude Code sessions
  sessions --workspace PATH        the sessions of one project
  run --run-dir DIR                convert and process the sessions chosen in DIR/config.json
  payloads --run-dir DIR --index N review payloads for one finished trajectory
  session-names --session SRC:ID   the agents' own titles for sessions (Codex thread names,
                                   Claude Code session titles)
  validate-submission --dir DIR    check a submission's export as the cross-session helper will
  cross-session --job-dir DIR      generate cross-session insights from a submission's export

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
import hashlib
import importlib.util
import json
import mmap
import os
import random
import re
import signal
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

TOOLS = Path(__file__).resolve().parent
KIT = TOOLS.parent
AGENTS_SCRIPT = KIT / "skills/oxygen-deterministic-trajectory-agents/scripts/trajectory_agents.py"
CROSS_SKILL = KIT / "skills/oxygen-cross-session-generation/scripts"
CROSS_SCRIPT = CROSS_SKILL / "cross_session.py"
CROSS_TIMEOUT_SECONDS = 3 * 60 * 60
CROSS_STAGES = ("synthesis", "humanize")

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


def _session(source: str, identifier: str, files: list[dict], path: dict, bytes_: int) -> dict:
    return {"source": source, "id": identifier, "cwd": files[0]["cwd"], "path": str(path["path"]),
            "paths": [str(f["path"]) for f in files], "bytes": bytes_,
            "started": min(f["started"] for f in files), "modified": max(f["modified"] for f in files)}


def _codex_home() -> Path:
    return CODEX.normalized(
        os.environ.get("OXYGEN_CODEX_HOME") or os.environ.get("CODEX_HOME") or Path.home() / ".codex")


def scan() -> list[dict]:
    """Every main session on this machine, one entry per (source, session id).

    A session can span several files. Each time Codex resumes a thread it writes a new
    rollout with the same id holding only the new turns, so the session is all of its
    rollouts in order. Claude Code instead gives a resumed or forked conversation a new
    file that starts with a copy of the history; those files share the first record's
    session id and are merged by record when the session is frozen.
    """
    codex: dict[str, dict[str, dict]] = {}
    claude: dict[str, list[dict]] = {}
    headers = _Headers()

    codex_home = _codex_home()
    for path in CODEX.discover([codex_home / "sessions", codex_home / "archived_sessions"], _quiet_manifest()):
        meta, info = headers.read(path, "codex")
        if not meta:
            continue
        cwd, identifier, origin = meta.get("cwd"), meta.get("id"), meta.get("source")
        # Sub-agent sessions record a structured source rather than a plain string.
        if not isinstance(origin, str) or origin not in CODEX.MAIN_SOURCES:
            continue
        if not isinstance(identifier, str) or not identifier:
            continue
        if not isinstance(cwd, str) or not cwd or "\x00" in cwd or not Path(cwd).is_absolute():
            continue
        # A rollout can exist both plain and compressed while Codex compresses it; keep one.
        name = path.name.removesuffix(".zst")
        segments = codex.setdefault(identifier, {})
        if name in segments and not CODEX.is_compressed(segments[name]["path"]):
            continue
        segments[name] = {"path": path, "cwd": cwd, "bytes": info.st_size,
                          "started": meta.get("timestamp") or iso(info.st_mtime), "modified": info.st_mtime}

    claude_homes = ([CODEX.normalized(os.environ["OXYGEN_CLAUDE_CONFIG_DIR"])]
                    if os.environ.get("OXYGEN_CLAUDE_CONFIG_DIR") else CLAUDE.default_config_dirs())
    for home in claude_homes:
        for path in CLAUDE.discover([home / "projects"], _quiet_manifest()):
            if "subagents" in path.parts or path.name.startswith("agent-"):
                continue
            meta, info = headers.read(path, "claude")
            if not meta or meta.get("isSidechain") or meta.get("agentId"):
                continue
            cwd, identifier = meta.get("cwd"), meta.get("sessionId")
            if not isinstance(identifier, str) or not identifier:
                continue
            if not isinstance(cwd, str) or not cwd or "\x00" in cwd or not Path(cwd).is_absolute():
                continue
            claude.setdefault(identifier, []).append({
                "path": path, "cwd": cwd, "bytes": info.st_size,
                "started": meta.get("timestamp") or iso(info.st_mtime), "modified": info.st_mtime})

    found = []
    for identifier, segments in codex.items():
        # Rollout names start with their creation time, so name order is resume order.
        files = [segments[name] for name in sorted(segments)]
        found.append(_session("codex", identifier, files, files[0], sum(f["bytes"] for f in files)))
    for identifier, files in claude.items():
        # The session's own file first; copies of its history overlap, so size is the largest file.
        files.sort(key=lambda f: (f["path"].stem != identifier, str(f["path"])))
        largest = max(files, key=lambda f: f["bytes"])
        found.append(_session("claude", identifier, files, largest, largest["bytes"]))
    headers.save()
    return found


class _Headers:
    """Each session file's identity record, cached in OXYGEN_HOME by size, mtime and inode.

    Codex keeps every rollout, so a store holds thousands of files; opening each one is
    slow on network home directories while stat is not.
    """

    CODEX_KEYS = ("id", "cwd", "source", "timestamp")

    def __init__(self):
        self.path = oxygen_home() / "cache" / "session-headers.json"
        try:
            self.cached = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            self.cached = {}
        if not isinstance(self.cached, dict):
            self.cached = {}
        self.fresh: dict[str, dict] = {}

    def read(self, path: Path, kind: str):
        try:
            info = path.stat(follow_symlinks=False)
        except OSError:
            return None, None
        key = [kind, info.st_size, info.st_mtime_ns, info.st_ino]
        hit = self.cached.get(str(path))
        if isinstance(hit, dict) and hit.get("key") == key:
            meta = hit.get("meta")
        else:
            try:
                with CODEX.open_source(path) as stream:
                    size = os.fstat(stream.fileno()).st_size
                    if kind == "codex":
                        full = CODEX.read_source_metadata(stream, path, size)
                        meta = {name: full.get(name) for name in self.CODEX_KEYS}
                    else:
                        meta = CLAUDE.read_metadata(stream, size)
            except CollectionError as error:
                if str(error) == "zstd_unavailable":
                    return None, info  # Not cached: it may be readable once a decoder is installed.
                meta = None
            except (OSError, ValueError, RecursionError):
                meta = None
        self.fresh[str(path)] = {"key": key, "meta": meta}
        return meta, info

    def save(self) -> None:
        if self.fresh == self.cached:
            return
        try:
            self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            fd, temp_name = tempfile.mkstemp(prefix=".headers-", dir=self.path.parent)
        except OSError:
            return
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                json.dump(self.fresh, stream, ensure_ascii=False)
            os.replace(temp_name, self.path)
        except OSError:
            Path(temp_name).unlink(missing_ok=True)


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
        with CODEX.open_records(Path(path)) as stream:
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
    except (CollectionError, OSError):
        pass
    return ""


def _claude_title(paths: list[str]) -> str:
    """The latest title Claude Code recorded for a session (`custom-title` records)."""
    title = ""
    for path in paths:
        try:
            with CODEX.open_records(Path(path)) as stream:
                for raw in stream:
                    if b'"custom-title"' not in raw:
                        continue
                    try:
                        row = json.loads(raw)
                    except ValueError:
                        continue
                    if isinstance(row, dict) and row.get("type") == "custom-title":
                        value = row.get("customTitle")
                        if isinstance(value, str) and value.strip():
                            title = value
        except (CollectionError, OSError):
            continue
        if title:
            break  # the session's own file comes first; copies only repeat its history
    return title


def session_names(pairs: list[tuple[str, str]]) -> dict[str, str]:
    """The agents' own names for sessions, keyed "source:id": the Codex thread name from
    session_index.jsonl and the Claude Code session title. The latest entry wins; sessions
    without one are left out. Only shown locally as labels."""
    names: dict[str, str] = {}
    codex = {identifier for source, identifier in pairs if source == "codex"}
    if codex:
        try:
            with open(_codex_home() / "session_index.jsonl", encoding="utf-8", errors="replace") as stream:
                for line in stream:
                    try:
                        row = json.loads(line)
                    except ValueError:
                        continue
                    if not isinstance(row, dict) or row.get("id") not in codex:
                        continue
                    name = _first_line(str(row.get("thread_name") or ""))
                    if name:
                        names[f"codex:{row['id']}"] = name
        except OSError:
            pass
    claude = {identifier for source, identifier in pairs if source == "claude"}
    if claude:
        # A session's own file is named by its id, so no scan of every session is needed.
        homes = ([CODEX.normalized(os.environ["OXYGEN_CLAUDE_CONFIG_DIR"])]
                 if os.environ.get("OXYGEN_CLAUDE_CONFIG_DIR") else CLAUDE.default_config_dirs())
        for identifier in claude:
            if not re.fullmatch(r"[A-Za-z0-9._:-]{1,128}", identifier):
                continue
            paths = [str(path) for home in homes for path in sorted((home / "projects").glob(f"*/{identifier}.jsonl"))]
            name = _first_line(_claude_title(paths))
            if name:
                names[f"claude:{identifier}"] = name
    return names


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


class StateFile:
    """Progress written atomically, with a heartbeat, for the local service to read."""

    def __init__(self, path: Path, data: dict):
        self.path = path
        self.data = data

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


class State(StateFile):
    """The run's progress."""

    def __init__(self, directory: Path, config: dict):
        super().__init__(directory / "state.json", {
            "id": config["id"], "workspace": config["workspace"],
            "workspaceName": Path(config["workspace"]).name or config["workspace"],
            "language": config["language"], "host": config["host"], "model": config["model"],
            "effort": config["effort"], "concurrency": config["concurrency"],
            "createdAt": config.get("createdAt") or iso(time.time()),
            "startedAt": iso(time.time()), "finishedAt": None, "pid": os.getpid(),
            "heartbeat": time.time(), "phase": "preparing", "error": None, "trajectories": [],
        })

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
    helpers = [run / "protocol" / name for name in ("label_summary_lines.py", "read_source.py")]
    interpreters = dict.fromkeys(["python3", sys.executable])
    return ["Read", "Write", "Edit", "Bash(chmod 600 *)",
            *[f"Bash({interpreter} {helper} *)" for helper in helpers for interpreter in interpreters],
            *CLAUDE_READ_ONLY_SHELL]


def cross_session_tools(run: Path) -> list[str]:
    """Claude Code allowlist for a cross-session worker: the run's frozen read and check commands."""
    helper = run / "protocol" / "scripts" / "cross_session.py"
    interpreters = dict.fromkeys(["python3", sys.executable])
    return ["Read", "Write", "Edit", "Bash(chmod 600 *)",
            *[f"Bash({interpreter} {helper} {command} *)"
              for command in ("read", "check") for interpreter in interpreters],
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


def stage_of(args: dict) -> str:
    """The stage a dispatch is for: Codex calls name it in task_name, Claude calls in description."""
    if "task_name" in args:  # oxygen_<stage>_<tag>
        parts = str(args["task_name"]).split("_")
        return parts[1] if len(parts) > 1 else parts[0]
    words = str(args.get("description", "")).split()  # Oxygen <stage> <tag>
    return words[1] if len(words) > 1 else "worker"


def _tail(data: bytes | str, limit: int = 200) -> str:
    text = data.decode("utf-8", "replace") if isinstance(data, bytes) else data
    return " ".join(text.split())[-limit:]


class Workers:
    # Network home directories (NFS) refuse a contended file lock with ENOLCK instead of
    # waiting, and Codex takes one in its home while starting, so parallel starts can fail.
    LOCK_ERRORS = ("No locks available", "os error 37")
    STARTUP_RETRIES = 4

    def __init__(self, host: str, workdir: Path, timeout: int = WORKER_TIMEOUT_SECONDS):
        self.host = host
        self.workdir = workdir
        self.timeout = timeout
        self.logs = workdir / "logs"
        self.live: dict[str, asyncio.subprocess.Process] = {}
        self.counter = 0
        # Why the latest worker for a transcript ended without completing, for the run state.
        self.unfinished: dict[str, str] = {}

    def _save(self, name: str, out: bytes, err: bytes, last: str) -> None:
        """Keep each worker's output in the run's private logs folder."""
        self.logs.mkdir(mode=0o700, exist_ok=True)
        for suffix, data in ((".stdout", out), (".stderr", err), (".last.txt", last.encode("utf-8"))):
            fd = os.open(self.logs / (name + suffix), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "wb") as stream:
                stream.write(data)

    def reserve_id(self) -> str:
        """A worker ID, known before the worker starts so it can be recorded first."""
        self.counter += 1
        return f"{self.host}-{os.getpid()}-{self.counter}"

    def adapters(self, source: Path):
        """Dispatch/wait for the per-trajectory stages of one transcript."""
        run = Path(str(source) + ".oxygen-agents")
        return self.adapters_for(run, label=lambda args: f"{source.stem}-{stage_of(args)}",
                                 tools=claude_tools(run), key=source.name)

    def adapters_for(self, cwd: Path, *, label, tools: list[str], key: str):
        """Dispatch/wait for workers that run in `cwd`; `label(args)` names their logs,
        `tools` is the Claude Code allowlist and `key` files the reason a worker did not finish."""
        pending: dict[str, tuple] = {}

        async def start(worker_id: str, command: list[str], environment: dict, prompt: str):
            process = await asyncio.create_subprocess_exec(
                *command, cwd=str(cwd), env=environment, start_new_session=True,
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            self.live[worker_id] = process
            return process, asyncio.create_task(process.communicate(prompt.encode()))

        async def dispatch(args: dict, worker_id: str | None = None) -> str:
            worker_id = worker_id or self.reserve_id()
            last = self.workdir / f"{worker_id}.last.txt"
            name = f"{label(args)}-{worker_id}"
            if self.host == "codex":
                command = [os.environ.get("OXYGEN_CODEX_BIN", "codex"), "exec", "--ephemeral",
                           "--skip-git-repo-check", "--ignore-rules", "--sandbox", "workspace-write",
                           "--model", args["model"], "-c",
                           f"model_reasoning_effort={json.dumps(args['reasoning_effort'])}",
                           "-o", str(last), "-C", str(cwd), "-"]
                prompt = args.get("message") or args["prompt"]
                environment = os.environ.copy()
            else:
                command = [os.environ.get("OXYGEN_CLAUDE_BIN", "claude"), "-p", "--model", args["model"],
                           "--no-session-persistence", "--output-format", "json",
                           "--allowedTools", *tools, "--disallowedTools", "WebFetch", "WebSearch", "Agent",
                           "--add-dir", str(cwd), "--disable-slash-commands", "--strict-mcp-config", "--no-chrome"]
                if args.get("reasoning_effort"):
                    command[4:4] = ["--effort", args["reasoning_effort"]]
                prompt = args.get("prompt") or args["message"]
                environment = {**os.environ, "CLAUDE_CODE_DISABLE_CLAUDE_MDS": "1",
                               "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "1"}
            process, task = await start(worker_id, command, environment, prompt)
            pending[worker_id] = (process, task, last, name, (worker_id, command, environment, prompt))
            return worker_id

        async def wait(worker_id: str) -> dict:
            process, task, last, name, launch = pending.pop(worker_id)
            try:
                for attempt in range(self.STARTUP_RETRIES + 1):
                    try:
                        out, err = await asyncio.wait_for(asyncio.shield(task), self.timeout)
                    except asyncio.TimeoutError:
                        self.stop(worker_id)
                        raise WorkerError("worker_timed_out")
                    reason = failure_text(out, err) if process.returncode else ""
                    if attempt == self.STARTUP_RETRIES or not any(text in reason for text in self.LOCK_ERRORS):
                        break
                    await asyncio.sleep(random.uniform(2, 6) * (attempt + 1))
                    process, task = await start(*launch)
                text = out.decode("utf-8", "replace")
                if self.host == "codex":
                    text = last.read_text(encoding="utf-8") if last.exists() else ""
                self._save(name, out, err, text)
                if process.returncode != 0:
                    raise WorkerError(f"worker_exited_{process.returncode}: {reason}")
                if self.host != "codex":
                    envelope = json.loads(text)
                    if envelope.get("is_error"):
                        raise WorkerError("worker_reported_error: " + str(envelope.get("result", ""))[:300])
                    text = str(envelope.get("result", ""))
                found = re.findall(r"\{[^{}]*\"status\"[^{}]*\}", text)
                result = json.loads(found[-1]) if found else {"status": "error"}
                if result.get("status") != "complete":
                    why = f"final message: {_tail(text)}" if text.strip() else f"no final message; stderr: {_tail(err)}"
                    self.unfinished[key] = f"{why} (logs/{name}.*)"
                return result
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
    paths = [Path(path) for path in session.get("paths") or [session["path"]]]
    if len(paths) == 1 and not CODEX.is_compressed(paths[0]):
        with CODEX.open_source(paths[0]) as stream:
            initial = os.fstat(stream.fileno())
            meta = module.read_metadata(stream, initial.st_size)
            target, _, _ = module.freeze_source(stream, paths[0], initial, meta, snapshots)
        return target
    return _freeze_merged(session, paths, snapshots)


def _own_start(path: Path, identifier: str) -> str | None:
    """When a Claude Code file's own records begin (its copied history comes first)."""
    marker = re.compile(rb'"sessionId":\s*"' + re.escape(identifier.encode()) + rb'"')
    try:
        with open(path, "rb") as stream, mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ) as data:
            match = marker.search(data)
            if match is None:
                return None
            at = match.start()
            start, end = data.rfind(b"\n", 0, at) + 1, data.find(b"\n", at)
            row = json.loads(data[start:end if end >= 0 else len(data)])
    except (OSError, ValueError):
        return None
    timestamp = row.get("timestamp") if isinstance(row, dict) else None
    return timestamp if isinstance(timestamp, str) else None


def _record_key(line: bytes) -> bytes:
    """Claude Code records carry a uuid that survives being copied into a resumed file."""
    try:
        row = json.loads(line)
    except ValueError:
        row = None
    if isinstance(row, dict) and isinstance(row.get("uuid"), str) and row["uuid"]:
        return b"uuid:" + row["uuid"].encode()
    return b"line:" + hashlib.sha256(line).digest()


def _freeze_merged(session: dict, paths: list[Path], snapshots: Path) -> Path:
    """Freeze a session stored in several files as one snapshot.

    Codex rollouts of one thread are concatenated in resume order. Claude Code files of one
    conversation are written one after another, the session's own file first and then each
    resumed or forked file in the order its own records began, skipping records already
    written; like the Markdown export, every branch is kept in file order.
    """
    if session["source"] == "claude":
        own = {path: _own_start(path, path.stem) for path in paths}
        paths = sorted(paths, key=lambda path: (path.stem != session["id"], own[path] is None, own[path] or ""))
    fd, temp_name = tempfile.mkstemp(prefix=".collect-", dir=snapshots)
    temporary = Path(temp_name)
    try:
        seen: set[bytes] = set()
        with os.fdopen(fd, "w+b") as destination:
            os.fchmod(destination.fileno(), 0o600)
            for path in paths:
                for line in CODEX.complete_lines(path):
                    if session["source"] == "claude":
                        key = _record_key(line)
                        if key in seen:
                            continue
                        seen.add(key)
                    destination.write(line)
            destination.flush()
            os.fsync(destination.fileno())
            size = destination.tell()
            destination.seek(0)
            if session["source"] == "codex":
                meta = CODEX.read_metadata(destination, size)
                same = meta.get("id") == session["id"]
            else:
                meta = CLAUDE.read_metadata(destination, size)
                same = bool(meta) and meta.get("sessionId") == session["id"]
            if not same:
                raise CollectionError("source_metadata_changed")
        name = hashlib.sha256("\0".join(map(str, paths)).encode()).hexdigest() + ".jsonl"
        target = snapshots / name
        os.link(temporary, target)
        return target
    finally:
        temporary.unlink(missing_ok=True)


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
        names = session_names([(s["source"], s["id"]) for s in chosen])
        state.data["trajectories"] = [{
            "index": number, "source": s["source"], "sessionId": s["id"], "startedAt": s["started"],
            "title": first_request(s["path"], s["source"]), "name": names.get(f"{s['source']}:{s['id']}", ""),
            "bytes": s["bytes"], "status": "queued",
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
                    reason = str(error)
                    why = getattr(workers, "unfinished", {}).pop(source.name, None)
                    if reason == "worker_not_complete" and why:
                        reason = f"{reason}: {why}"
                    state.change(index, status="failed", error=reason[:400], finishedAt=iso(time.time()))
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


# ---------------------------------------------------------------------------
# Submissions and cross-session insight jobs


def validate_submission(directory: Path) -> dict:
    """Validate a submission's export exactly as the cross-session helper will read it."""
    exports = load("oxygen_review_exports", CROSS_SKILL / "review_exports.py")
    corpus = exports.normalize_export(directory)
    return {"counts": corpus["counts"], "duplicates": corpus["duplicates"],
            "trajectories": [{key: source.get(key) for key in
                              ("id", "trajectoryKey", "reviewId", "projectName", "sourcePath")}
                             for source in corpus["sources"]]}


async def cross_cli(*args) -> dict:
    """One step of the cross-session helper; its JSON result, or WorkerError with its reason."""
    process = await asyncio.create_subprocess_exec(
        sys.executable, str(CROSS_SCRIPT), *map(str, args), stdin=subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    out, err = await process.communicate()
    if process.returncode:
        reason = _tail(err or out, 300)
        for line in reversed(err.decode("utf-8", "replace").strip().splitlines()):
            try:
                reason = str(json.loads(line)["error"])
                break
            except (ValueError, KeyError, TypeError):
                continue
        raise WorkerError(f"{args[0]}: {reason}")
    return json.loads(out)


async def cross_session(job_dir: Path, workers_factory=Workers) -> int:
    """Run both cross-session stages over the submission's frozen export, one fresh worker each.

    job_dir is <submission>/generations/<job>; the export is <submission>/export. The worker
    ID is recorded with the helper before the worker starts, so the helper's lock is never
    contended by a running worker's record call.
    """
    job_dir = job_dir.absolute()
    config = json.loads((job_dir / "config.json").read_text(encoding="utf-8"))
    export = job_dir.parent.parent / "export"
    run_dir = job_dir / "run"
    state = StateFile(job_dir / "state.json", {
        "id": config["id"], "submissionId": config.get("submissionId"), "host": config["host"],
        "model": config.get("model") or None, "effort": config.get("effort") or None,
        "createdAt": config.get("createdAt") or iso(time.time()), "startedAt": iso(time.time()),
        "finishedAt": None, "pid": os.getpid(), "heartbeat": time.time(), "phase": "preparing",
        "stage": None, "stagesDone": [], "stageSeconds": {}, "stageStartedAt": None,
        "counts": None, "candidateCount": None, "result": None, "error": None,
    })
    state.save()
    loop = asyncio.get_running_loop()
    workers = workers_factory(config["host"], job_dir)
    if hasattr(workers, "timeout"):
        workers.timeout = CROSS_TIMEOUT_SECONDS
    main_task = asyncio.current_task()
    cancelled = False
    running: tuple[str, str] | None = None  # (stage, worker ID) recorded with the helper

    def cancel() -> None:
        nonlocal cancelled
        cancelled = True
        workers.stop()
        main_task.cancel()

    for name in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(name, cancel)

    async def beat() -> None:
        while True:
            await asyncio.sleep(5)
            state.save()

    async def give_up() -> None:
        """Record the recorded worker as failed so the helper's run is not left running."""
        if running:
            try:
                await cross_cli("accept", run_dir, "--stage", running[0], "--worker-id", running[1],
                                "--worker-status", "failed")
            except WorkerError:
                pass  # expected: accepting a failed worker reports worker_failed

    heartbeat = asyncio.create_task(beat())
    try:
        choice = [*(["--host", config["host"]]),
                  *(["--model", config["model"]] if config.get("model") else []),
                  *(["--effort", config["effort"]] if config.get("effort") else [])]
        prepared = await cross_cli("prepare", export, "--run", run_dir, *choice)
        state.set(phase="generating", counts=prepared.get("counts"))
        for stage in CROSS_STAGES:
            started = time.time()
            state.set(stage=stage, stageStartedAt=iso(started))
            args = await cross_cli("call", run_dir, "--stage", stage)
            worker_id = workers.reserve_id()
            await cross_cli("record-worker", run_dir, "--stage", stage, "--worker-id", worker_id)
            running = (stage, worker_id)
            dispatch, wait = workers.adapters_for(
                run_dir, label=lambda _args, stage=stage: f"cross-session-{stage}",
                tools=cross_session_tools(run_dir), key=stage)
            await dispatch(args, worker_id)
            try:
                result = await wait(worker_id)
            except WorkerError as error:
                await give_up()
                raise WorkerError(f"{stage}: {error}") from error
            if result.get("status") != "complete":
                await give_up()
                why = getattr(workers, "unfinished", {}).pop(stage, None)
                raise WorkerError(f"{stage}: worker_not_complete" + (f": {why}" if why else ""))
            running = None
            await cross_cli("accept", run_dir, "--stage", stage, "--worker-id", worker_id,
                            "--worker-status", "complete")
            state.data["stagesDone"].append(stage)
            state.data["stageSeconds"][stage] = round(time.time() - started)
            state.save()
        result_path = run_dir / "humanize" / "cross_session_insights.json"
        candidates = json.loads(result_path.read_text(encoding="utf-8"))["candidates"]
        state.set(phase="done", stage=None, result=str(result_path.relative_to(job_dir)),
                  candidateCount=len(candidates), finishedAt=iso(time.time()))
        return 0
    except asyncio.CancelledError:
        if not cancelled:
            raise
        await give_up()
        state.set(phase="cancelled", stage=None, finishedAt=iso(time.time()))
        return 130
    except Exception as error:  # the service reads this; never leave a job looking active
        reason = str(error) if isinstance(error, WorkerError) else f"{type(error).__name__}: {error}"
        state.set(phase="failed", error=reason[:400], finishedAt=iso(time.time()))
        return 1
    finally:
        heartbeat.cancel()


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
    naming = commands.add_parser("session-names")
    naming.add_argument("--session", action="append", default=[], help="SOURCE:ID, repeatable")
    submission = commands.add_parser("validate-submission")
    submission.add_argument("--dir", required=True, type=Path)
    job = commands.add_parser("cross-session")
    job.add_argument("--job-dir", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        if args.command == "workspaces":
            print(json.dumps({"workspaces": workspaces()}, ensure_ascii=False))
        elif args.command == "sessions":
            print(json.dumps({"sessions": workspace_sessions(args.workspace)}, ensure_ascii=False))
        elif args.command == "payloads":
            print(json.dumps(payloads(args.run_dir, args.index), ensure_ascii=False))
        elif args.command == "session-names":
            pairs = [tuple(item.split(":", 1)) for item in args.session if ":" in item]
            print(json.dumps({"names": session_names(pairs)}, ensure_ascii=False))
        elif args.command == "validate-submission":
            print(json.dumps(validate_submission(args.dir), ensure_ascii=False))
        elif args.command == "cross-session":
            return asyncio.run(cross_session(args.job_dir))
        else:
            return asyncio.run(run(args.run_dir))
    except (OSError, ValueError, KeyError) as error:
        print(json.dumps({"error": f"{type(error).__name__}: {str(error)[:200]}"}), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
