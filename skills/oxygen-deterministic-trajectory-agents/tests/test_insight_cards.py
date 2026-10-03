import unittest

from test_trajectory_agents import INSIGHTS, PARAGRAPH_INSIGHTS, RUN, SUMMARY, EXAMPLE


class InsightCardTests(unittest.TestCase):
    def test_paragraph_example_preserves_markdown_and_blank_lines(self):
        for newline in ("\n", "\r\n"):
            with self.subTest(newline=newline):
                cards = RUN.parse_insights(PARAGRAPH_INSIGHTS.replace("\n", newline).encode(), SUMMARY.encode())
                self.assertEqual(cards[0]["Example"], EXAMPLE)
                self.assertEqual(cards[0]["evidence_ids"], ["L009", "L013"])

    def test_block_rejects_empty_missing_duplicate_and_extra_fields(self):
        for data in (
            PARAGRAPH_INSIGHTS.replace(EXAMPLE, ""),
            PARAGRAPH_INSIGHTS.replace("Evidence: L009, L013", ""),
            PARAGRAPH_INSIGHTS.replace("Description: When", "Context: When"),
            PARAGRAPH_INSIGHTS.replace(EXAMPLE, EXAMPLE + "\nTitle: Duplicate"),
            PARAGRAPH_INSIGHTS.replace(EXAMPLE, EXAMPLE + "\nExample: Duplicate"),
            PARAGRAPH_INSIGHTS.replace(EXAMPLE, EXAMPLE + "\nContext: Extra field"),
            PARAGRAPH_INSIGHTS + "Unexpected trailing content.\n",
            PARAGRAPH_INSIGHTS.replace("L009, L013", "L999"),
            PARAGRAPH_INSIGHTS.replace("L009, L013", "L009, L009"),
        ):
            with self.subTest(data=data), self.assertRaises(RUN.RunError):
                RUN.parse_insights(data.encode(), SUMMARY.encode())

    def test_mixed_legacy_and_paragraph_cards_keep_their_boundaries(self):
        cards = RUN.parse_insights((INSIGHTS + "\n" + PARAGRAPH_INSIGHTS.replace("I001", "I002")).encode(), SUMMARY.encode())
        self.assertEqual(len(cards), 2)
        self.assertNotIn("\n", cards[0]["Example"])
        self.assertEqual(cards[1]["Example"], EXAMPLE)

    def test_each_type_is_retained_as_a_card_label(self):
        for kind in RUN.CARDS.TYPES:
            with self.subTest(kind=kind):
                data = INSIGHTS.replace("agent", kind).encode()
                cards = RUN.parse_insights(data, SUMMARY.encode())
                self.assertEqual(cards[0]["Type"], kind)
                self.assertEqual(cards[0]["evidence_ids"], ["L009", "L013"])

    def test_invalid_or_missing_fields_are_rejected(self):
        for data in (
            INSIGHTS.replace("agent", "Preference"),
            INSIGHTS.replace("Title: Verify reported results\n", ""),
            INSIGHTS.replace("Title: Verify reported results", "Title: "),
            INSIGHTS.replace("Description:", "Why:"),
            INSIGHTS + "Example: Added duplicate field.\n",
            INSIGHTS.replace("Description:", "An unstructured continuation.\nDescription:"),
        ):
            with self.subTest(data=data), self.assertRaises(RUN.RunError):
                RUN.parse_insights(data.encode(), SUMMARY.encode())

    def test_evidence_requires_valid_unique_content_ids(self):
        for data in (
            INSIGHTS.replace("L009, L013", "L999"),
            INSIGHTS.replace("L009, L013", "L007"),
            INSIGHTS.replace("L009, L013", "L008"),
            INSIGHTS.replace("L009, L013", "L009-L013"),
            INSIGHTS.replace("L009, L013", "L009, L009"),
            INSIGHTS.replace("L009, L013", "L009 | User requested a check."),
        ):
            with self.subTest(data=data), self.assertRaises(RUN.RunError):
                RUN.parse_insights(data.encode(), SUMMARY.encode())

    def test_crlf_and_unicode_summary_lines_preserve_text(self):
        summary = SUMMARY.replace("User requested a check.", "User requested café metrics.")
        insight = INSIGHTS.replace("Verify reported results", "Vérifier les résultats")
        cards = RUN.parse_insights(insight.replace("\n", "\r\n").encode(), summary.replace("\n", "\r\n").encode())
        self.assertEqual(cards[0]["Title"], "Vérifier les résultats")
        self.assertEqual(cards[0]["evidence_ids"], ["L009", "L013"])

    def test_legacy_types_and_seven_field_cards_are_rejected(self):
        for data in (
            INSIGHTS.replace("agent", "Reusable task or technical lesson"),
            INSIGHTS.replace("agent", "Explicit user preference or constraint"),
            INSIGHTS.replace("agent", "Inferred user preference"),
            INSIGHTS.replace("Description:", "Applies when: A reported result.\nDescription:").replace(
                "Evidence:", "Why: Verification remains pending.\nEvidence:"),
        ):
            with self.subTest(data=data), self.assertRaises(RUN.RunError):
                RUN.parse_insights(data.encode(), SUMMARY.encode())

    def test_description_and_example_blocks_preserve_paragraphs(self):
        data = PARAGRAPH_INSIGHTS.replace(
            "Description: When relying on an agent-reported result whose independent verification remains pending.",
            "Description:\n\nAudit reported results.\n\nUse when independent verification is pending.",
        )
        cards = RUN.parse_insights(data.encode(), SUMMARY.encode())
        self.assertEqual(cards[0]["Description"], "Audit reported results.\n\nUse when independent verification is pending.")
        self.assertEqual(cards[0]["Example"], EXAMPLE)

    def test_v9_rejects_v7_schema_and_origin_types(self):
        for data in (
            INSIGHTS.replace("Description:", "Scope:").replace("Example:", "Takeaway:"),
            *(INSIGHTS.replace("Type: agent", "Type: " + kind) for kind in ("user explicit", "user implicit", "agent encountered")),
            INSIGHTS.replace("Description: When", "Description: \nExample: When"),
        ):
            with self.subTest(data=data), self.assertRaises(RUN.RunError):
                RUN.parse_insights(data.encode(), SUMMARY.encode())

    def test_rich_walkthrough_preserves_fenced_delimiters_and_next_card(self):
        example = """### Recorded walkthrough

1. Validate each result.
   - Preserve completed items.

> Completion was reported, not independently verified.

| Case | Decision |
|---|---|
| Missing item | Retry |

````markdown
# I999
Title: Literal example
Example: Literal field
Evidence: L999
```
````

### Adapting the approach

This could support document imports.
""".strip()
        for fence in ("backticks", "tildes"):
            body = example if fence == "backticks" else example.replace("````", "~~~~")
            data = PARAGRAPH_INSIGHTS.replace(EXAMPLE, body)
            data += "\n" + INSIGHTS.replace("I001", "I002")
            cards = RUN.parse_insights(data.encode(), SUMMARY.encode())
            self.assertEqual(len(cards), 2)
            self.assertEqual(cards[0]["Example"], body)
            self.assertEqual(cards[0]["evidence_ids"], ["L009", "L013"])

    def test_fences_in_description_are_literal_and_require_valid_closures(self):
        code = "```text\nDescription: literal\n# I555\n```"
        data = PARAGRAPH_INSIGHTS.replace("Description: When", "Description: " + code + "\n\nWhen")
        # Fences start on their own physical line, not inline after a field.
        data = data.replace("Description: ```", "Description:\n```")
        cards = RUN.parse_insights(data.encode(), SUMMARY.encode())
        self.assertIn(code, cards[0]["Description"])
        for example in ("```text\nunfinished", "~~~~\n```\n~~~", "````\n```"):
            with self.subTest(example=example), self.assertRaises(RUN.RunError):
                RUN.parse_insights(PARAGRAPH_INSIGHTS.replace(EXAMPLE, example).encode(), SUMMARY.encode())

    def test_colon_in_a_prose_sentence_is_not_an_extra_field(self):
        example = EXAMPLE + "\n\nTest the boundaries with realistic examples: include partial failures."
        cards = RUN.parse_insights(PARAGRAPH_INSIGHTS.replace(EXAMPLE, example).encode(), SUMMARY.encode())
        self.assertEqual(cards[0]["Example"], example)

    def test_workflow_preserves_rich_markdown_and_literal_delimiters(self):
        workflow = """### Method

1. Identify an independent check.
2. Preserve uncertainty.

| Claim | Check |
|---|---|
| Success | Independent evidence |

> An observed result is different from a report.

```markdown
# I123
Workflow: literal
Example: literal
Evidence: L999
```"""
        old = "Check independent evidence before relying on a reported result."
        data = INSIGHTS.replace("Workflow: " + old, "Workflow:\n\n" + workflow)
        cards = RUN.parse_insights(data.encode(), SUMMARY.encode())
        self.assertEqual(cards[0]["Workflow"], workflow)
        for bad in (
            INSIGHTS.replace("Workflow: " + old + "\n", ""),
            INSIGHTS.replace(old, ""),
            INSIGHTS.replace("Example:", "Workflow: duplicate\nExample:"),
            INSIGHTS.replace("Workflow:", "Example:"),
            INSIGHTS.replace("Workflow: " + old, "Workflow:\n```\nUnclosed"),
        ):
            with self.subTest(bad=bad), self.assertRaises(RUN.RunError):
                RUN.parse_insights(bad.encode(), SUMMARY.encode())

    def test_empty_insights_are_valid(self):
        self.assertEqual(RUN.parse_insights(b"", b""), [])


if __name__ == "__main__":
    unittest.main()
