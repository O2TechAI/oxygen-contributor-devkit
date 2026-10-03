#!/usr/bin/env python3
"""Prepare the review app's initial data from a completed redacted collection."""

import argparse
import json
from pathlib import Path
import re


def prepare(collection: Path):
    manifest = json.loads((collection / "processing-manifest.json").read_text())
    if manifest.get("complete") is not True:
        raise ValueError("The processed collection is not complete")
    reviews = []
    for number in range(1, manifest["trajectory_count"] + 1):
        key = f"trajectory-{number:03d}"
        directory = collection / key
        summary = []
        for number, line in enumerate((directory / "summary_redacted.md").read_text().splitlines(), 1):
            match = re.fullmatch(r"(L\d{3,})\s+(.+)", line)
            if not match or match[1] != f"L{number:03d}":
                raise ValueError(f"{key}: invalid summary line sequence")
            summary.append({"id": match[1], "originalText": match[2], "text": match[2]})
        valid = {line["id"] for line in summary}
        insights = []
        for section in re.split(r"^#\s+(?=I\d{3,}\s*$)", (directory / "insight_redacted.md").read_text(), flags=re.M):
            if not section.strip():
                continue
            lines = section.strip().splitlines()
            identifier = lines.pop(0).strip()
            if identifier != f"I{len(insights) + 1:03d}":
                raise ValueError(f"{key}: invalid insight sequence")
            evidence_lines = [line for line in lines if line.startswith("Evidence:")]
            if len(evidence_lines) != 1:
                raise ValueError(f"{key}: missing or duplicate evidence declaration")
            evidence = [ref.strip() for ref in evidence_lines[0].removeprefix("Evidence:").split(",")]
            if not evidence or not set(evidence) <= valid:
                raise ValueError(f"{key}: invalid evidence references")
            text = "\n".join(line for line in lines if line != evidence_lines[0]).strip()
            if not text:
                raise ValueError(f"{key}: empty insight")
            title = re.sub(r"[*_`#]", "", re.split(r"(?<=[.!?])\s", text)[0])
            if len(title) > 72:
                title = title[:69] + "…"
            insights.append({"id": identifier, "title": title, "originalText": text,
                             "text": text, "evidence": evidence, "status": "pending"})
        if not summary or not insights:
            raise ValueError(f"{key}: empty review")
        reviews.append({"id": f"oxygen-20260907-{key}", "projectName": key.replace("trajectory-", "Trajectory "),
                        "sourcePath": key, "status": "ready", "generatedAt": "2026-09-07T00:00:00.000Z",
                        "updatedAt": "2026-09-07T00:00:00.000Z", "revisionCount": 0,
                        "summaryLines": summary, "insights": insights})
    return reviews


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("collection", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    reviews = prepare(args.collection)
    args.output.write_text(json.dumps(reviews, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"reviews": len(reviews), "summary_lines": sum(len(r["summaryLines"]) for r in reviews),
                      "insights": sum(len(r["insights"]) for r in reviews)}))
