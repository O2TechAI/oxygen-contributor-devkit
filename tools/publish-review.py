#!/usr/bin/env python3
"""Register a legacy output pair or verified Oxygen run for human review."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True, help="Contributed project name")
    parser.add_argument(
        "--source",
        required=True,
        help="Display-safe source identifier (never use a sensitive local path)",
    )
    parser.add_argument(
        "--run-dir",
        type=Path,
        help="Completed INPUT.oxygen-agents directory with a readable/labeled summary and insights",
    )
    parser.add_argument(
        "--humanize-comparison",
        type=Path,
        help="Accepted single-session Humanizer comparison case derived from a saved review",
    )
    parser.add_argument(
        "--stage",
        choices=("redaction", "insight", "humanize"),
        default="redaction",
        help="Completed stage to review (default: redaction)",
    )
    parser.add_argument("--summary", type=Path, help="Legacy summary.md path")
    parser.add_argument("--insight", type=Path, help="Legacy insight.md path")
    parser.add_argument(
        "--server",
        default="http://localhost:3000",
        help="Oxygen Review server URL (default: http://localhost:3000)",
    )
    return parser.parse_args()


def read_utf8(path: Path) -> tuple[bytes, str]:
    data = path.read_bytes()
    return data, data.decode("utf-8")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def v5_payload(args: argparse.Namespace) -> dict[str, object]:
    run = args.run_dir.resolve()
    manifest_data, manifest_text = read_utf8(run / "manifest.json")
    manifest = json.loads(manifest_text)
    protocol_version = manifest.get("configuration", {}).get("protocol_version")
    if type(protocol_version) is not int or not 0 < protocol_version <= 9007199254740991:
        raise ValueError("run manifest protocol_version must be a positive safe integer")
    stage = manifest.get("stages", {}).get(args.stage, {})
    if stage.get("status") != "complete":
        raise ValueError(f"{args.stage} stage is not complete")
    if args.stage == "redaction" and manifest.get("complete") is not True:
        raise ValueError("privacy-redaction run is not complete")

    names = (
        {
            "summary": "summary_redacted.md",
            "labeled": "summary_redacted_labeled.md",
            "insight": "insight_redacted.md",
        }
        if args.stage == "redaction"
        else {
            "summary": "summary.md",
            "labeled": "summary_labeled.md",
            "insight": "insight.md",
        }
    )
    contents: dict[str, str] = {}
    expected = stage.get("outputs", {}).get("sha256", {})
    for key, name in names.items():
        data, text = read_utf8(run / args.stage / name)
        if expected.get(name) != sha256(data):
            raise ValueError(f"manifest hash mismatch for {name}")
        contents[key] = text

    return {
        "projectName": args.project,
        "sourcePath": args.source,
        "format": "v5",
        "protocolVersion": protocol_version,
        "stage": args.stage,
        "summaryMarkdown": contents["summary"],
        "summaryLabeledMarkdown": contents["labeled"],
        "insightMarkdown": contents["insight"],
        "manifestJson": manifest_text,
        "manifestSha256": sha256(manifest_data),
    }


def legacy_payload(args: argparse.Namespace) -> dict[str, object]:
    if not args.summary or not args.insight or not args.source:
        raise ValueError(
            "legacy publishing requires --source, --summary, and --insight"
        )
    return {
        "projectName": args.project,
        "sourcePath": args.source,
        "summaryMarkdown": args.summary.read_text(encoding="utf-8"),
        "insightMarkdown": args.insight.read_text(encoding="utf-8"),
    }


def comparison_payload(args: argparse.Namespace) -> dict[str, object]:
    """Import a review-derived draft without claiming original extraction provenance."""
    case = args.humanize_comparison.resolve()

    def checked(root, name, expected):
        relative = Path(name)
        if relative.is_absolute() or ".." in relative.parts:
            raise ValueError("invalid comparison artifact path")
        path = root
        for part in relative.parts:
            path = path / part
            if path.is_symlink():
                raise ValueError("comparison artifacts must not be symlinks")
        data = path.read_bytes()
        if sha256(data) != expected:
            raise ValueError(f"comparison hash mismatch for {name}")
        return data

    manifest = json.loads((case / "manifest.json").read_bytes())
    state = json.loads((case / "state.json").read_bytes())
    experiment = json.loads((case.parent / "experiment.json").read_bytes())
    if manifest.get("kind") != "single" or manifest.get("sourceKind") != "current-saved-review":
        raise ValueError("expected a single-session saved-review comparison")
    if state.get("status") != "accepted":
        raise ValueError("Humanizer comparison has not been accepted")
    for name, digest in experiment["protectedHashes"].items():
        checked(case.parent, name, digest)
    inputs = {name: checked(case, name, digest) for name, digest in manifest["inputHashes"].items()}
    output = checked(case, "after.md", state["outputHashes"]["after.md"])
    snapshot = json.loads(inputs["review-snapshot.json"])
    contents = {"summary.md": inputs["summary.md"],
                "summary_labeled.md": inputs["summary_labeled.md"], "insight.md": output}
    settings = experiment["settings"]
    draft_manifest = {
        "format": "oxygen-review-humanization/v1",
        "complete": False,
        "configuration": {"protocol_version": 9, "model": settings["model"],
                          "reasoning_effort": settings["reasoning_effort"]},
        "reviewerAddedIds": [card["id"] for card in snapshot["insights"]
                             if card.get("authorship") == "reviewer"],
        "stages": {"humanize": {"status": "complete", "outputs": {"sha256": {
            name: sha256(data) for name, data in contents.items()}}}},
    }
    return {
        "projectName": args.project, "sourcePath": args.source, "format": "v5",
        "protocolVersion": 9, "stage": "humanize",
        "summaryMarkdown": contents["summary.md"].decode("utf-8"),
        "summaryLabeledMarkdown": contents["summary_labeled.md"].decode("utf-8"),
        "insightMarkdown": output.decode("utf-8"),
        "manifestJson": json.dumps(draft_manifest, ensure_ascii=False),
    }


def main() -> int:
    args = parse_args()
    if sum(bool(value) for value in (args.run_dir, args.humanize_comparison, args.summary or args.insight)) > 1:
        print("Choose one input: --run-dir, --humanize-comparison, or --summary/--insight", file=sys.stderr)
        return 2
    try:
        payload = (v5_payload(args) if args.run_dir else comparison_payload(args)
                   if args.humanize_comparison else legacy_payload(args))
    except (OSError, UnicodeError, ValueError, KeyError, TypeError) as error:
        print(f"Unable to prepare review: {error}", file=sys.stderr)
        return 1

    request = urllib.request.Request(
        f"{args.server.rstrip('/')}/api/reviews",
        data=json.dumps(payload).encode("utf-8"),
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            result = json.load(response)
    except (OSError, urllib.error.HTTPError, json.JSONDecodeError) as error:
        print(f"Unable to publish review: {error}", file=sys.stderr)
        return 1

    review = result["review"]
    print(f"Review ready: {args.server.rstrip('/')} (id: {review['id']})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
