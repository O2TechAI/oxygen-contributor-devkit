"""Parse cross-session draft cards and validate their recorded provenance.

The checks here establish syntax, resolvable citations, and distinct trajectory
identities. Whether those trajectories record independent applications of a
shared, non-obvious method remains a semantic worker/reviewer judgment.
"""

import re


TYPES = ("user-agent", "agent")
FIELDS = ("Title", "Type", "Description", "Workflow", "Example", "Evidence")
BLOCK_FIELDS = {"Description", "Workflow", "Example"}
LEGACY_FIELDS = {"Scope", "Takeaway", "Applies when", "Why"}
SOURCE_ID = re.compile(r"S\d{3,}\Z")
LINE_ID = re.compile(r"L\d{3,}\Z")
CITATION = re.compile(r"(S\d{3,}):(L\d{3,})\Z")
CARD_HEADING = re.compile(r"# (C\d{3,})[ \t]*\Z")
FIELD = re.compile(r"^([A-Za-z]+|Applies when):[ \t]*(.*)$")


def _nonempty(value):
    return isinstance(value, str) and bool(value.strip())


def _exact_keys(value, keys, reason):
    if not isinstance(value, dict) or set(value) != set(keys):
        raise ValueError(reason)


def _opening_fence(line):
    match = re.match(r"^ {0,3}(`{3,}|~{3,})(.*)$", line)
    if match and not (match[1][0] == "`" and "`" in match[2]):
        return match[1][0], len(match[1])
    return None


def _closing_fence(line, fence):
    return re.fullmatch(
        r" {0,3}" + re.escape(fence[0]) + "{" + str(fence[1]) + r",}[ \t]*", line
    ) is not None


def _block_text(lines):
    # Keep indentation, hard-break spaces, and interior blank lines verbatim.
    start, end = 0, len(lines)
    while start < end and not lines[start].strip():
        start += 1
    while end > start and not lines[end - 1].strip():
        end -= 1
    return "\n".join(lines[start:end])


def _evidence_refs(value):
    refs = [ref.strip() for ref in value.split(",")]
    if any(CITATION.fullmatch(ref) is None for ref in refs) or len(set(refs)) != len(refs):
        raise ValueError("invalid_evidence_references")
    return refs


def _parse_markdown(text):
    blocks, current, fence = [], None, None
    for line in text.replace("\r\n", "\n").split("\n"):
        if "\r" in line or "\x00" in line:
            raise ValueError("invalid_card_format")
        if fence:
            blocks[-1][1][current].append(line)
            if _closing_fence(line, fence):
                fence = None
            continue
        heading = CARD_HEADING.fullmatch(line)
        if heading:
            blocks.append((heading[1], {}))
            current = None
            continue
        # A malformed candidate delimiter must not become ordinary block prose.
        if re.match(r"^ {0,3}#+\s+C\d", line):
            raise ValueError("invalid_card_ids")
        if not blocks:
            if line.strip():
                raise ValueError("invalid_card_format")
            continue
        values = blocks[-1][1]
        header = FIELD.match(line)
        if header and header[1] in set(FIELDS) | LEGACY_FIELDS:
            field, value = header.groups()
            if len(values) >= len(FIELDS) or field != FIELDS[len(values)]:
                raise ValueError("invalid_card_fields")
            values[field] = [value]
            current = field
            if current in BLOCK_FIELDS:
                fence = _opening_fence(value)
        elif current in BLOCK_FIELDS:
            values[current].append(line)
            fence = _opening_fence(line)
        elif line.strip():
            raise ValueError("unexpected_card_content")
    if fence:
        raise ValueError("unclosed_markdown_fence")
    cards = []
    for number, (identifier, values) in enumerate(blocks, 1):
        if identifier != f"C{number:03d}":
            raise ValueError("invalid_card_ids")
        if tuple(values) != FIELDS:
            raise ValueError("missing_card_fields")
        card = {"id": identifier}
        for field, lines in values.items():
            value = _block_text(lines) if field in BLOCK_FIELDS else lines[0].strip()
            if not value:
                raise ValueError("empty_card_field")
            card[field.lower()] = value
        if card["type"] not in TYPES:
            raise ValueError("invalid_card_type")
        card["evidence"] = _evidence_refs(card["evidence"])
        cards.append(card)
    return cards


def _source_index(sources):
    if not isinstance(sources, list):
        raise ValueError("invalid_sources")
    index = {}
    for source in sources:
        if not isinstance(source, dict):
            raise ValueError("invalid_source")
        identifier = source.get("id")
        if not isinstance(identifier, str) or SOURCE_ID.fullmatch(identifier) is None:
            raise ValueError("invalid_source_id")
        if identifier in index:
            raise ValueError("duplicate_source_id")
        if not _nonempty(source.get("trajectoryKey")):
            raise ValueError("missing_trajectory_identity")
        lines = source.get("summaryLines")
        if not isinstance(lines, list):
            raise ValueError("invalid_summary_lines")
        line_index = {}
        for line in lines:
            if not isinstance(line, dict):
                raise ValueError("invalid_summary_line")
            line_id = line.get("id")
            if not isinstance(line_id, str) or LINE_ID.fullmatch(line_id) is None:
                raise ValueError("invalid_summary_line_id")
            if line_id in line_index:
                raise ValueError("duplicate_summary_line_id")
            if not isinstance(line.get("text"), str) or line.get("kind") not in {
                "content", "heading", "layout"
            }:
                raise ValueError("invalid_summary_line")
            line_index[line_id] = line
        index[identifier] = (source, line_index)
    return index


def parse_cards(data, sources):
    """Return normalized cards; evidence contains qualified content-line IDs.

    At least two distinct ``trajectoryKey`` values must support every card.
    Different reviewed versions of the same trajectory count only once.
    """
    if not isinstance(data, bytes):
        raise ValueError("card_data_must_be_bytes")
    cards = _parse_markdown(data.decode("utf-8"))
    source_index = _source_index(sources)
    for card in cards:
        trajectories = set()
        for ref in card["evidence"]:
            source_id, line_id = ref.split(":")
            if source_id not in source_index:
                raise ValueError("unknown_evidence_source")
            source, lines = source_index[source_id]
            if line_id not in lines or lines[line_id]["kind"] != "content" or not lines[line_id]["text"].strip():
                raise ValueError("invalid_evidence_line")
            trajectories.add(source["trajectoryKey"])
        if len(trajectories) < 2:
            raise ValueError("insufficient_distinct_trajectories")
    return cards


def serialize_cards(cards):
    """Render normalized cards as six-field Markdown, preserving block content.

    Provenance enrichment is deliberately omitted from the Markdown artifact.
    Citation existence and trajectory identity need ``parse_cards`` with sources.
    """
    if not isinstance(cards, list):
        raise ValueError("invalid_cards")
    rendered, normalized = [], []
    for number, card in enumerate(cards, 1):
        if not isinstance(card, dict) or card.get("id") != f"C{number:03d}":
            raise ValueError("invalid_card_ids")
        block = ["# " + card["id"]]
        expected = {"id": card["id"]}
        for field in FIELDS:
            value = card.get(field.lower())
            if field == "Evidence":
                if not isinstance(value, list) or not all(isinstance(ref, str) for ref in value):
                    raise ValueError("invalid_evidence_references")
                expected["evidence"] = _evidence_refs(", ".join(value))
                value = ", ".join(expected["evidence"])
            else:
                if not _nonempty(value):
                    raise ValueError("empty_card_field")
                value = value.replace("\r\n", "\n")
                if field in BLOCK_FIELDS:
                    value = _block_text(value.split("\n"))
                else:
                    if "\n" in value or "\r" in value:
                        raise ValueError("multiline_single_line_field")
                    value = value.strip()
                expected[field.lower()] = value
            block.append(field + (":\n" if field in BLOCK_FIELDS else ": ") + value)
        rendered.append("\n".join(block))
        normalized.append(expected)
    markdown = "\n\n".join(rendered) + ("\n" if rendered else "")
    if _parse_markdown(markdown) != normalized:
        raise ValueError("card_content_changes_structure")
    return markdown


def _origin_cards(source):
    cards = source.get("cards", [])
    if not isinstance(cards, list):
        raise ValueError("invalid_source_cards")
    index = {}
    for card in cards:
        if not isinstance(card, dict) or not _nonempty(card.get("id")):
            raise ValueError("invalid_source_card")
        if card["id"] in index:
            raise ValueError("duplicate_source_card_id")
        if card.get("decision") not in {"accepted", "rejected"}:
            raise ValueError("invalid_source_card_decision")
        index[card["id"]] = card
    return index


def validate_provenance(cards, metadata, sources):
    """Validate worker rationale/mappings and enrich them from trusted inputs.

    ``cardIds`` may be empty for summary-only support. A declined origin means
    an explicitly selected source card whose recorded decision is ``rejected``;
    relevance is never inferred from text or overlapping summary citations.
    """
    cards = parse_cards(serialize_cards(cards).encode("utf-8"), sources)
    source_index = _source_index(sources)
    _exact_keys(metadata, {"candidates"}, "invalid_provenance_metadata")
    candidates = metadata["candidates"]
    if not isinstance(candidates, list):
        raise ValueError("invalid_provenance_candidates")
    by_id = {}
    for candidate in candidates:
        _exact_keys(candidate, {"id", "rationale", "sources"}, "invalid_candidate_metadata")
        if not _nonempty(candidate["id"]) or candidate["id"] in by_id:
            raise ValueError("invalid_provenance_candidate_id")
        if not _nonempty(candidate["rationale"]):
            raise ValueError("missing_candidate_rationale")
        if not isinstance(candidate["sources"], list):
            raise ValueError("invalid_candidate_sources")
        by_id[candidate["id"]] = candidate
    if set(by_id) != {card["id"] for card in cards}:
        raise ValueError("provenance_candidate_mismatch")

    enriched = []
    for card in cards:
        candidate = by_id[card["id"]]
        cited_sources = dict.fromkeys(ref.split(":")[0] for ref in card["evidence"])
        mappings = {}
        for mapping in candidate["sources"]:
            _exact_keys(mapping, {"sourceId", "cardIds", "application", "declinedReuse"}, "invalid_source_mapping")
            source_id = mapping["sourceId"]
            if not isinstance(source_id, str) or source_id not in cited_sources or source_id in mappings:
                raise ValueError("invalid_mapped_source")
            if not _nonempty(mapping["application"]):
                raise ValueError("missing_source_application")
            card_ids = mapping["cardIds"]
            if not isinstance(card_ids, list) or not all(_nonempty(identifier) for identifier in card_ids):
                raise ValueError("invalid_origin_card_ids")
            if len(set(card_ids)) != len(card_ids):
                raise ValueError("duplicate_origin_card_id")
            source = source_index[source_id][0]
            origins = _origin_cards(source)
            if not set(card_ids) <= origins.keys():
                raise ValueError("unknown_origin_card")
            declined = mapping["declinedReuse"]
            if not isinstance(declined, list):
                raise ValueError("invalid_declined_reuse")
            declined_by_id = {}
            for reuse in declined:
                _exact_keys(reuse, {"cardId", "difference"}, "invalid_declined_reuse")
                identifier = reuse["cardId"]
                if not _nonempty(identifier) or identifier in declined_by_id:
                    raise ValueError("invalid_declined_origin_id")
                if not _nonempty(reuse["difference"]):
                    raise ValueError("missing_declined_reuse_difference")
                declined_by_id[identifier] = reuse["difference"].strip()
            rejected = {identifier for identifier in card_ids if origins[identifier]["decision"] == "rejected"}
            if set(declined_by_id) != rejected:
                raise ValueError("declined_reuse_mismatch")
            selected = []
            for identifier in card_ids:
                origin = origins[identifier]
                selected.append({
                    **origin,
                    "currentId": origin.get("currentId", identifier),
                    "originalId": origin.get("originalId"),
                    "acceptedExportId": origin.get("acceptedExportId"),
                    "authorship": origin.get("authorship"),
                    "rejectionReason": origin.get("rejectionReason"),
                })
            mappings[source_id] = {
                "sourceId": source_id,
                "reviewId": source.get("reviewId"),
                "trajectoryKey": source["trajectoryKey"],
                "cardIds": list(card_ids),
                "application": mapping["application"].strip(),
                "declinedReuse": [
                    {"cardId": identifier, "difference": declined_by_id[identifier]}
                    for identifier in card_ids if identifier in declined_by_id
                ],
                "summaryCitations": [ref for ref in card["evidence"] if ref.split(":")[0] == source_id],
                "cards": selected,
            }
        if set(mappings) != set(cited_sources):
            raise ValueError("missing_cited_source_mapping")
        enriched.append({
            **card,
            "rationale": candidate["rationale"].strip(),
            "sources": [mappings[source_id] for source_id in cited_sources],
        })
    return enriched
