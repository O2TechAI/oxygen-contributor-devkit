#!/usr/bin/env python3
"""Label each physical UTF-8 Markdown line in a separate, private evidence copy."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys


def physical_lines(data):
    """Split only at LF, retaining LF/CRLF and a final unterminated line.

    An ending LF terminates its line; it does not create a phantom extra line.
    Blank lines, headings, list items, tables, and code all receive IDs.
    """
    data.decode("utf-8")
    return re.findall(rb"[^\n]*\n|[^\n]+$", data)


def label_bytes(data):
    return b"".join(
        f"L{number:03d} ".encode("ascii") + line
        for number, line in enumerate(physical_lines(data), 1)
    )


def markdown_lines(data):
    """Classify ATX headings without treating fenced code as document structure."""
    fence = None
    for raw in physical_lines(data):
        text = raw.decode("utf-8").rstrip("\r\n")
        marker = re.match(r"^ {0,3}(`{3,}|~{3,})(.*)$", text)
        kind = "content"
        if fence:
            if marker and marker[1][0] == fence[0] and len(marker[1]) >= len(fence) and not marker[2].strip():
                kind, fence = "layout", None
        elif marker:
            kind, fence = "layout", marker[1]
        elif re.match(r"^ {0,3}#{1,6}(?:\s|$)", text):
            kind = "heading"
        elif re.fullmatch(r"\s*(?:[-*_]\s*){3,}", text) or re.fullmatch(r"\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*", text):
            kind = "layout"
        if not text.strip():
            kind = "layout"
        yield kind, text


def evidence_lines(data):
    """IDs with content; headings and formatting-only lines are navigation."""
    return {f"L{number:03d}": text for number, (kind, text)
            in enumerate(markdown_lines(data), 1) if kind == "content"}


def read_regular(path):
    if path.is_symlink():
        raise ValueError("input_symlink")
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    with os.fdopen(fd, "rb") as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode):
            raise ValueError("input_not_regular")
        data = stream.read()
        after = os.fstat(stream.fileno())
    signature = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns)
    if signature(before) != signature(after) or signature(before) != signature(path.lstat()):
        raise ValueError("input_changed_during_read")
    return data


def label_file(source, destination):
    source, destination = Path(source), Path(destination)
    if source.resolve() == destination.resolve():
        raise ValueError("output_must_differ_from_input")
    data = read_regular(source)
    labeled = label_bytes(data)
    fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "wb") as stream:
            if hasattr(os, "fchmod"):
                os.fchmod(stream.fileno(), 0o600)
            stream.write(labeled)
            stream.flush()
            os.fsync(stream.fileno())
        if read_regular(source) != data:
            raise ValueError("input_changed_during_labeling")
    except BaseException:
        destination.unlink()
        raise
    return {
        "physical_lines": len(physical_lines(data)),
        "source_sha256": hashlib.sha256(data).hexdigest(),
        "labeled_sha256": hashlib.sha256(labeled).hexdigest(),
        "source_bytes": len(data),
        "labeled_bytes": len(labeled),
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input_markdown", type=Path)
    parser.add_argument("output_markdown", type=Path, help="New file; parent directory must exist")
    args = parser.parse_args(argv)
    try:
        result = label_file(args.input_markdown, args.output_markdown)
    except (OSError, ValueError, UnicodeError) as exc:
        # Parser errors and source text must not leak into diagnostics.
        print(json.dumps({"status": "error", "reason": type(exc).__name__}), file=sys.stderr)
        return 1
    print(json.dumps({"status": "complete", **result}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
