#!/usr/bin/env python3
"""Read a run's frozen source in fixed parts that each fit one tool output, recording every read.

  read_source.py plan --stage STAGE     how many parts there are and which are still unread
  read_source.py part N --stage STAGE   print part N (1-based) whole and record a receipt

A run's frozen copy lives in RUN_DIR/protocol/ and reads that run, so workers never
retype the run path; `--run-dir` selects another run.

Parts are cut deterministically from the frozen bytes: at most PART_BYTES each, ending
after the last line break inside the part, or inside an over-long line at a UTF-8
boundary when the part has no line break. The parent recomputes the same parts from
the same frozen file and accepts a stage only when every part has a receipt from it.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import time

# Comfortably under the ~10,000-token output cap of Codex commands and the 30,000-character
# Bash output cap of Claude Code, including for dense code, JSON and CJK text.
PART_BYTES = 16_000
STAGES = ("summary", "insight")


def frozen_source(run):
    manifest = json.loads((Path(run) / "manifest.json").read_bytes())
    return Path(run) / manifest["frozen_file"]


def parts(data, limit=PART_BYTES):
    """(start, end) byte ranges covering data exactly once, in order."""
    bounds, start = [], 0
    while start < len(data):
        end = min(start + limit, len(data))
        if end < len(data):
            newline = data.rfind(b"\n", start, end)
            if newline >= start:
                end = newline + 1
            else:
                # One line longer than a part: never split a UTF-8 code point.
                while end > start + 1 and data[end] & 0xC0 == 0x80:
                    end -= 1
        bounds.append((start, end))
        start = end
    return bounds


def receipts_path(run, stage):
    return Path(run) / "reading" / f"{stage}.jsonl"


def receipts(run, stage):
    """Part number -> sha256 of the content that was printed for this stage."""
    path = receipts_path(run, stage)
    seen = {}
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if isinstance(row, dict) and isinstance(row.get("part"), int):
                seen[row["part"]] = row.get("sha256")
    return seen


def read_part(run, stage, number):
    """Return part `number` and append a receipt for it."""
    if stage not in STAGES:
        raise ValueError("unknown_stage")
    data = frozen_source(run).read_bytes()
    bounds = parts(data)
    if not 1 <= number <= len(bounds):
        raise ValueError(f"part must be between 1 and {len(bounds)}")
    start, end = bounds[number - 1]
    content = data[start:end]
    folder = Path(run) / "reading"
    folder.mkdir(mode=0o700, exist_ok=True)
    row = {"part": number, "start": start, "end": end, "sha256": hashlib.sha256(content).hexdigest(),
           "source_sha256": hashlib.sha256(data).hexdigest(), "at": time.time()}
    fd = os.open(receipts_path(run, stage), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    with os.fdopen(fd, "a", encoding="utf-8") as stream:
        stream.write(json.dumps(row) + "\n")
    return content, start, end, len(data), len(bounds)


def plan(run, stage):
    data = frozen_source(run).read_bytes()
    bounds = parts(data)
    seen = receipts(run, stage)
    unread = [number for number, (start, end) in enumerate(bounds, 1)
              if seen.get(number) != hashlib.sha256(data[start:end]).hexdigest()]
    return {"source": frozen_source(run).name, "bytes": len(data), "parts": len(bounds),
            "part_bytes": PART_BYTES, "stage": stage, "unread": len(unread),
            "next_unread_part": unread[0] if unread else None}


def own_run():
    """The run whose protocol folder holds this copy, if it is one."""
    run = Path(__file__).resolve().parent.parent
    return run if (run / "manifest.json").is_file() else None


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("action", choices=("plan", "part"))
    parser.add_argument("number", nargs="?", type=int, help="1-based part number, for `part`")
    parser.add_argument("--stage", required=True, choices=STAGES)
    parser.add_argument("--run-dir", help="Run to read; defaults to the run this copy belongs to")
    args = parser.parse_args(argv)
    args.run_dir = args.run_dir or own_run()
    if args.run_dir is None:
        parser.error("--run-dir is required outside a run's protocol folder")
    try:
        if args.action == "plan":
            print(json.dumps(plan(args.run_dir, args.stage)))
            return 0
        if args.number is None:
            parser.error("part needs a part number")
        content, start, end, total, count = read_part(args.run_dir, args.stage, args.number)
    except (OSError, ValueError, KeyError) as exc:
        print(json.dumps({"status": "error", "reason": str(exc)[:200]}), file=sys.stderr)
        return 1
    continued = start > 0 and not frozen_source(args.run_dir).read_bytes()[start - 1:start] == b"\n"
    header = f"[part {args.number}/{count} · bytes {start}-{end} of {total}"
    header += " · continues the previous part's line]\n" if continued else "]\n"
    out = sys.stdout.buffer
    out.write(header.encode())
    out.write(content)
    if not content.endswith(b"\n"):
        out.write(b"\n")
    out.write(f"[end of part {args.number}/{count}]\n".encode())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
