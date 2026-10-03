"""Validate protocol-v8 skill candidate fields and evidence addresses."""

import re

TYPES = ("user-agent", "agent")
FIELDS = ("Title", "Type", "Description", "Example", "Evidence")
BLOCK_FIELDS = {"Description", "Example"}


def markdown_lines(text):
    """Yield lines and whether they can contain card/field delimiters."""
    fence = None
    for line in text.split("\n"):
        if fence:
            yield line, False
            if re.fullmatch(r" {0,3}" + re.escape(fence[0]) + "{" + str(fence[1]) + r",}[ \t]*", line):
                fence = None
            continue
        opening = re.match(r"^ {0,3}(`{3,}|~{3,})(.*)$", line)
        if opening and not (opening[1][0] == "`" and "`" in opening[2]):
            fence = (opening[1][0], len(opening[1]))
            yield line, False
        else:
            yield line, True
    if fence:
        raise ValueError("unclosed_markdown_fence")


def parse_cards(data, evidence_lines):
    """Check structure and citation targets, not generalization or factual truth."""
    text = data.decode("utf-8").replace("\r\n", "\n")
    blocks = []
    for line, structural in markdown_lines(text):
        heading = re.fullmatch(r"# (I\d{3,})[ \t]*", line) if structural else None
        if heading:
            blocks.append((heading[1], []))
        elif blocks:
            blocks[-1][1].append((line, structural))
        elif line.strip():
            raise ValueError("invalid_insight_format")
    cards = []
    for number, (identifier, body) in enumerate(blocks, 1):
        if identifier != f"I{number:03d}":
            raise ValueError("invalid_insight_ids")
        values, current = {}, None
        for line, structural in body:
            header = re.match(r"^([A-Za-z]+|Applies when):[ \t]*(.*)$", line) if structural else None
            if header:
                field, value = header.groups()
                if len(values) >= len(FIELDS) or field != FIELDS[len(values)]:
                    raise ValueError("invalid_card_fields")
                values[field] = [value]
                current = field
            elif line.strip():
                if current not in BLOCK_FIELDS:
                    raise ValueError("unexpected_card_content")
                values[current].append(line)
            elif current in BLOCK_FIELDS:
                values[current].append(line)
        if tuple(values) != FIELDS:
            raise ValueError("missing_card_fields")
        card = {"id": identifier, **{key: "\n".join(value).strip() for key, value in values.items()}}
        if any(not card[key] for key in FIELDS):
            raise ValueError("invalid_card_fields")
        if card["Type"] not in TYPES:
            raise ValueError("invalid_insight_type")
        refs = [ref.strip() for ref in card["Evidence"].split(",")]
        if not refs or len(set(refs)) != len(refs) or not set(refs) <= set(evidence_lines):
            raise ValueError("invalid_evidence_references")
        card["evidence_ids"] = refs
        cards.append(card)
    return cards
