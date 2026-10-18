"""Shared, frozen Humanizer guidance and card-preservation checks (standard library)."""

from pathlib import Path
import re


def bundle(skill_root, wrapper_path):
    """Read the editable local skill and Oxygen wrapper before freezing a run."""
    root = Path(skill_root)
    files = {}
    names = {
        "humanize.md": Path(wrapper_path),
        "humanizer/SKILL.md": root / "SKILL.md",
        "humanizer/LICENSE": root / "LICENSE",
    }
    try:
        for name, path in names.items():
            if path.is_symlink() or not path.is_file():
                raise ValueError("not_regular")
            data = path.read_bytes()
            if not data.strip():
                raise ValueError("empty_reference")
            data.decode("utf-8")
            files[name] = data
    except (OSError, ValueError) as exc:
        raise ValueError("humanizer_reference_unavailable") from exc
    return files


def instructions(files):
    return (b"# Local Humanizer skill (subordinate to the Oxygen contract below)\n\n"
            + files["humanizer/SKILL.md"] + b"\n\n" + files["humanize.md"])


def protected_fields(cards):
    return [(card["id"], card.get("type", card.get("Type")),
             card.get("evidence", card.get("evidence_ids"))) for card in cards]


def validate_preservation(before, after, before_markdown, after_markdown):
    """Semantic fidelity is editorial; protect card identity and citation bytes here."""
    if protected_fields(before) != protected_fields(after):
        raise ValueError("humanizer_changed_protected_fields")
    # Parsers normalize whitespace. Require exact structural Evidence fields too,
    # while ignoring literal field-looking lines inside Markdown code fences.
    def evidence_fields(data):
        result, fence = [], None
        for line in data.decode("utf-8").splitlines():
            if fence:
                if re.fullmatch(r" {0,3}" + re.escape(fence[0]) + "{" + str(fence[1]) + r",}[ \t]*", line):
                    fence = None
                continue
            match = re.match(r"^ {0,3}(`{3,}|~{3,})(.*)$", line)
            if match and not (match[1][0] == "`" and "`" in match[2]):
                fence = (match[1][0], len(match[1]))
            elif line.startswith("Evidence:"):
                result.append(line)
        return result
    if evidence_fields(before_markdown) != evidence_fields(after_markdown):
        raise ValueError("humanizer_changed_evidence_field")
