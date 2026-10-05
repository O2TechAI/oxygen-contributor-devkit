#!/usr/bin/env python3
"""Collect private, unchanged prefixes of main Claude Code sessions for a workspace."""

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys
import tempfile


_codex_spec = importlib.util.spec_from_file_location(
    "oxygen_collect_codex", Path(__file__).with_name("collect_workspace_sessions.py"))
CODEX = importlib.util.module_from_spec(_codex_spec)
_codex_spec.loader.exec_module(CODEX)

CollectionError = CODEX.CollectionError
normalized = CODEX.normalized
within = CODEX.within

# Claude Code writes several metadata records (queue operations, titles, modes)
# before the first record that carries the session's working directory.
HEADER_RECORDS = 256
HEADER_BYTES = 16 * 1024 * 1024
CONVERSATION_TYPES = {"user", "assistant", "attachment", "system"}


def _decode(raw):
    try:
        row = json.loads(raw, object_pairs_hook=CODEX._unique_object,
                         parse_constant=CODEX._reject_constant)
    except (ValueError, UnicodeError, RecursionError) as exc:
        raise CollectionError("malformed_header") from exc
    if not isinstance(row, dict):
        raise CollectionError("malformed_header")
    return row


def read_metadata(stream, observed_bytes):
    """Return the first conversation record's identity, or None for metadata-only files."""
    budget = min(observed_bytes, HEADER_BYTES)
    consumed = 0
    for _ in range(HEADER_RECORDS):
        raw = stream.readline(budget - consumed + 1)
        if not raw:
            return None
        consumed += len(raw)
        if consumed > budget or not raw.endswith(b"\n"):
            raise CollectionError("incomplete_or_oversized_header")
        row = _decode(raw)
        if row.get("type") not in CONVERSATION_TYPES or "cwd" not in row:
            continue
        return {key: row.get(key) for key in (
            "sessionId", "cwd", "isSidechain", "agentId", "entrypoint", "version", "timestamp")}
    raise CollectionError("session_metadata_not_found")


def classify(meta, path, workspace):
    if "subagents" in path.parts or path.name.startswith("agent-"):
        return "subagent"
    if meta is None:
        return "no_conversation_records"
    if meta.get("isSidechain") or meta.get("agentId"):
        return "subagent"
    session_id = meta.get("sessionId")
    if not isinstance(session_id, str) or not session_id:
        return "unclassified"
    cwd = meta.get("cwd")
    if not isinstance(cwd, str) or not cwd or "\x00" in cwd or not Path(cwd).is_absolute():
        return "unclassified"
    return "selected" if within(normalized(cwd), workspace) else "outside_workspace"


def freeze_source(stream, path, initial, metadata, snapshots):
    length = CODEX._complete_prefix_length(stream, initial.st_size)
    fd, temp_name = tempfile.mkstemp(prefix=".collect-", dir=snapshots)
    temporary = Path(temp_name)
    try:
        with os.fdopen(fd, "w+b") as destination:
            os.fchmod(destination.fileno(), 0o600)
            digest = CODEX._read_prefix(stream, length, destination)
            destination.flush()
            os.fsync(destination.fileno())
            destination.seek(0)
            if read_metadata(destination, length) != metadata:
                raise CollectionError("source_metadata_changed")
        CODEX._verify_prefix(stream, path, initial, length, digest)
        name = hashlib.sha256(os.fsencode(str(path))).hexdigest() + ".jsonl"
        target = snapshots / name
        os.link(temporary, target)
        return target, digest, length
    finally:
        temporary.unlink(missing_ok=True)


def discover(roots, manifest):
    paths = []
    for root in roots:
        try:
            info = root.lstat()
        except FileNotFoundError:
            manifest["missing_roots"].append(str(root))
            _error(manifest, root, "missing_projects_root")
            continue
        except OSError as exc:
            _error(manifest, root, type(exc).__name__)
            continue
        if not stat.S_ISDIR(info.st_mode):
            _error(manifest, root, "storage_root_not_directory")
            continue

        def walk_error(exc):
            _error(manifest, exc.filename or root, type(exc).__name__)

        for directory, dirs, files in os.walk(root, onerror=walk_error, followlinks=False):
            dirs.sort()
            for name in dirs[:]:
                child = Path(directory) / name
                if child.is_symlink():
                    dirs.remove(name)
                    _error(manifest, child, "symlink_directory_skipped")
            paths.extend(Path(directory) / name for name in files if name.endswith(".jsonl"))
    return sorted(set(paths))


def _error(manifest, path, reason):
    manifest["errors"].append({"source_path": str(path), "reason": reason})


def _exclude(manifest, path, reason):
    manifest["exclusions"].append({"source_path": str(path), "reason": reason})
    counts = manifest["counts"]["excluded_by_reason"]
    counts[reason] = counts.get(reason, 0) + 1


def default_config_dirs():
    return [normalized(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude")]


def collect(workspace, config_dirs=None, output_dir=None, dry_run=False):
    workspace = normalized(workspace)
    if not workspace.is_dir():
        raise CollectionError("workspace_must_be_directory")
    homes = sorted({normalized(item) for item in (config_dirs or default_config_dirs())})
    roots = [home / "projects" for home in homes]
    output = None
    if output_dir is not None:
        output = normalized(output_dir)
        protected = set(roots) | {home / "projects" for home in default_config_dirs()}
        if any(within(output, root) for root in protected):
            raise CollectionError("output_inside_session_storage")
        if os.path.lexists(Path(output_dir).expanduser()) or output.exists():
            raise CollectionError("output_already_exists")
        if not output.parent.is_dir():
            raise CollectionError("output_parent_must_exist")
    if not dry_run and output is None:
        raise CollectionError("output_dir_required")

    manifest = {
        "schema": "oxygen-workspace-sessions", "version": 1, "format": "claude-code",
        "workspace": str(workspace), "claude_config_dirs": [str(home) for home in homes],
        "dry_run": dry_run, "searched_roots": [str(root) for root in roots], "missing_roots": [],
        "counts": {"candidates": 0, "selected": 0, "snapshots": 0,
                   "duplicates": 0, "failed": 0, "excluded_by_reason": {}},
        "sessions": [], "exclusions": [], "errors": [],
    }
    if not dry_run:
        output.mkdir(mode=0o700)
        output.chmod(0o700)
        snapshots = output / "snapshots"
        snapshots.mkdir(mode=0o700)
        snapshots.chmod(0o700)

    duplicates = {}
    for path in discover(roots, manifest):
        manifest["counts"]["candidates"] += 1
        if "subagents" in path.parts:
            # Subagent transcripts are excluded without parsing, like Codex subagent sources.
            _exclude(manifest, path, "subagent")
            continue
        try:
            with CODEX.open_source(path) as stream:
                initial = os.fstat(stream.fileno())
                meta = read_metadata(stream, initial.st_size)
                decision = classify(meta, path, workspace)
                if decision != "selected":
                    _exclude(manifest, path, decision)
                    if decision == "unclassified":
                        _error(manifest, path, "unclassified_metadata")
                    continue
                manifest["counts"]["selected"] += 1
                entry = {"source_path": str(path), "session_id": meta["sessionId"], "cwd": meta["cwd"],
                         "entrypoint": meta.get("entrypoint"), "claude_code_version": meta.get("version"),
                         "first_timestamp": meta.get("timestamp")}
                if dry_run:
                    manifest["sessions"].append(entry)
                    continue
                target, digest, length = freeze_source(stream, path, initial, meta, snapshots)
                location = {"source_path": str(path), "observed_bytes": initial.st_size,
                            "omitted_trailing_bytes": initial.st_size - length}
                key = (meta["sessionId"], digest, length)
                if key in duplicates:
                    target.unlink()
                    duplicates[key]["source_locations"].append(location)
                    manifest["counts"]["duplicates"] += 1
                    continue
                entry.update({"snapshot_path": target.relative_to(output).as_posix(),
                              "sha256": digest, "bytes": length, "source_locations": [location]})
                duplicates[key] = entry
                manifest["sessions"].append(entry)
                manifest["counts"]["snapshots"] += 1
        except (CollectionError, OSError, ValueError, RecursionError) as exc:
            reason = str(exc) if isinstance(exc, CollectionError) else type(exc).__name__
            _error(manifest, path, reason)
            _exclude(manifest, path, "failed")
            manifest["counts"]["failed"] += 1

    manifest["complete"] = not manifest["errors"]
    if not dry_run:
        destination = output / "manifest.json"
        fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            os.fchmod(stream.fileno(), 0o600)
            json.dump(manifest, stream, indent=2, ensure_ascii=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
    return manifest


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", required=True, help="Workspace directory, including descendants")
    parser.add_argument("--claude-config-dir", action="append",
                        help="Claude Code config directory containing projects/; repeatable. "
                             "Defaults to CLAUDE_CONFIG_DIR or ~/.claude")
    parser.add_argument("--output-dir", help="New private directory; parent must exist")
    parser.add_argument("--dry-run", action="store_true", help="Discover only, without creating files")
    args = parser.parse_args(argv)
    try:
        manifest = collect(args.workspace, args.claude_config_dir, args.output_dir, args.dry_run)
    except (CollectionError, OSError, ValueError) as exc:
        reason = str(exc) if isinstance(exc, CollectionError) else type(exc).__name__
        print(json.dumps({"complete": False, "error": reason}), file=sys.stderr)
        return 1
    print(json.dumps(manifest, indent=2, ensure_ascii=True))
    return 0 if manifest["complete"] else 1


if __name__ == "__main__":
    sys.exit(main())
