#!/usr/bin/env python3
"""Prepare and validate fixed Oxygen subagent dispatches; never invoke a model."""

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import types


SKILL = Path(__file__).resolve().parents[1]
KIT = SKILL.parents[1]
MODEL = "gpt-6.1-sol"
EFFORT = "high"
HOSTS = ("codex", "claude")
CLAUDE_MODEL = "opus"
CLAUDE_SUBAGENT = "general-purpose"
# Reading guidance differs by host because the file tools and their limits differ.
HOST_NOTES = {
    "codex": (
        "Host: Codex `collaboration.spawn_agent` worker. Plan reads that fit both "
        "`exec_command` and the enclosing `functions.exec` output limits."
    ),
    "claude": (
        "Host: Claude Code Agent-tool worker with a fresh context. Read the source with "
        "the Read tool using `offset` and `limit`. Each call returns at most 2000 lines and "
        "may truncate very long lines or reject a range that is too large; request fewer "
        "lines, or reread a long line with Bash (for example `sed -n 'Np' FILE | cut -c A-B`). "
        "Write output files with Write or Edit, then set mode 0600 with `chmod 600` in Bash. "
        "Run the label helper with Bash. Do not use the Agent, WebFetch, or WebSearch tools. "
        "Your final message is the task result returned to the parent."
    ),
}
PROTOCOL_VERSION = 9
STAGES = {
    "summary": ("summary.md", ("summary.md", "summary_labeled.md")),
    "insight": ("insight.md", ("summary.md", "summary_labeled.md", "insight.md")),
    "redaction": ("sensitive-redaction.md", (
        "summary_redacted.md", "summary_redacted_labeled.md", "insight_redacted.md",
    )),
}
CARD_FORMAT = KIT / "prompts" / "insight-card-format.md"
CARD_SCRIPT = SKILL / "scripts" / "insight_cards.py"
CARD_SPEC = importlib.util.spec_from_file_location("oxygen_insight_cards", CARD_SCRIPT)
CARDS = importlib.util.module_from_spec(CARD_SPEC)
CARD_SPEC.loader.exec_module(CARDS)
LABEL_SCRIPT = SKILL / "scripts" / "label_summary_lines.py"
LABEL_SPEC = importlib.util.spec_from_file_location("oxygen_label_summary", LABEL_SCRIPT)
LABEL = importlib.util.module_from_spec(LABEL_SPEC)
LABEL_SPEC.loader.exec_module(LABEL)



class RunError(ValueError):
    pass


def sha(data):
    return hashlib.sha256(data).hexdigest()


def encode(value):
    return (json.dumps(value, sort_keys=True, indent=2, ensure_ascii=True) + "\n").encode()


def read_regular(path):
    if path.is_symlink():
        raise ValueError("input_symlink")
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    with os.fdopen(fd, "rb") as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode):
            raise RunError("input_not_regular")
        data = stream.read()
        after = os.fstat(stream.fileno())
    at_path = path.lstat()
    signature = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns)
    if signature(before) != signature(after) or signature(before) != signature(at_path):
        raise RunError("input_changed_during_read")
    return data


def paths(value):
    # Resolve aliases once; store only the canonical path in every call.
    supplied = Path(value).expanduser()
    if supplied.is_symlink():
        raise RunError("input_symlink")
    source = supplied.resolve(strict=False)
    return source, Path(str(source) + ".oxygen-agents")


def fixed_template(stage, label_script=LABEL_SCRIPT, host="codex"):
    notes = b"# Host notes\n\n" + HOST_NOTES[host].encode() + b"\n\n"
    wrapper = notes + (SKILL / "references" / f"{stage}-worker.md").read_bytes()
    prompt = (KIT / "prompts" / STAGES[stage][0]).read_bytes()
    # Preserve the exact prompt file inside the message, including its final newline.
    helper = b""
    if stage in {"insight", "redaction"}:
        helper = b"\n" + CARD_FORMAT.read_bytes()
        helper += b"\n# Label helper command (JSON argv prefix)\n" + encode([sys.executable, str(label_script)])
    return wrapper + b"\n" + prompt + helper + b"\n\n# Per-item input (JSON data)\n"


def host_settings(host="codex", model=None):
    if host == "codex":
        if model not in {None, MODEL}:
            raise RunError("codex_host_model_is_fixed")
        return {"tool": "collaboration.spawn_agent",
                "model": MODEL, "reasoning_effort": EFFORT, "fork_turns": "none"}
    if host == "claude":
        # Agent-tool workers start from a fresh context unless a fork is requested;
        # reasoning effort is inherited from the worker definition, not set per call.
        return {"host": "claude", "tool": "Agent", "subagent_type": CLAUDE_SUBAGENT,
                "model": model or CLAUDE_MODEL, "run_in_background": True,
                "context": "fresh"}
    raise RunError("unsupported_worker_host")


def configuration(host="codex", model=None):
    return {
        "protocol_version": PROTOCOL_VERSION,
        **host_settings(host, model),
        "helper_sha256": sha(Path(__file__).read_bytes()),
        "labeler_sha256": sha(LABEL_SCRIPT.read_bytes()),
        "card_parser_sha256": sha(CARD_SCRIPT.read_bytes()),
        "card_format_sha256": sha(CARD_FORMAT.read_bytes()),
        "template_sha256": {stage: sha(fixed_template(stage, host=host)) for stage in STAGES},
        "prompt_sha256": {stage: sha((KIT / "prompts" / STAGES[stage][0]).read_bytes()) for stage in STAGES},
        "tools_and_sandbox": "inherited from the host; not independently configurable by this tool",
    }


def call_arguments(stage, source, *, config=None, template=None):
    config = config or host_settings()
    host = config.get("host", "codex")
    tag = sha(os.fsencode(str(source)))[:16]
    message = (fixed_template(stage, host=host) if template is None else template).decode("utf-8") \
        + json.dumps({"input_path": str(source)}, ensure_ascii=True, sort_keys=True) + "\n"
    if host == "claude":
        return {
            "description": f"Oxygen {stage} {tag[:8]}",
            **{key: config[key] for key in ("subagent_type", "model", "run_in_background")},
            "prompt": message,
        }
    return {
        "task_name": f"oxygen_{stage}_{tag}",
        **{key: config[key] for key in ("fork_turns", "model", "reasoning_effort")},
        "message": message,
    }


def write_new(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as stream:
        if hasattr(os, "fchmod"):
            os.fchmod(stream.fileno(), 0o600)
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


def save_manifest(run, manifest):
    fd, name = tempfile.mkstemp(dir=run, prefix=".manifest-")
    temporary = Path(name)
    try:
        with os.fdopen(fd, "wb") as stream:
            if hasattr(os, "fchmod"):
                os.fchmod(stream.fileno(), 0o600)
            stream.write(encode(manifest))
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(run / "manifest.json")
    finally:
        temporary.unlink(missing_ok=True)


def live_session_storage(source):
    parts = source.parts
    if ".codex" in parts and any(part in parts for part in ("sessions", "archived_sessions")):
        return True
    return "projects" in parts and any(part.startswith(".claude") for part in parts)


def prepare(value, *, host="codex", model=None):
    source, run = paths(value)
    if source.suffix.lower() not in {".json", ".jsonl", ".md"}:
        raise RunError("expected_json_jsonl_or_markdown")
    # Live rollouts must first be frozen by the collector; no analysis under live storage.
    if live_session_storage(source):
        raise RunError("collect_live_rollout_first")
    data = read_regular(source)
    if not data.strip():
        raise RunError("empty_input")
    try:
        if source.suffix.lower() == ".jsonl":
            for line in data.splitlines():
                json.loads(line)
        elif source.suffix.lower() == ".json":
            json.loads(data)
        else:
            data.decode("utf-8")
    except (ValueError, UnicodeError, RecursionError) as exc:
        raise RunError("malformed_input") from exc
    config = configuration(host, model)
    run.mkdir(mode=0o700)
    run.chmod(0o700)
    for stage in STAGES:
        directory = run / stage
        directory.mkdir(mode=0o700)
        directory.chmod(0o700)
    frozen_name = "source.md" if source.suffix.lower() == ".md" else "trajectory.json"
    write_new(run / frozen_name, data)
    # Snapshot prompts and the small pure helpers once. Existing runs keep using
    # these versions even if repository prompts or helper files change later.
    protocol = run / "protocol"
    protocol.mkdir(mode=0o700)
    protocol.chmod(0o700)
    snapshots = {"label_summary_lines.py": LABEL_SCRIPT.read_bytes(),
                 "insight_cards.py": CARD_SCRIPT.read_bytes()}
    snapshots.update({f"{stage}-template.md": fixed_template(stage, protocol / LABEL_SCRIPT.name, host)
                      for stage in STAGES})
    for name, content in snapshots.items():
        write_new(protocol / name, content)
    manifest = {
        "input_path": str(source), "input_sha256": sha(data), "input_bytes": len(data),
        "configuration": config, "frozen_file": frozen_name, "stages": {}, "complete": False,
        "protocol_sha256": {name: sha(content) for name, content in snapshots.items()},
    }
    save_manifest(run, manifest)
    return {"run_directory": str(run), "input_sha256": sha(data), "input_bytes": len(data)}


def load_run(source, run):
    manifest = json.loads(read_regular(run / "manifest.json"))
    if manifest["configuration"]["protocol_version"] not in {7, 8, PROTOCOL_VERSION}:
        raise RunError("unsupported_run_protocol")
    if manifest["input_path"] != str(source):
        raise RunError("input_path_mismatch")
    frozen_name = "source.md" if source.suffix.lower() == ".md" else "trajectory.json"
    if manifest["frozen_file"] != frozen_name:
        raise RunError("frozen_path_mismatch")
    return manifest


def validate_summary(data, allow_empty=False):
    if not data.decode("utf-8").strip() and not allow_empty:
        raise RunError("empty_summary")


def validate_insights(data, summary):
    return len(parse_insights(data, summary))


def parse_insights(data, summary, labeler=LABEL, cards=CARDS):
    try:
        return cards.parse_cards(data, labeler.evidence_lines(summary))
    except UnicodeError as exc:
        raise RunError("invalid_insight_encoding") from exc
    except ValueError as exc:
        raise RunError(str(exc)) from exc


def run_helper(run, name):
    """Load the run's saved helper without creating bytecode or other outputs."""
    path = run / "protocol" / name
    module = types.ModuleType(name)
    exec(compile(read_regular(path), str(path), "exec"), module.__dict__)
    return module


def validate_outputs(run, stage):
    directory = run / stage
    names = STAGES[stage][1]
    data = {name: read_regular(directory / name) for name in names}
    labeler = run_helper(run, "label_summary_lines.py")
    count = 0
    summary = data[names[0]]
    validate_summary(summary, allow_empty=stage == "redaction")
    if data[names[1]] != labeler.label_bytes(summary):
        raise RunError("labeled_summary_mismatch")
    if stage in {"insight", "redaction"}:
        cards = parse_insights(data[names[2]], summary, labeler, run_helper(run, "insight_cards.py"))
        count = len(cards)
    for name in data:
        (directory / name).chmod(0o600)
    return {
        "sha256": {name: sha(value) for name, value in data.items()},
        "summary_lines": len(labeler.physical_lines(summary)),
        "evidence_lines": len(labeler.evidence_lines(summary)),
        "insights": count,
    }


def prepare_summary_labels(run):
    directory = run / "summary"
    validate_summary(read_regular(directory / "summary.md"))
    labeler = run_helper(run, "label_summary_lines.py")
    # This file is owned by the parent and can be regenerated after a failed accept.
    (directory / "summary_labeled.md").unlink(missing_ok=True)
    labeler.label_file(directory / "summary.md", directory / "summary_labeled.md")


def prepare_insight(value, previous_run, *, host="codex", model=None):
    """Start a new run from a verified accepted summary, without a summary worker."""
    source, run = paths(value)
    prior = Path(previous_run).expanduser()
    if prior.is_symlink():
        raise RunError("prior_run_symlink")
    prior = prior.resolve(strict=True)
    if (prior / ".operation-lock").exists():
        raise RunError("prior_run_busy")
    old_bytes = read_regular(prior / "manifest.json")
    old = json.loads(old_bytes)
    if old["configuration"]["protocol_version"] not in {5, 6, 7, 8, PROTOCOL_VERSION}:
        raise RunError("unsupported_summary_import_protocol")
    state = old["stages"].get("summary", {})
    if state.get("status") != "complete":
        raise RunError("prior_summary_not_complete")
    suffix = Path(old["input_path"]).suffix.lower()
    if suffix not in {".json", ".jsonl", ".md"} or source.suffix.lower() != suffix:
        raise RunError("import_input_suffix_mismatch")
    frozen_name = "source.md" if suffix == ".md" else "trajectory.json"
    if old["frozen_file"] != frozen_name:
        raise RunError("prior_frozen_path_mismatch")
    frozen = read_regular(prior / frozen_name)
    if len(frozen) != old["input_bytes"] or sha(frozen) != old["input_sha256"]:
        raise RunError("prior_input_hash_mismatch")
    summary = {name: read_regular(prior / "summary" / name) for name in STAGES["summary"][1]}
    if {name: sha(data) for name, data in summary.items()} != state["outputs"]["sha256"]:
        raise RunError("prior_summary_hash_mismatch")
    validate_summary(summary["summary.md"])
    if summary["summary_labeled.md"] != LABEL.label_bytes(summary["summary.md"]):
        raise RunError("prior_labeled_summary_mismatch")
    if read_regular(prior / "manifest.json") != old_bytes or (prior / ".operation-lock").exists():
        raise RunError("prior_run_changed_during_import")
    if source.exists() or run.exists():
        raise RunError("import_destination_already_exists")
    write_new(source, frozen)
    result = prepare(source, host=host, model=model)
    for name, data in summary.items():
        write_new(run / "summary" / name, data)
    manifest = load_run(source, run)
    manifest["stages"]["summary"] = {
        "status": "complete", "origin": "imported_summary",
        "outputs": validate_outputs(run, "summary"),
        "provenance": {
            "run_directory": str(prior), "manifest_sha256": sha(old_bytes),
            "protocol_version": old["configuration"]["protocol_version"],
            "input_sha256": old["input_sha256"],
            "summary_sha256": state["outputs"]["sha256"],
        },
    }
    save_manifest(run, manifest)
    return {**result, "summary_origin": "imported_summary", "next_action": "insight-call"}


def locked(value, action):
    source, run = paths(value)
    lock = run / ".operation-lock"
    write_new(lock, b"")
    try:
        return action(source, run, load_run(source, run))
    finally:
        lock.unlink()


def require_completed(manifest, stage):
    state = manifest["stages"].get(stage, {})
    if state.get("status") != "complete":
        raise RunError(f"{stage}_not_complete")


def verify_resume(value):
    """Check integrity once on recovery, without rereading the original input."""
    def verify(source, run, manifest):
        if sha(read_regular(run / manifest["frozen_file"])) != manifest["input_sha256"]:
            raise RunError("input_hash_mismatch")
        for name, digest in manifest["protocol_sha256"].items():
            if sha(read_regular(run / "protocol" / name)) != digest:
                raise RunError("saved_protocol_changed")
        for stage, state in manifest["stages"].items():
            if state["status"] == "complete":
                for name, digest in state["outputs"]["sha256"].items():
                    if sha(read_regular(run / stage / name)) != digest:
                        raise RunError(f"{stage}_outputs_changed")
        return {"status": "verified", "run_complete": manifest["complete"]}
    return locked(value, verify)


def issue_call(value, stage):
    def issue(source, run, manifest):
        if stage in manifest["stages"]:
            raise RunError("dispatch_already_issued_reconcile_existing_agent")
        for previous in list(STAGES)[:list(STAGES).index(stage)]:
            require_completed(manifest, previous)
        if stage == "insight":
            # Preserve the accepted first draft; revisions belong to the insight stage.
            for name in STAGES["summary"][1]:
                write_new(run / "insight" / name, read_regular(run / "summary" / name))
        args = call_arguments(stage, source, config=manifest["configuration"],
                              template=read_regular(run / "protocol" / f"{stage}-template.md"))
        # Save the exact call and claim before emitting it. A crash never causes a blind retry.
        write_new(run / f"{stage}-call.json", encode(args))
        manifest["stages"][stage] = {"status": "issued", "call_sha256": sha(encode(args))}
        save_manifest(run, manifest)
        return args
    return locked(value, issue)


def record_worker(value, stage, worker_id):
    """Record the actual host worker immediately after dispatch (or reconciliation)."""
    def record(source, run, manifest):
        state = manifest["stages"].get(stage, {})
        if state.get("status") not in {"issued", "complete"} or state.get("origin"):
            raise RunError("dispatch_not_issued")
        if not isinstance(worker_id, str) or not worker_id.strip():
            raise RunError("worker_id_required")
        if state.get("worker_id", worker_id) != worker_id:
            raise RunError("worker_id_mismatch")
        state["worker_id"] = worker_id
        save_manifest(run, manifest)
        return {"stage": stage, "worker_id": worker_id}
    return locked(value, record)


def accept(value, stage, *, worker_id=None, worker_status=None):
    """Accept an output using completion observed by the host, not by this CLI."""
    def finish(source, run, manifest):
        state = manifest["stages"].get(stage, {})
        if state.get("origin") == "imported_summary":
            raise RunError("summary_imported_no_worker_to_accept")
        if state.get("status") not in {"issued", "complete"}:
            raise RunError("dispatch_not_issued")
        if not state.get("worker_id"):
            raise RunError("worker_not_recorded")
        if worker_id != state["worker_id"]:
            raise RunError("worker_id_mismatch")
        if worker_status != "complete":
            raise RunError("worker_not_complete")
        if state["status"] == "complete":
            return {"stage": stage, "status": "complete", **state["outputs"],
                    "run_complete": manifest["complete"]}
        if stage == "summary":
            prepare_summary_labels(run)
        outputs = validate_outputs(run, stage)
        state.update(status="complete", worker_status=worker_status, outputs=outputs)
        manifest["complete"] = stage == "redaction" or manifest["complete"]
        save_manifest(run, manifest)
        return {"stage": stage, "status": "complete", **outputs, "run_complete": manifest["complete"]}
    return locked(value, finish)


async def orchestrate(value, dispatch, wait, *, redact=True, host="codex", model=None):
    """Dispatch -> await terminal result -> validate -> advance, using host adapters.

    dispatch(arguments) must asynchronously return the actual worker ID.
    wait(worker_id) must asynchronously return {"status": "complete"} only after
    successful worker termination AND a successful task result; all other results
    stop this item. Adapters must not retry dispatch or convert errors to success.
    """
    source, run = paths(value)
    if run.exists():
        verify_resume(source)
    else:
        prepare(source, host=host, model=model)
    stages = list(STAGES) if redact else ["summary", "insight"]
    for stage in stages:
        state = load_run(source, run)["stages"].get(stage, {})
        if state.get("status") == "complete":
            continue
        if state:
            worker_id = state.get("worker_id")
            if not worker_id:
                raise RunError("dispatch_uncertain_reconcile_existing_agent")
        else:
            arguments = issue_call(source, stage)
            worker_id = await dispatch(arguments)
            record_worker(source, stage, worker_id)
        result = await wait(worker_id)
        if not isinstance(result, dict) or result.get("status") != "complete":
            raise RunError("worker_not_complete")
        accept(source, stage, worker_id=worker_id, worker_status=result["status"])
    manifest = load_run(source, run)
    return {"status": "complete", "stages": stages, "run_complete": manifest["complete"]}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("prepare", "prepare-insight", "summary-call", "accept-summary", "insight-call", "accept-insight", "redaction-call", "accept-redaction", "record-worker", "verify-resume"))
    parser.add_argument("input_path", help="The only per-item parameter; a frozen JSON/JSONL or Markdown trajectory, or existing Markdown summary")
    parser.add_argument("--from-run", help="For prepare-insight only: prior run with an accepted summary; input_path must be new")
    parser.add_argument("--stage", choices=STAGES, help="Stage for record-worker")
    parser.add_argument("--worker-id", help="Actual host worker ID; required for record-worker and accept-*")
    parser.add_argument("--worker-status", choices=("complete", "error"), help="Task result observed after worker termination; required for accept-*")
    parser.add_argument("--host", choices=HOSTS, help="Worker host for prepare/prepare-insight; saved in the run. "
                        "Defaults to OXYGEN_WORKER_HOST or codex")
    parser.add_argument("--model", help="Claude host only: Agent-tool model alias (default opus)")
    args = parser.parse_args(argv)
    preparing = args.action in {"prepare", "prepare-insight"}
    if (args.host or args.model) and not preparing:
        parser.error("--host and --model apply only to prepare and prepare-insight; runs keep their saved host")
    host = args.host or os.environ.get("OXYGEN_WORKER_HOST") or "codex"
    if host not in HOSTS:
        parser.error("OXYGEN_WORKER_HOST must be one of: " + ", ".join(HOSTS))
    if (args.action == "prepare-insight") != bool(args.from_run):
        parser.error("--from-run is required only with prepare-insight")
    accepting = args.action.startswith("accept-")
    recording = args.action == "record-worker"
    if bool(args.worker_id) != (accepting or recording):
        parser.error("--worker-id is required only with record-worker and accept-*")
    if bool(args.stage) != recording or bool(args.worker_status) != accepting:
        parser.error("--stage is required only with record-worker; --worker-status only with accept-*")
    try:
        if args.action == "prepare":
            result = prepare(args.input_path, host=host, model=args.model)
        elif args.action == "prepare-insight":
            result = prepare_insight(args.input_path, args.from_run, host=host, model=args.model)
        elif args.action == "record-worker":
            result = record_worker(args.input_path, args.stage, args.worker_id)
        elif args.action == "verify-resume":
            result = verify_resume(args.input_path)
        elif args.action.endswith("-call"):
            result = issue_call(args.input_path, args.action.removesuffix("-call"))
        else:
            result = accept(args.input_path, args.action.removeprefix("accept-"),
                            worker_id=args.worker_id, worker_status=args.worker_status)
        print(encode(result).decode(), end="")
        return 0
    except (RunError, OSError, ValueError, KeyError, UnicodeError) as exc:
        # Avoid printing arbitrary source data or parser excerpts.
        reason = str(exc) if isinstance(exc, RunError) else type(exc).__name__
        print(json.dumps({"status": "error", "reason": reason}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
