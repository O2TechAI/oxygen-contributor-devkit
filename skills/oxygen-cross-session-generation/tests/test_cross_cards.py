import copy
import importlib.util
from pathlib import Path
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "cross_cards.py"
SPEC = importlib.util.spec_from_file_location("cross_cards_under_test", SCRIPT)
CARDS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CARDS)


MARKDOWN = """# C001

Title: Verify reports across sessions
Type: agent
Description: Use when a reported result needs an independent check.
Workflow: Compare the claim with independently recorded evidence.
Example: Both sessions reported success before verification finished.
Evidence: S001:L003, S002:L001
"""


def source_card(identifier, *, original_id=None, export_id=None, decision="accepted"):
    return {
        "id": identifier,
        "currentId": identifier,
        "originalId": original_id or identifier,
        "acceptedExportId": export_id,
        "authorship": "agent",
        "decision": decision,
        "title": "Check the reported outcome",
        "type": "agent",
        "description": "Use independent observations.",
        "workflow": "Locate the evidence and compare the claim.",
        "example": "The run was reported complete while verification was pending.",
        "evidence": ["L003"],
    }


def sources_fixture():
    rejected = source_card("I004", original_id="I023", decision="rejected")
    rejected["rejectionReason"] = "The proposed lesson repeats the session narrative."
    return [
        {
            "id": "S001",
            "reviewId": "review-first",
            "trajectoryKey": "trajectory-first",
            "summaryLines": [
                {"id": "L001", "kind": "heading", "text": "# Summary", "ending": "\n"},
                {"id": "L002", "kind": "layout", "text": "", "ending": "\n"},
                {"id": "L003", "kind": "content", "text": "A reported success needed verification.", "ending": "\n"},
                {"id": "L004", "kind": "content", "text": "The independent check was pending.", "ending": "\n"},
            ],
            "cards": [
                source_card("I003", original_id="I017", export_id="I001"),
                rejected,
            ],
        },
        {
            "id": "S002",
            "reviewId": "review-second",
            "trajectoryKey": "trajectory-second",
            "summaryLines": [
                {"id": "L001", "kind": "content", "text": "The user requested an independent check.", "ending": "\n"},
                {"id": "L002", "kind": "content", "text": "Verification remained unresolved.", "ending": ""},
            ],
            "cards": [source_card("I001", export_id="I001")],
        },
    ]


class CrossCardParsingTests(unittest.TestCase):
    def setUp(self):
        self.sources = sources_fixture()

    def parse(self, text=MARKDOWN):
        return CARDS.parse_cards(text.encode("utf-8"), self.sources)

    def test_both_types_use_lowercase_public_fields(self):
        for kind in ("agent", "user-agent"):
            with self.subTest(kind=kind):
                cards = self.parse(MARKDOWN.replace("Type: agent", "Type: " + kind))
                self.assertEqual(cards, [{
                    "id": "C001",
                    "title": "Verify reports across sessions",
                    "type": kind,
                    "description": "Use when a reported result needs an independent check.",
                    "workflow": "Compare the claim with independently recorded evidence.",
                    "example": "Both sessions reported success before verification finished.",
                    "evidence": ["S001:L003", "S002:L001"],
                }])

    def test_empty_input_has_no_candidates(self):
        for data in (b"", b" \n\t\r\n"):
            with self.subTest(data=data):
                self.assertEqual(CARDS.parse_cards(data, []), [])
        self.assertEqual(CARDS.serialize_cards([]).strip(), "")

    def test_crlf_unicode_and_multiple_cards_round_trip(self):
        text = MARKDOWN.replace("Verify reports", "Vérifier café reports")
        text += "\n" + MARKDOWN.replace("C001", "C002").replace("Type: agent", "Type: user-agent")
        cards = self.parse(text.replace("\n", "\r\n"))
        self.assertEqual([card["id"] for card in cards], ["C001", "C002"])
        self.assertEqual(cards[0]["title"], "Vérifier café reports across sessions")
        self.assertEqual(self.parse(CARDS.serialize_cards(cards)), cards)

    def test_all_block_fields_preserve_rich_markdown_and_literal_delimiters(self):
        rich = """### Recorded method

1. Find an independent check.
   - Preserve unresolved outcomes.

> The reported result requires verification.

| Claim | Check |
|---|---|
| Complete | Independent evidence |

Note: This label is ordinary paragraph text.

````markdown
# C999
Title: Literal title
Type: invalid-literal-type
Description: Literal description
Workflow: Literal workflow
Example: Literal example
Evidence: S999:L999
```
````

Test realistic boundaries: retain partially verified outcomes."""
        for field in ("Description", "Workflow", "Example"):
            for fence in ("backticks", "tildes"):
                with self.subTest(field=field, fence=fence):
                    body = rich if fence == "backticks" else rich.replace("````", "~~~~")
                    lines = MARKDOWN.splitlines()
                    lines = [field + ":\n\n" + body if line.startswith(field + ":") else line for line in lines]
                    text = "\n".join(lines) + "\n\n" + MARKDOWN.replace("C001", "C002")
                    cards = self.parse(text)
                    self.assertEqual(len(cards), 2)
                    self.assertEqual(cards[0][field.lower()], body)
                    self.assertEqual(cards[1]["id"], "C002")
                    self.assertEqual(self.parse(CARDS.serialize_cards(cards)), cards)

    def test_fence_can_begin_immediately_after_block_field_label(self):
        example = "```python\n# C999\nEvidence: S999:L999\n```"
        text = MARKDOWN.replace("Both sessions reported success before verification finished.", example)
        self.assertEqual(self.parse(text)[0]["example"], example)

    def test_invalid_schema_and_card_boundaries_are_rejected(self):
        cases = {
            "preamble": "Unstructured preamble.\n" + MARKDOWN,
            "wrong_prefix": MARKDOWN.replace("# C001", "# I001"),
            "short_id": MARKDOWN.replace("# C001", "# C01"),
            "nonsequential_id": MARKDOWN.replace("# C001", "# C002"),
            "duplicate_id": MARKDOWN + "\n" + MARKDOWN,
            "skipped_id": MARKDOWN + "\n" + MARKDOWN.replace("C001", "C003"),
            "missing_title": MARKDOWN.replace("Title: Verify reports across sessions\n", ""),
            "empty_title": MARKDOWN.replace("Verify reports across sessions", "   "),
            "missing_workflow": MARKDOWN.replace("Workflow: Compare the claim with independently recorded evidence.\n", ""),
            "empty_workflow": MARKDOWN.replace("Compare the claim with independently recorded evidence.", ""),
            "missing_example": MARKDOWN.replace("Example: Both sessions reported success before verification finished.\n", ""),
            "missing_evidence": MARKDOWN.replace("Evidence: S001:L003, S002:L001\n", ""),
            "wrong_field": MARKDOWN.replace("Description:", "Context:"),
            "duplicate_field": MARKDOWN.replace("Example:", "Workflow: Duplicate\nExample:"),
            "wrong_order": MARKDOWN.replace("Description:", "Example:").replace("Example: Both", "Description: Both"),
            "multiline_title": MARKDOWN.replace("Type: agent", "Continued title\nType: agent"),
            "multiline_type": MARKDOWN.replace("Description:", "Continued type\nDescription:"),
            "multiline_evidence": MARKDOWN + "S002:L002\n",
            "trailing_content": MARKDOWN + "Unstructured trailing prose.\n",
            "old_type": MARKDOWN.replace("Type: agent", "Type: user explicit"),
            "unknown_type": MARKDOWN.replace("Type: agent", "Type: preference"),
        }
        for legacy in ("Scope", "Takeaway", "Applies when", "Why"):
            cases["legacy_" + legacy] = MARKDOWN.replace("Example:", legacy + ": Legacy value\nExample:")
        for label, text in cases.items():
            with self.subTest(case=label), self.assertRaises(ValueError):
                self.parse(text)

    def test_evidence_requires_unique_qualified_content_lines(self):
        for evidence in (
            "", "L003, L001", "S001:L003", "S001:L003, S001:L004",
            "S001:L999, S002:L001", "S999:L003, S002:L001",
            "S001:L001, S002:L001", "S001:L002, S002:L001",
            "S001:L003, S002:L001, S001:L003", "S001:L003-S001:L004, S002:L001",
            "S001:L003 | A claim, S002:L001", "S001:L003; S002:L001",
            "S001:L003, S002:L001,",
        ):
            with self.subTest(evidence=evidence), self.assertRaises(ValueError):
                self.parse(MARKDOWN.replace("S001:L003, S002:L001", evidence))

    def test_two_review_versions_of_one_trajectory_are_not_independent(self):
        self.sources[1]["trajectoryKey"] = self.sources[0]["trajectoryKey"]
        with self.assertRaises(ValueError):
            self.parse()

    def test_additional_review_version_does_not_prevent_two_real_trajectories(self):
        version = copy.deepcopy(self.sources[0])
        version.update(id="S003", reviewId="review-first-new-version")
        self.sources.append(version)
        cards = self.parse(MARKDOWN.replace("S001:L003, S002:L001", "S001:L003, S003:L004, S002:L001"))
        self.assertEqual(cards[0]["evidence"], ["S001:L003", "S003:L004", "S002:L001"])

    def test_unclosed_or_mismatched_fences_are_rejected(self):
        for example in ("```text\nunfinished", "~~~~\n```\n~~~", "````\n```", "```\n~~~"):
            with self.subTest(example=example), self.assertRaises(ValueError):
                self.parse(MARKDOWN.replace("Both sessions reported success before verification finished.", "\n" + example))


if __name__ == "__main__":
    unittest.main()
