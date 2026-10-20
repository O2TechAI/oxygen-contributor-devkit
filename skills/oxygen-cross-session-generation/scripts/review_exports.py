"""Read completed protocol-9 review exports without modifying their files.

Only extracted current collection/single-export directories are supported. The
snapshot is canonical; approval identities, label counts, and every Markdown
view must agree with it before any cards become cross-session input.
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path, PurePosixPath
from typing import Any


EXPORT_FILES = (
    "summary.md", "summary_labeled.md", "insight.md", "insight_reviewed.md",
    "insight_declined.md", "review.json", "approval.json",
)
CARD_FIELDS = ("title", "type", "description", "workflow", "example")
CARD_KEYS = [*CARD_FIELDS, "evidence"]


def _fail(where: str, message: str) -> None:
    raise ValueError(f"{where}: {message}")


def _object(value: Any, where: str) -> dict:
    if not isinstance(value, dict):
        _fail(where, "expected a JSON object")
    return value


def _array(value: Any, where: str) -> list:
    if not isinstance(value, list):
        _fail(where, "expected a JSON array")
    return value


def _string(value: Any, where: str, *, nonempty: bool = True) -> str:
    if not isinstance(value, str) or (nonempty and not value.strip()):
        _fail(where, "expected a nonempty string" if nonempty else "expected a string")
    return value


def _equal(value: Any, expected: Any, where: str) -> None:
    # JSON booleans must not pass as integer counts (True == 1 in Python).
    if type(value) is not type(expected) or value != expected:
        _fail(where, f"expected {expected!r}; found {value!r}")


def _integer(value: Any, where: str) -> int:
    if type(value) is not int or value < 0:
        _fail(where, "expected a nonnegative integer")
    return value


def _identifier(value: Any, prefix: str, where: str) -> str:
    value = _string(value, where)
    if not re.fullmatch(prefix + r"\d{3,}", value):
        _fail(where, f"expected a {prefix} followed by at least three digits")
    return value


def _json(raw: bytes, where: str) -> dict:
    def pairs(items: list) -> dict:
        result: dict = {}
        for key, value in items:
            if key in result:
                _fail(where, f"duplicate JSON key {key!r}")
            result[key] = value
        return result

    def constant(value: str) -> None:
        _fail(where, f"invalid JSON constant {value}")

    try:
        return _object(json.loads(raw.decode("utf-8"), object_pairs_hook=pairs,
                                  parse_constant=constant), where)
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError) as exc:
        _fail(where, f"invalid JSON: {exc}")


def _sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":")).encode("utf-8")


def _summary_kinds(lines: list[dict]) -> list[str]:
    """Match classifySummaryLines in review-app/lib/v5-format.ts."""
    fence: tuple[str, int] | None = None
    result = []
    for line in lines:
        value = line["text"]
        marker = re.match(r"^ {0,3}(`{3,}|~{3,})(.*)$", value)
        kind = "content"
        if fence:
            if (marker and marker[1][0] == fence[0]
                    and len(marker[1]) >= fence[1] and not marker[2].strip()):
                kind, fence = "layout", None
        elif marker:
            kind, fence = "layout", (marker[1][0], len(marker[1]))
        elif re.match(r"^ {0,3}#{1,6}(?:\s|$)", value):
            kind = "heading"
        elif (not value.strip() or re.fullmatch(r"\s*(?:[-*_]\s*){3,}", value)
              or re.fullmatch(r"\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*", value)):
            kind = "layout"
        result.append(kind)
    return result


def _summary(value: Any, where: str) -> list[dict]:
    result = []
    for index, item in enumerate(_array(value, where)):
        here = f"{where}[{index}]"
        item = _object(item, here)
        _equal(item.get("id"), f"L{index + 1:03d}", f"{here}.id")
        text = _string(item.get("text"), f"{here}.text", nonempty=False)
        if "\n" in text or "\r" in text:
            _fail(f"{here}.text", "must contain one physical line without its ending")
        ending = item.get("ending", "\n")
        if not isinstance(ending, str) or ending not in ("", "\n", "\r\n"):
            _fail(f"{here}.ending", "expected '', LF, or CRLF")
        if index < len(value) - 1 and not ending:
            _fail(f"{here}.ending", "only the last physical line may omit an ending")
        normalized = {"id": item["id"], "text": text, "ending": ending}
        if "sourceId" in item:
            normalized["sourceId"] = _identifier(item["sourceId"], "L", f"{here}.sourceId")
        kind = item.get("kind", "content")
        if not isinstance(kind, str) or kind not in ("heading", "content", "layout"):
            _fail(f"{here}.kind", "expected heading, content, or layout")
        normalized["kind"] = kind
        result.append(normalized)
    if not result:
        _fail(where, "summary must contain at least one line")
    for index, kind in enumerate(_summary_kinds(result)):
        _equal(result[index]["kind"], kind, f"{where}[{index}].kind")
    return result


def _label_counts(value: Any, accepted: int, declined: int, where: str) -> None:
    value = _object(value, where)
    expected = {"accepted": accepted, "declined": declined, "pending": 0,
                "needsReview": 0, "incompleteReviews": 0}
    for key, count in expected.items():
        _equal(value.get(key), count, f"{where}.{key}")


def _serialize(cards: list[dict], *, accepted: bool = False) -> str:
    """Exact protocol-9 serializeInsights output, including export renumbering."""
    if accepted:
        cards = [card for card in cards if card["decision"] == "accepted"]
    blocks = []
    for index, card in enumerate(cards):
        identifier = f"I{index + 1:03d}" if accepted else card["currentId"]
        blocks.append("\n".join([
            f"# {identifier}", "", f"Title: {card['title']}",
            f"Type: {card['type']}", "Description:", "", card["description"], "",
            "Workflow:", "", card["workflow"], "", "Example:", "",
            card["example"], "", f"Evidence: {', '.join(card['evidence'])}",
        ]))
    return "\n\n".join(blocks) + ("\n" if cards else "")


def _cards(value: Any, decisions: Any, lines: list[dict], where: str,
           approval_where: str) -> list[dict]:
    values = _array(value, where)
    decisions = _array(decisions, approval_where)
    _equal(len(decisions), len(values), f"{approval_where}.length")
    content_ids = {line["id"] for line in lines if line["kind"] == "content"}
    seen: set[str] = set()
    originals: set[str] = set()
    cards = []
    accepted_count = 0
    for index, value in enumerate(values):
        here, decision_where = f"{where}[{index}]", f"{approval_where}[{index}]"
        value, decision = _object(value, here), _object(decisions[index], decision_where)
        identifier = _identifier(value.get("id"), "I", f"{here}.id")
        if identifier in seen:
            _fail(f"{here}.id", f"duplicate card ID {identifier}")
        seen.add(identifier)
        authorship = value.get("authorship", "generated")
        if not isinstance(authorship, str) or authorship not in ("reviewer", "generated"):
            _fail(f"{here}.authorship", "expected reviewer or generated")
        original = None if authorship == "reviewer" else _identifier(
            value.get("sourceId", identifier), "I", f"{here}.sourceId")
        if "sourceId" in value:
            _identifier(value["sourceId"], "I", f"{here}.sourceId")
        if original is not None:
            if original in originals:
                _fail(f"{here}.sourceId", f"duplicate original card ID {original}")
            originals.add(original)
        status = value.get("status")
        if not isinstance(status, str) or status not in ("accepted", "rejected"):
            _fail(f"{here}.status", "labeling incomplete: expected accepted or rejected")
        _equal(value.get("savedStatus"), status, f"{here}.savedStatus")
        _equal(value.get("defaultAccepted"), False, f"{here}.defaultAccepted")
        accepted_count += status == "accepted"
        export_id = f"I{accepted_count:03d}" if status == "accepted" else None
        for key, expected in {
            "sourceId": original, "authorship": authorship, "reviewId": identifier,
            "reviewedExportId": identifier, "status": status, "savedStatus": status,
            "defaultAccepted": False, "exportId": export_id,
        }.items():
            if key not in decision:
                _fail(f"{decision_where}.{key}", "missing required decision field")
            _equal(decision[key], expected, f"{decision_where}.{key}")
        card = {"id": identifier, "currentId": identifier, "originalId": original,
                "acceptedExportId": export_id, "authorship": authorship,
                "decision": status}
        for key in CARD_FIELDS:
            card[key] = _string(value.get(key), f"{here}.{key}")
        if card["type"] not in ("agent", "user-agent"):
            _fail(f"{here}.type", "protocol 9 requires agent or user-agent")
        if "presentKeys" in value:
            _equal(value["presentKeys"], CARD_KEYS, f"{here}.presentKeys")
        evidence = _array(value.get("evidence"), f"{here}.evidence")
        evidence_seen: set[str] = set()
        for i, ref in enumerate(evidence):
            ref_where = f"{here}.evidence[{i}]"
            ref = _identifier(ref, "L", ref_where)
            if ref not in content_ids:
                _fail(ref_where, f"{ref} is not a current content-line reference")
            if ref in evidence_seen:
                _fail(ref_where, f"duplicate reference {ref}")
            evidence_seen.add(ref)
        if authorship == "generated" and not evidence:
            _fail(f"{here}.evidence", "generated cards require content-line evidence")
        card["evidence"] = list(evidence)
        reasons = [entry[key] for entry in (value, decision)
                   for key in ("rejectionReason", "reason") if key in entry]
        for reason in reasons:
            if reason is not None:
                _string(reason, f"{here}.rejectionReason")
        if reasons and any(reason != reasons[0] for reason in reasons):
            _fail(f"{here}.rejectionReason", "snapshot and approval reasons disagree")
        card["rejectionReason"] = reasons[0] if reasons else None
        cards.append(card)
    return cards


def _read_source(directory: str, data: dict[str, bytes], metadata: dict | None) -> dict:
    def filename(name: str) -> str:
        return name if directory == "." else f"{directory}/{name}"

    def raw(name: str) -> bytes:
        path = filename(name)
        if path not in data:
            _fail(path, "required export file is missing")
        return data[path]

    snapshot_path, approval_path = filename("review.json"), filename("approval.json")
    snapshot = _json(raw("review.json"), snapshot_path)
    if snapshot.get("reviewLevel") == "global":
        _fail(snapshot_path, "global reviews are second-stage outputs, not individual trajectories")
    approval = _json(raw("approval.json"), approval_path)
    _equal(snapshot.get("format"), "oxygen-review-snapshot/v1", f"{snapshot_path}.format")
    _equal(approval.get("format"), "oxygen-human-review/v1", f"{approval_path}.format")
    _equal(snapshot.get("protocolVersion"), 9, f"{snapshot_path}.protocolVersion")
    _equal(snapshot.get("exportScope"), "latest", f"{snapshot_path}.exportScope")
    _equal(snapshot.get("status"), "completed", f"{snapshot_path}.status")
    for key in ("reviewId", "projectName", "sourcePath", "sourceStage", "privacyStatus"):
        _string(snapshot.get(key), f"{snapshot_path}.{key}")
    _integer(snapshot.get("revisionCount"), f"{snapshot_path}.revisionCount")
    for key in ("reviewId", "projectName", "protocolVersion", "sourceStage", "privacyStatus", "status"):
        _equal(approval.get(key), snapshot[key], f"{approval_path}.{key}")
    _string(approval.get("generatedAt"), f"{approval_path}.generatedAt")
    _string(approval.get("reviewedAt"), f"{approval_path}.reviewedAt")
    current_where = f"{snapshot_path}.current"
    current = _object(snapshot.get("current"), current_where)
    trajectory = _object(current.get("trajectorySummary"), f"{current_where}.trajectorySummary")
    _string(trajectory.get("text"), f"{current_where}.trajectorySummary.text", nonempty=False)
    groups = _array(current.get("summaryGroups"), f"{current_where}.summaryGroups")
    for index, group in enumerate(groups):
        where = f"{current_where}.summaryGroups[{index}]"
        group = _object(group, where)
        _string(group.get("id"), f"{where}.id")
        _string(group.get("text"), f"{where}.text", nonempty=False)
        for line_index, line_id in enumerate(_array(group.get("lineIds"), f"{where}.lineIds")):
            _identifier(line_id, "L", f"{where}.lineIds[{line_index}]")
    lines = _summary(current.get("summaryLines"), f"{current_where}.summaryLines")
    line_ids = {line["id"] for line in lines}
    for index, group in enumerate(groups):
        if any(line_id not in line_ids for line_id in group["lineIds"]):
            _fail(f"{current_where}.summaryGroups[{index}].lineIds", "unknown current summary line")
    cards = _cards(current.get("insights"), approval.get("decisions"), lines,
                   f"{current_where}.insights", f"{approval_path}.decisions")
    accepted = sum(card["decision"] == "accepted" for card in cards)
    declined = len(cards) - accepted
    _label_counts(snapshot.get("exportLabeling"), accepted, declined, f"{snapshot_path}.exportLabeling")
    _label_counts(approval.get("exportLabeling"), accepted, declined, f"{approval_path}.exportLabeling")
    if metadata is not None:
        where = f"manifest.json.reviews[directory={directory!r}]"
        for key in ("reviewId", "projectName", "sourcePath", "status", "privacyStatus", "revisionCount"):
            _equal(metadata.get(key), snapshot[key], f"{where}.{key}")
        _equal(metadata.get("updatedAt"), approval["reviewedAt"], f"{where}.updatedAt")
        for key, count in {"acceptedInsightCount": accepted, "declinedInsightCount": declined,
                           "insightCount": len(cards), "defaultAcceptedInsightCount": 0,
                           "labelingComplete": True}.items():
            _equal(metadata.get(key), count, f"{where}.{key}")
    markdown = {
        "summary.md": "".join(line["text"] + line["ending"] for line in lines),
        "summary_labeled.md": "".join(f"{line['id']} {line['text']}{line['ending']}" for line in lines),
        "insight.md": _serialize(cards, accepted=True),
        "insight_reviewed.md": _serialize(cards),
        "insight_declined.md": _serialize([card for card in cards if card["decision"] == "rejected"]),
    }
    for name, expected in markdown.items():
        if raw(name) != expected.encode("utf-8"):
            _fail(filename(name), "content does not match the exact current protocol-9 serializer")
    provenance = _object(approval.get("provenance"), f"{approval_path}.provenance")
    for key in ("hashVerified", "runComplete"):
        if type(provenance.get(key)) is not bool:
            _fail(f"{approval_path}.provenance.{key}", "expected a boolean")
    input_hash = provenance.get("inputSha256")
    if input_hash is not None:
        if not isinstance(input_hash, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", input_hash):
            _fail(f"{approval_path}.provenance.inputSha256", "expected a SHA256 hex digest")
        input_hash = input_hash.lower()
    # hashVerified authenticates the original-input identity independently of
    # pipeline completion. In particular an insight-stage export can have
    # runComplete=false and still share its verified input with redaction-stage
    # exports whose sourcePath and summary text differ.
    trusted_hash = input_hash if provenance["hashVerified"] else None
    source = {
        "trajectoryKey": f"sha256:{trusted_hash}" if trusted_hash else f"source:{snapshot['sourcePath']}",
        "reviewId": snapshot["reviewId"], "projectName": snapshot["projectName"],
        "sourcePath": snapshot["sourcePath"], "protocolVersion": 9,
        "summaryLines": lines, "cards": cards, "directory": directory, "aliases": [],
        "sourceStage": snapshot["sourceStage"], "privacyStatus": snapshot["privacyStatus"],
        "revisionCount": snapshot["revisionCount"], "reviewedAt": approval["reviewedAt"],
        "inputSha256": trusted_hash,
        "summarySha256": _sha(markdown["summary.md"].encode("utf-8")),
    }
    # Provenance artifactHashes describe pre-review artifacts, never current files.
    source["_contentHash"] = _sha(_canonical({"summaryLines": lines, "cards": cards,
                                              "trajectorySummary": trajectory, "summaryGroups": groups}))
    return source


def normalize_export(root: Path) -> dict:
    """Validate and deterministically deduplicate an extracted export directory.

    ``files`` hashes every actual file relative to ``root``. Identical final
    content is one trajectory even when copied under another review ID; a shared
    verified input hash, source path, review ID, or exact summary with differing
    current content is a conflict and must be resolved outside this importer.
    Input hash verification establishes identity regardless of runComplete;
    that flag describes pipeline completion, not whether an input is distinct.
    """
    root = Path(root)
    if not root.is_dir():
        _fail(str(root), "expected an extracted export directory")
    data: dict[str, bytes] = {}
    try:
        for path in sorted(root.rglob("*")):
            if path.is_symlink():
                _fail(path.relative_to(root).as_posix(), "symlinks are not supported in exports")
            if path.is_file():
                data[path.relative_to(root).as_posix()] = path.read_bytes()
    except OSError as exc:
        _fail(str(root), f"cannot read export: {exc}")
    entries: list[tuple[str, dict | None]] = []
    if "manifest.json" in data:
        manifest = _json(data["manifest.json"], "manifest.json")
        _equal(manifest.get("format"), "oxygen-human-review-collection/v1", "manifest.json.format")
        reviews = _array(manifest.get("reviews"), "manifest.json.reviews")
        _equal(manifest.get("reviewCount"), len(reviews), "manifest.json.reviewCount")
        _string(manifest.get("exportedAt"), "manifest.json.exportedAt")
        seen_directories = set()
        for index, entry in enumerate(reviews):
            where = f"manifest.json.reviews[{index}]"
            entry = _object(entry, where)
            directory = _string(entry.get("directory"), f"{where}.directory")
            path = PurePosixPath(directory)
            if (path.is_absolute() or ".." in path.parts or "\\" in directory
                    or path.as_posix() != directory or directory == "."):
                _fail(f"{where}.directory", "expected a normalized relative directory inside the export")
            if directory in seen_directories:
                _fail(f"{where}.directory", "duplicate collection directory")
            seen_directories.add(directory)
            filenames = _array(entry.get("files"), f"{where}.files")
            for i, name in enumerate(filenames):
                _string(name, f"{where}.files[{i}]")
            if len(filenames) != len(EXPORT_FILES) or set(filenames) != set(EXPORT_FILES):
                _fail(f"{where}.files", "expected the seven current review export filenames")
            entries.append((directory, entry))
        listed = {f"{directory}/review.json" for directory, _ in entries}
        unlisted = sorted(path for path in data if PurePosixPath(path).name == "review.json" and path not in listed)
        if unlisted:
            _fail("manifest.json.reviews", f"unlisted review exports: {', '.join(unlisted)}")
    elif "review.json" in data:
        entries.append((".", None))
        nested = [name for name in data if name != "review.json" and PurePosixPath(name).name == "review.json"]
        if nested:
            _fail(str(root), "multiple exports require a collection manifest.json")
    else:
        _fail(str(root), "expected manifest.json or a single current review.json export")
    if not entries:
        _fail("manifest.json.reviews", "collection must contain at least one review")
    sources = [_read_source(directory, data, metadata) for directory, metadata in sorted(entries)]
    # Union all matching identities, including transitive copies. A filename or
    # shared projectName alone never establishes independent trajectory identity.
    parents = list(range(len(sources)))

    def find(index: int) -> int:
        while parents[index] != index:
            parents[index] = parents[parents[index]]
            index = parents[index]
        return index

    identities: dict[tuple[str, str], int] = {}
    for index, source in enumerate(sources):
        keys = [("sourcePath", source["sourcePath"]), ("summarySha256", source["summarySha256"]),
                ("reviewId", source["reviewId"])]
        if source["inputSha256"]:
            keys.append(("inputSha256", source["inputSha256"]))
        for key in keys:
            if key in identities:
                parents[find(index)] = find(identities[key])
            else:
                identities[key] = index
    groups: dict[int, list[dict]] = {}
    for index, source in enumerate(sources):
        groups.setdefault(find(index), []).append(source)
    unique = []
    duplicates = []
    for group in groups.values():
        group.sort(key=lambda item: (item["directory"], item["reviewId"]))
        first = group[0]
        for other in group[1:]:
            if first["_contentHash"] != other["_contentHash"]:
                _fail(other["directory"], "conflicting revisions/copies for one trajectory: "
                      f"{first['reviewId']} ({first['directory']}) and "
                      f"{other['reviewId']} ({other['directory']}); resolve explicitly")
        # Prefer a trustworthy original-input identity across all copies.
        keys = sorted(item["trajectoryKey"] for item in group if item["inputSha256"])
        if keys:
            first["trajectoryKey"] = keys[0]
        first["aliases"] = [{key: item[key] for key in ("reviewId", "sourcePath", "directory", "trajectoryKey")}
                            for item in group[1:]]
        unique.append(first)
    unique.sort(key=lambda source: (source["directory"], source["reviewId"]))
    for index, source in enumerate(unique):
        source["id"] = f"S{index + 1:03d}"
        del source["_contentHash"]
        for alias in source["aliases"]:
            duplicates.append({"sourceId": source["id"], "canonicalDirectory": source["directory"], **alias})
    return {
        "format": "oxygen-cross-session-inputs/v1", "sources": unique,
        "counts": {"trajectories": len(unique),
                   "accepted": sum(card["decision"] == "accepted" for source in unique for card in source["cards"]),
                   "declined": sum(card["decision"] == "rejected" for source in unique for card in source["cards"])},
        "duplicates": duplicates, "files": {name: _sha(raw) for name, raw in sorted(data.items())},
    }
