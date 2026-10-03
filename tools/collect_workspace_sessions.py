#!/usr/bin/env python3
"""Collect private, unchanged prefixes of main Codex sessions for a workspace."""

import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import tempfile


MAIN_SOURCES = {"cli", "vscode", "exec"}
CHUNK_SIZE = 1024 * 1024
HEADER_LIMIT = 1024 * 1024


class CollectionError(Exception):
    """A content-free diagnostic code, safe to put in the manifest."""


def normalized(path):
    return Path(path).expanduser().resolve(strict=False)


def within(path, root):
    return path == root or root in path.parents


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise CollectionError("duplicate_header_key")
        result[key] = value
    return result


def _reject_constant(value):
    raise CollectionError("invalid_header_constant")


@contextmanager
def open_source(path):
    # O_NONBLOCK prevents a replaced candidate FIFO from blocking the scan.
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise CollectionError("source_not_regular")
        yield stream


def read_metadata(stream, observed_bytes):
    raw = stream.readline(min(observed_bytes, HEADER_LIMIT) + 1)
    if len(raw) > min(observed_bytes, HEADER_LIMIT) or not raw.endswith(b"\n"):
        raise CollectionError("incomplete_or_oversized_header")
    try:
        row = json.loads(raw, object_pairs_hook=_unique_object,
                         parse_constant=_reject_constant)
    except (ValueError, UnicodeError, RecursionError) as exc:
        raise CollectionError("malformed_header") from exc
    if not isinstance(row, dict) or row.get("type") != "session_meta":
        raise CollectionError("missing_session_metadata")
    meta = row.get("payload")
    if not isinstance(meta, dict):
        raise CollectionError("invalid_session_metadata")
    return meta


def classify(meta, workspace):
    source = meta.get("source")
    if source == "subagent" or isinstance(source, dict) and "subagent" in source:
        return "subagent"
    if not isinstance(source, str) or source not in MAIN_SOURCES:
        return "unclassified"
    if not isinstance(meta.get("id"), str) or not meta["id"]:
        return "unclassified"
    cwd = meta.get("cwd")
    if not isinstance(cwd, str) or not cwd or "\x00" in cwd or not Path(cwd).is_absolute():
        return "unclassified"
    return "selected" if within(normalized(cwd), workspace) else "outside_workspace"


def _identity(info):
    return info.st_dev, info.st_ino


def _complete_prefix_length(stream, observed_bytes):
    cursor = observed_bytes
    while cursor:
        start = max(0, cursor - CHUNK_SIZE)
        block = os.pread(stream.fileno(), cursor - start, start)
        if len(block) != cursor - start:
            raise CollectionError("source_truncated")
        newline = block.rfind(b"\n")
        if newline >= 0:
            return start + newline + 1
        cursor = start
    raise CollectionError("no_complete_records")


def _read_prefix(stream, length, destination=None):
    digest = hashlib.sha256()
    remaining = length
    while remaining:
        # Positional reads bypass the buffered metadata reader, including on verification.
        block = os.pread(stream.fileno(), min(remaining, CHUNK_SIZE), length - remaining)
        if not block:
            raise CollectionError("source_truncated")
        digest.update(block)
        if destination is not None:
            destination.write(block)
        remaining -= len(block)
    return digest.hexdigest()


def _verify_prefix(stream, path, initial, length, digest):
    if _read_prefix(stream, length) != digest:
        raise CollectionError("source_prefix_changed")
    current = os.fstat(stream.fileno())
    at_path = path.stat(follow_symlinks=False)
    if not stat.S_ISREG(at_path.st_mode) or _identity(initial) != _identity(at_path):
        raise CollectionError("source_replaced")
    if current.st_size < initial.st_size or at_path.st_size < initial.st_size:
        raise CollectionError("source_truncated")
    # Appends may change mtime. Same-size edits cannot be an append.
    if current.st_size == initial.st_size and current.st_mtime_ns != initial.st_mtime_ns:
        raise CollectionError("source_modified")


def freeze_source(stream, path, initial, metadata, snapshots):
    length = _complete_prefix_length(stream, initial.st_size)
    fd, temp_name = tempfile.mkstemp(prefix=".collect-", dir=snapshots)
    temporary = Path(temp_name)
    try:
        with os.fdopen(fd, "w+b") as destination:
            os.fchmod(destination.fileno(), 0o600)
            digest = _read_prefix(stream, length, destination)
            destination.flush()
            os.fsync(destination.fileno())
            destination.seek(0)
            if read_metadata(destination, length) != metadata:
                raise CollectionError("source_metadata_changed")
        _verify_prefix(stream, path, initial, length, digest)
        name = hashlib.sha256(os.fsencode(str(path))).hexdigest() + ".jsonl"
        target = snapshots / name
        # Exclusive publication also protects against even a filename hash collision.
        os.link(temporary, target)
        return target, digest, length
    finally:
        temporary.unlink(missing_ok=True)


def _error(manifest, path, reason):
    manifest["errors"].append({"source_path": str(path), "reason": reason})


def _exclude(manifest, path, reason):
    manifest["exclusions"].append({"source_path": str(path), "reason": reason})
    counts = manifest["counts"]["excluded_by_reason"]
    counts[reason] = counts.get(reason, 0) + 1


def discover(roots, manifest):
    paths = []
    for root in roots:
        try:
            info = root.lstat()
        except FileNotFoundError:
            manifest["missing_roots"].append(str(root))
            if root.name == "sessions":
                _error(manifest, root, "missing_sessions_root")
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


def collect(workspace, codex_home=None, output_dir=None, dry_run=False):
    workspace = normalized(workspace)
    if not workspace.is_dir():
        raise CollectionError("workspace_must_be_directory")
    default_home = normalized(os.environ.get("CODEX_HOME") or Path.home() / ".codex")
    home = normalized(codex_home) if codex_home is not None else default_home
    roots = [home / "sessions", home / "archived_sessions"]
    output = None
    if output_dir is not None:
        output = normalized(output_dir)
        # Protect both selected storage and ordinary live storage when using an override.
        protected = [base / name for base in {home, default_home, normalized(Path.home() / ".codex")}
                     for name in ("sessions", "archived_sessions")]
        if any(within(output, normalized(root)) for root in protected):
            raise CollectionError("output_inside_session_storage")
        if os.path.lexists(Path(output_dir).expanduser()) or output.exists():
            raise CollectionError("output_already_exists")
        if not output.parent.is_dir():
            raise CollectionError("output_parent_must_exist")
    if not dry_run and output is None:
        raise CollectionError("output_dir_required")

    manifest = {
        "schema": "oxygen-workspace-sessions", "version": 1,
        "workspace": str(workspace), "codex_home": str(home), "dry_run": dry_run,
        "searched_roots": [str(root) for root in roots], "missing_roots": [],
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
        try:
            with open_source(path) as stream:
                initial = os.fstat(stream.fileno())
                meta = read_metadata(stream, initial.st_size)
                decision = classify(meta, workspace)
                if decision != "selected":
                    _exclude(manifest, path, decision)
                    if decision == "unclassified":
                        _error(manifest, path, "unclassified_metadata")
                    continue
                manifest["counts"]["selected"] += 1
                entry = {"source_path": str(path), "session_id": meta["id"], "cwd": meta["cwd"]}
                if dry_run:
                    manifest["sessions"].append(entry)
                    continue
                target, digest, length = freeze_source(stream, path, initial, meta, snapshots)
                location = {"source_path": str(path), "observed_bytes": initial.st_size,
                            "omitted_trailing_bytes": initial.st_size - length}
                key = (meta["id"], digest, length)
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
    parser.add_argument("--codex-home", help="Codex home; defaults to CODEX_HOME or ~/.codex")
    parser.add_argument("--output-dir", help="New private directory; parent must exist")
    parser.add_argument("--dry-run", action="store_true", help="Discover only, without creating files")
    args = parser.parse_args(argv)
    try:
        manifest = collect(args.workspace, args.codex_home, args.output_dir, args.dry_run)
    except (CollectionError, OSError, ValueError) as exc:
        reason = str(exc) if isinstance(exc, CollectionError) else type(exc).__name__
        print(json.dumps({"complete": False, "error": reason}), file=sys.stderr)
        return 1
    print(json.dumps(manifest, indent=2, ensure_ascii=True))
    return 0 if manifest["complete"] else 1


if __name__ == "__main__":
    sys.exit(main())
