#!/usr/bin/env python3
"""Freeze completed reviews, record fresh workers, and validate cross-session drafts."""

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

sys.dont_write_bytecode = True
from cross_cards import parse_cards
from review_exports import normalize_export

MODEL = "gpt-6.1-sol"
EFFORT = "high"
FORMAT = "oxygen-cross-session-candidates/v2"
SKILL = Path(__file__).resolve().parents[1]
CATEGORY_REFERENCE = SKILL.parents[1] / "prompts" / "insight_categories.md"
HUMANIZER_ROOT = SKILL.parents[1] / "skills/humanizer"
HUMANIZER_WRAPPER = SKILL.parents[1] / "prompts/humanize.md"
HUMANIZER_SCRIPT = Path(__file__).with_name("humanizer_protocol.py")
if not HUMANIZER_SCRIPT.is_file():
    HUMANIZER_SCRIPT = SKILL.parents[1] / "tools/humanizer_protocol.py"
HUMANIZER = None
if HUMANIZER_SCRIPT.is_file():
    HUMANIZER_SPEC = importlib.util.spec_from_file_location("oxygen_cross_humanizer", HUMANIZER_SCRIPT)
    HUMANIZER = importlib.util.module_from_spec(HUMANIZER_SPEC)
    HUMANIZER_SPEC.loader.exec_module(HUMANIZER)
OUTPUTS = ("cross_session_insights.md", "completion.json")


def now():
    return datetime.now(timezone.utc).isoformat()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def regular(path):
    path = Path(path)
    if path.is_symlink() or not path.is_file():
        raise ValueError(f"not_regular_file: {path}")
    return path.read_bytes()


def load(path):
    return json.loads(regular(path))


def write(path, value, *, replace=False):
    path = Path(path)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    data = value if isinstance(value, bytes) else json_bytes(value)
    if replace:
        temporary = path.with_name(path.name + ".tmp")
        with temporary.open("xb") as stream:
            os.chmod(temporary, 0o600)
            stream.write(data)
        os.replace(temporary, path)
    else:
        with path.open("xb") as stream:
            os.chmod(path, 0o600)
            stream.write(data)


@contextmanager
def lock(run):
    path = run / ".operation-lock"
    try:
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError as exc:
        raise ValueError("run_locked: reconcile the previous operation before removing its lock") from exc
    try:
        os.write(fd, str(os.getpid()).encode())
        os.close(fd)
        yield
    finally:
        path.unlink()


def private_relative(root, name):
    relative = Path(name)
    if relative.is_absolute() or ".." in relative.parts:
        raise ValueError(f"invalid_relative_path: {name}")
    target = root / relative
    for part in [target, *target.parents]:
        if part == root:
            break
        if part.is_symlink():
            raise ValueError(f"symlink_in_run: {name}")
    if not target.resolve().is_relative_to(root.resolve()):
        raise ValueError(f"path_outside_run: {name}")
    return target


def prepare(input_dir, run):
    input_dir = Path(input_dir).absolute()
    run = Path(run).absolute()
    if run.exists() or run.is_symlink():
        raise ValueError("run_exists: use a new timestamped directory")
    if run.resolve().is_relative_to(input_dir.resolve()):
        raise ValueError("run_inside_input")
    try:
        categories = regular(CATEGORY_REFERENCE)
        if not categories.strip():
            raise ValueError("empty_reference")
        categories.decode("utf-8")
    except (OSError, ValueError) as exc:
        raise ValueError("category_reference_unavailable") from exc
    if HUMANIZER is None:
        raise ValueError("humanizer_reference_unavailable")
    humanizer = HUMANIZER.bundle(HUMANIZER_ROOT, HUMANIZER_WRAPPER)
    corpus = normalize_export(input_dir)
    if len(corpus["sources"]) < 2:
        raise ValueError("insufficient_distinct_trajectories: supply at least two completed trajectories")
    run.mkdir(mode=0o700, parents=True)
    os.chmod(run, 0o700)
    try:
        # Freeze every actual supplied file and revalidate the copy. No pre-edit
        # provenance hash is used as a fingerprint of the reviewed content.
        for name, expected in corpus["files"].items():
            data = regular(private_relative(input_dir, name))
            if digest(data) != expected:
                raise ValueError(f"input_changed_during_freeze: {name}")
            write(private_relative(run / "inputs", name), data)
        frozen_corpus = normalize_export(run / "inputs")
        if frozen_corpus != corpus:
            raise ValueError("frozen_normalization_mismatch")
        write(run / "corpus.json", corpus)
        for folder in ("scripts", "references", "agents"):
            for src in sorted((SKILL / folder).glob("*")):
                if src.is_file() and src.suffix in (".py", ".md", ".json", ".yaml"):
                    write(run / "protocol" / folder / src.name, regular(src))
        write(run / "protocol" / "SKILL.md", regular(SKILL / "SKILL.md"))
        write(run / "protocol/references/insight_categories.md", categories)
        write(run / "protocol/scripts/humanizer_protocol.py", regular(HUMANIZER_SCRIPT))
        for name, data in humanizer.items():
            write(run / "protocol/references" / name, data)
        write(run / "protocol/humanizer-instructions.md", HUMANIZER.instructions(humanizer))
        settings = {"model": MODEL, "reasoning_effort": EFFORT, "fork_turns": "none",
                    "format": FORMAT, "privacyStatus": "private-awaiting-review",
                    "stageOrder": ["synthesis", "humanize"]}
        write(run / "config.json", settings)
        reading = []
        for source in corpus["sources"]:
            sid = source["id"]
            base = f"reading/{sid}"
            summary = regular(run / "inputs" / source["directory"] / "summary_labeled.md")
            cards = json_bytes({"sourceId": sid, "reviewId": source["reviewId"],
                                "sourcePath": source["sourcePath"], "cards": source["cards"]})
            entry = {key: source[key] for key in
                     ("id", "trajectoryKey", "reviewId", "projectName", "sourcePath")}
            entry["files"] = []
            for filename, data in (("summary.md", summary), ("cards.json", cards)):
                relative = f"{base}/{filename}"
                write(run / relative, data)
                entry["files"].append({"path": relative, "bytes": len(data), "sha256": digest(data)})
            reading.append(entry)
        write(run / "reading" / "index.json", {"sources": reading, "counts": corpus["counts"]})
        helper = run / "protocol" / "scripts" / "cross_session.py"
        prompt = regular(run / "protocol" / "references" / "synthesis-worker.md").decode()
        prompt += "\n\n## This run\n\n" + json.dumps({
            "runDirectory": str(run), "index": str(run / "reading/index.json"),
            "formatInstructions": str(run / "protocol/references/candidate-format.md"),
            "categoryInstructions": str(run / "protocol/references/insight_categories.md"),
            "skillCreatorGuidance": str(run / "protocol/references/skill-creator-guidance.md"),
            "readCommand": [sys.executable, str(helper), "read", str(run),
                            "--file", "PATH_FROM_INDEX", "--start", "BYTE_OFFSET",
                            "--limit", "BYTE_COUNT"],
            "checkCommand": [sys.executable, str(helper), "check", str(run)],
        }, indent=2) + "\n"
        write(run / "protocol" / "worker-prompt.md", prompt.encode())
        call = {"task_name": "oxygen_cross_session_" + digest(str(run).encode())[:12],
                "model": MODEL, "reasoning_effort": EFFORT, "fork_turns": "none",
                "message": "Read and follow the complete frozen worker instructions at "
                           + str(run / "protocol/worker-prompt.md")
                           + ". This file is your delegated task. Use only its supplied evidence corpus; "
                             "write outputs only in its run directory. Return its required final status."}
        write(run / "dispatch.json", call)
        summary_index = {"files": [item for entry in reading for item in entry["files"]
                                   if item["path"].endswith("/summary.md")]}
        write(run / "humanize-summary-index.json", summary_index)
        humanize_context = {
            "humanizerInstructions": str(run / "protocol/humanizer-instructions.md"),
            "formatInstructions": str(run / "protocol/references/candidate-format.md"),
            "summaryIndex": str(run / "humanize-summary-index.json"),
            "runDirectory": str(run),
            "inputCards": str(run / "cross_session_insights.md"),
            "outputCards": str(run / "humanize/cross_session_insights.md"),
            "completionFile": str(run / "humanize/completion.json"),
            "checkCommand": [sys.executable, str(helper), "check", str(run), "--stage", "humanize"],
        }
        humanize_prompt = regular(run / "protocol/references/humanize-worker.md")
        humanize_prompt += b"\n\n## This run\n\n" + json_bytes(humanize_context)
        write(run / "protocol/humanize-worker-prompt.md", humanize_prompt)
        humanize_call = dict(call, task_name=call["task_name"] + "_humanize",
                            message="Read and follow the complete frozen worker instructions at "
                            + str(run / "protocol/humanize-worker-prompt.md")
                            + ". This file is your delegated task. Return its required final status.")
        write(run / "humanize-dispatch.json", humanize_call)
        write(run / "input_validation.json", {"status": "valid", "counts": corpus["counts"],
                                              "duplicates": corpus["duplicates"],
                                              "actualExportFileCount": len(corpus["files"])})
        frozen = {str(path.relative_to(run)): digest(regular(path)) for path in sorted(run.rglob("*"))
                  if path.is_file()}
        manifest = {"format": "oxygen-cross-session-run/v1", "createdAt": now(),
                    "inputDirectory": str(input_dir), "runDirectory": str(run),
                    "physicalRunDirectory": str(run.resolve()),
                    "config": settings, "frozenHashes": frozen, "inputHashes": corpus["files"]}
        write(run / "manifest.json", manifest)
        write(run / "state.json", {"status": "prepared", "workerId": None, "updatedAt": now()})
        return {"status": "prepared", "run": str(run), "counts": corpus["counts"]}
    except Exception as exc:
        write(run / "preparation_failure.json", {"status": "failed", "error": str(exc)})
        raise


def verify(run, check_originals=False):
    manifest = load(run / "manifest.json")
    for name, expected in manifest["frozenHashes"].items():
        if digest(regular(private_relative(run, name))) != expected:
            raise ValueError(f"frozen_file_changed: {name}")
    state = load(run / "state.json")
    for name, expected in state.get("outputHashes", {}).items():
        if digest(regular(private_relative(run, name))) != expected:
            raise ValueError(f"accepted_output_changed: {name}")
    if check_originals:
        original = normalize_export(Path(manifest["inputDirectory"]))
        if original["files"] != manifest["inputHashes"]:
            raise ValueError("original_exports_changed")
    return {"status": "verified", "frozenFiles": len(manifest["frozenHashes"]),
            "originalsChecked": check_originals}


def issue_call(run, stage="synthesis"):
    with lock(run):
        verify(run)
        state = load(run / "state.json")
        if stage == "humanize":
            if state["status"] != "extracted" or "humanize" in state:
                raise ValueError("humanize_dispatch_unavailable")
            (run / "humanize").mkdir(mode=0o700)
            state["humanize"] = {"status": "dispatched", "workerId": None, "dispatchedAt": now()}
            write(run / "state.json", state, replace=True)
            return load(run / "humanize-dispatch.json")
        if state["status"] != "prepared":
            raise ValueError("dispatch_already_issued: reconcile the recorded host call")
        state.update(status="dispatched", dispatchedAt=now(), updatedAt=now())
        write(run / "state.json", state, replace=True)
        return load(run / "dispatch.json")


def record_worker(run, worker_id, stage="synthesis"):
    with lock(run):
        verify(run)
        state = load(run / "state.json")
        current = state if stage == "synthesis" else state.get("humanize", {})
        if current.get("status") != "dispatched" or current.get("workerId") is not None:
            raise ValueError("worker_not_recordable")
        if not worker_id.strip():
            raise ValueError("empty_worker_id")
        current.update(status="running", workerId=worker_id, updatedAt=now())
        write(run / "state.json", state, replace=True)
        prefix = "humanize/" if stage == "humanize" else ""
        dispatch = "humanize-dispatch.json" if stage == "humanize" else "dispatch.json"
        write(run / (prefix + "worker_record.json"), {"workerId": worker_id, "recordedAt": now(),
                                          "dispatchSha256": digest(regular(run / dispatch))})
        return state


def reading_files(run):
    return {item["path"]: item for source in load(run / "reading/index.json")["sources"]
            for item in source["files"]}


def read_chunk(run, name, start, limit):
    """Display a worker-chosen byte range without imposing a host-specific cap."""
    with lock(run):
        verify(run)
        files = reading_files(run)
        # Four bytes allow progress through any UTF-8 codepoint. The worker
        # chooses the upper bound according to the host's actual output budget.
        if name not in files or type(limit) is not int or limit < 4:
            raise ValueError("invalid_bounded_read")
        data = regular(private_relative(run, name))
        if not 0 <= start <= len(data):
            raise ValueError("invalid_read_offset")
        end = min(start + limit, len(data))
        # Never split a UTF-8 codepoint at the end; invalid start offsets fail.
        while end < len(data) and data[end] & 0xC0 == 0x80:
            end -= 1
        content = data[start:end].decode("utf-8")
        receipt = {"path": name, "start": start, "end": end,
                   "totalBytes": len(data), "sha256": digest(data), "at": now()}
        # Inspection after acceptance must not invalidate the sealed receipts.
        state = load(run / "state.json")
        if state["status"] != "accepted" and "read_receipts.json" not in state.get("outputHashes", {}):
            path = run / "read_receipts.json"
            receipts = load(path) if path.exists() else []
            receipts.append(receipt)
            write(path, receipts, replace=path.exists())
        return receipt, content


def reading_coverage(run):
    receipts = load(run / "read_receipts.json")
    if not isinstance(receipts, list):
        raise ValueError("invalid_read_receipts")
    coverage = []
    for name, item in reading_files(run).items():
        intervals = []
        for receipt in receipts:
            if receipt.get("path") != name:
                continue
            if receipt.get("sha256") != item["sha256"] or receipt.get("totalBytes") != item["bytes"]:
                raise ValueError(f"reading_receipt_mismatch: {name}")
            start, end = receipt.get("start"), receipt.get("end")
            if type(start) is not int or type(end) is not int or not 0 <= start <= end <= item["bytes"]:
                raise ValueError(f"invalid_read_range: {name}")
            intervals.append((start, end))
        cursor = 0
        for start, end in sorted(intervals):
            if start > cursor:
                break
            cursor = max(cursor, end)
        if cursor != item["bytes"] or not intervals:
            raise ValueError(f"incomplete_reading: {name} covered through {cursor}/{item['bytes']}")
        coverage.append({"path": name, "bytes": cursor, "complete": True})
    return coverage


def check(run, stage="synthesis"):
    verify(run)
    corpus = load(run / "corpus.json")
    directory = run / "humanize" if stage == "humanize" else run
    data = regular(directory / "cross_session_insights.md")
    cards = parse_cards(data, corpus["sources"])
    completion = load(directory / "completion.json")
    if completion.get("status") != "complete" or completion.get("readingComplete") is not True:
        raise ValueError("worker_reading_incomplete")
    if stage == "humanize":
        state = load(run / "state.json")
        if "cross_session_insights.md" not in state.get("outputHashes", {}):
            raise ValueError("synthesis_not_accepted")
        original = regular(run / "cross_session_insights.md")
        HUMANIZER.validate_preservation(parse_cards(original, corpus["sources"]), cards, original, data)
        return cards, {"status": "valid", "format": FORMAT, "candidateCount": len(cards),
                       "checks": ["frozen_hashes", "six_fields", "qualified_citations",
                                  "unchanged_card_identity_type_order_evidence", "unchanged_summaries"],
                       "limitations": ["Structural checks do not establish factual fidelity or readability.",
                                       "Humanizer completion attests full input reading and semantic comparison."]}
    coverage = reading_coverage(run)
    return cards, {"status": "valid", "format": FORMAT, "candidateCount": len(cards),
                      "sourceCounts": corpus["counts"], "coverage": coverage,
                      "checks": ["frozen_hashes", "six_fields", "qualified_citations",
                                 "distinct_trajectory_support",
                                 "bounded_read_coverage", "worker_completion_attestation"],
                      "limitations": ["Read receipts establish requested coverage, not comprehension.",
                                      "Semantic support, distinct episodes, and privacy need human review.",
                                      "Per-candidate source-card lineage and declined-reuse explanations are not structurally validated."]}


def accept(run, worker_id, worker_status, stage="synthesis"):
    with lock(run):
        state = load(run / "state.json")
        current = state if stage == "synthesis" else state.get("humanize", {})
        if current.get("status") != "running" or current.get("workerId") != worker_id:
            raise ValueError("worker_state_mismatch")
        directory = run / "humanize" if stage == "humanize" else run
        attestation = {"workerId": worker_id, "status": worker_status, "recordedAt": now(),
                       "basis": "Parent inspected actual host termination and final task result."}
        write(directory / "completion_attestation.json", attestation)
        try:
            if worker_status != "complete":
                raise ValueError("worker_failed")
            cards, validation = check(run, stage)
            corpus = load(run / "corpus.json")
            result = {"format": FORMAT, "status": "draft", "privacyStatus": "private-awaiting-review",
                      "candidates": [dict(card, status="draft") for card in cards],
                      "sources": corpus["sources"], "inputHashes": corpus["files"],
                      "config": load(run / "config.json"), "workerId": worker_id}
            write(directory / "cross_session_insights.json", result)
            write(directory / "validation.json", validation)
            names = (*OUTPUTS, "cross_session_insights.json", "validation.json",
                     "worker_record.json", "completion_attestation.json")
            if stage == "synthesis":
                names += ("read_receipts.json",)
            for name in names:
                os.chmod(directory / name, 0o600)
            hashes = dict(state.get("outputHashes", {}))
            hashes.update({str((directory / name).relative_to(run)): digest(regular(directory / name))
                           for name in names})
            required = "humanize" in load(run / "config.json").get("stageOrder", [])
            current["status"] = "accepted"
            state.update(status="extracted" if stage == "synthesis" and required else "accepted",
                         updatedAt=now(), outputHashes=hashes)
            if state["status"] == "accepted":
                state["finalOutputs"] = {"markdown": str(directory / "cross_session_insights.md"),
                                         "json": str(directory / "cross_session_insights.json"),
                                         "completion": str(directory / "completion.json"),
                                         "validation": str(directory / "validation.json")}
            write(run / "state.json", state, replace=True)
            return {**validation, "runStatus": state["status"],
                    **({"finalOutputs": state["finalOutputs"]} if "finalOutputs" in state else {})}
        except Exception as exc:
            current.update(status="failed", error=str(exc), updatedAt=now())
            state.update(status="failed", error=str(exc), updatedAt=now())
            write(run / "state.json", state, replace=True)
            if not (directory / "validation.json").exists():
                write(directory / "validation.json", {"status": "failed", "error": str(exc)})
            raise


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    prep = commands.add_parser("prepare")
    prep.add_argument("input", type=Path)
    prep.add_argument("--run", type=Path, required=True)
    for name in ("call", "record-worker", "read", "check", "accept", "verify"):
        cmd = commands.add_parser(name)
        cmd.add_argument("run", type=Path)
        if name in ("call", "record-worker", "check", "accept"):
            cmd.add_argument("--stage", choices=("synthesis", "humanize"), default="synthesis")
        if name in ("record-worker", "accept"):
            cmd.add_argument("--worker-id", required=True)
        if name == "accept":
            cmd.add_argument("--worker-status", choices=("complete", "failed"), required=True)
        if name == "read":
            cmd.add_argument("--file", required=True)
            cmd.add_argument("--start", type=int, default=0)
            # Enforce after delegation so old runs retain their frozen defaults.
            cmd.add_argument("--limit", type=int,
                             help="Bytes to display; required for new runs, chosen to fit tool output limits")
        if name == "verify":
            cmd.add_argument("--check-originals", action="store_true")
    args = parser.parse_args(argv)
    os.umask(0o077)
    try:
        run = args.run.absolute()
        if args.command != "prepare":
            # Resume through saved code, never reinterpret old runs with live code.
            helper = run / "protocol/scripts/cross_session.py"
            if Path(__file__).resolve() != helper.resolve():
                manifest = load(run / "manifest.json")
                for name, sha in manifest["frozenHashes"].items():
                    if name.startswith("protocol/") and digest(regular(private_relative(run, name))) != sha:
                        raise ValueError(f"frozen_file_changed: {name}")
                return subprocess.run([sys.executable, str(helper), *(argv or sys.argv[1:])]).returncode
        if args.command == "prepare":
            result = prepare(args.input, run)
        elif args.command == "call":
            result = issue_call(run, args.stage)
        elif args.command == "record-worker":
            result = record_worker(run, args.worker_id, args.stage)
        elif args.command == "read":
            if args.limit is None:
                raise ValueError("read_limit_required: choose --limit after measuring the file and planning tool output")
            receipt, content = read_chunk(run, args.file, args.start, args.limit)
            print(json.dumps(receipt), flush=True)
            print(content, end="", flush=True)
            print(f"\n[End of displayed chunk. Next byte offset: {receipt['end']}]")
            return 0
        elif args.command == "check":
            _, result = check(run, args.stage)
        elif args.command == "accept":
            result = accept(run, args.worker_id, args.worker_status, args.stage)
        else:
            result = verify(run, args.check_originals)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (ValueError, OSError, KeyError, TypeError) as exc:
        print(json.dumps({"status": "error", "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
