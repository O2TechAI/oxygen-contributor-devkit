"""Parse five-field insight cards and validate their evidence addresses."""

import re


TYPES = (
    "user explicit",
    "user implicit",
    "agent encountered",
)
FIELDS = ("Title", "Type", "Scope", "Takeaway", "Evidence")


def parse_cards(data, evidence_lines):
    """Validate card fields and citation targets, without claiming semantic support."""
    text = data.decode("utf-8").replace("\r\n", "\n")
    chunks = re.split(r"(?m)^# (I\d{3,})[ \t]*$", text)
    if chunks[0].strip() or len(chunks) % 2 != 1:
        raise ValueError("invalid_insight_format")
    cards = []
    for number in range(1, (len(chunks) + 1) // 2):
        identifier, body = chunks[2 * number - 1:2 * number + 1]
        if identifier != f"I{number:03d}":
            raise ValueError("invalid_insight_ids")
        lines = body.split("\n")
        content = [index for index, line in enumerate(lines) if line.strip()]
        if len(content) < len(FIELDS):
            raise ValueError("missing_card_fields")
        card = {"id": identifier}
        # Only Takeaway may span lines. Keep its internal paragraph boundaries;
        # the other fields retain their original single-line contract.
        for field, index in zip((*FIELDS[:3], "Evidence"), (*content[:3], content[-1])):
            line = lines[index]
            prefix = field + ": "
            if not line.startswith(prefix) or not line[len(prefix):].strip():
                raise ValueError("invalid_card_fields")
            card[field] = line[len(prefix):].strip()
        takeaway = lines[content[3]]
        if takeaway.rstrip() == "Takeaway:":
            paragraphs = lines[content[3] + 1:content[-1]]
            # Field-like lines here indicate an extra/duplicate card field, not
            # a paragraph (new paragraphs begin with a bold descriptive lead-in).
            if any(re.match(r"^[A-Za-z][A-Za-z ]*:", line) for line in paragraphs):
                raise ValueError("unexpected_card_fields")
            card["Takeaway"] = "\n".join(paragraphs).strip()
        elif takeaway.startswith("Takeaway: "):
            if len(content) != len(FIELDS):
                raise ValueError("unexpected_card_fields")
            card["Takeaway"] = takeaway[len("Takeaway: "):].strip()
        else:
            raise ValueError("invalid_card_fields")
        if not card["Takeaway"]:
            raise ValueError("invalid_card_fields")
        if card["Type"] not in TYPES:
            raise ValueError("invalid_insight_type")
        refs = [ref.strip() for ref in card["Evidence"].split(",")]
        if not refs or len(set(refs)) != len(refs) or not set(refs) <= set(evidence_lines):
            raise ValueError("invalid_evidence_references")
        card["evidence_ids"] = refs
        cards.append(card)
    return cards
