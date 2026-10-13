"""Self-contained importer tests; no real corpus or model calls are needed."""

from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "review_exports.py"
SPEC = importlib.util.spec_from_file_location("review_exports", SCRIPT)
review_exports = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(review_exports)


def make_review(*, review_id="review-a", source_path="run/session-a", episode="Episode A"):
    lines = [
        {"id": "L001", "sourceId": "L001", "text": "# Summary", "ending": "\n", "kind": "heading"},
        {"id": "L002", "sourceId": "L003", "text": episode, "ending": "\n", "kind": "content"},
    ]
    cards = []
    for index, status in enumerate(("accepted", "rejected", "accepted"), 1):
        cards.append({
            "id": f"I{index:03d}", "sourceId": f"I{index + 3:03d}",
            "title": f"Edited title {index}", "type": "agent",
            "description": f"Current description {index}.",
            "workflow": "1. Inspect the evidence.\n2. Record the result.",
            "example": "A concrete example.",
            "presentKeys": ["title", "type", "description", "workflow", "example", "evidence"],
            "evidence": ["L002"], "text": "", "status": status,
            "savedStatus": status, "defaultAccepted": False,
        })
    return {
        "format": "oxygen-review-snapshot/v1", "reviewId": review_id,
        "projectName": "same-project-name", "sourcePath": source_path,
        "protocolVersion": 9, "sourceStage": "redaction", "privacyStatus": "redacted",
        "status": "completed", "revisionCount": 2, "exportScope": "latest",
        "exportLabeling": {"accepted": 2, "declined": 1, "pending": 0, "needsReview": 0, "incompleteReviews": 0},
        "current": {"trajectorySummary": {"text": ""}, "summaryGroups": [],
                    "summaryLines": lines, "insights": cards},
    }


def approval_for(review, *, input_hash=None, verified=False):
    decisions = []
    count = 0
    for card in review["current"]["insights"]:
        accepted = card["status"] == "accepted"
        count += accepted
        decisions.append({
            "sourceId": None if card.get("authorship") == "reviewer" else card.get("sourceId", card["id"]),
            "authorship": card.get("authorship", "generated"), "reviewId": card["id"],
            "reviewedExportId": card["id"], "status": card["status"],
            "savedStatus": card["savedStatus"], "defaultAccepted": card["defaultAccepted"],
            "exportId": f"I{count:03d}" if accepted else None,
        })
    provenance = {"hashVerified": verified, "runComplete": verified,
                  "artifactHashes": {"summary_redacted.md": "f" * 64}}
    if input_hash is not None:
        provenance["inputSha256"] = input_hash
    return {
        "format": "oxygen-human-review/v1",
        **{key: review[key] for key in ("reviewId", "projectName", "protocolVersion", "sourceStage", "privacyStatus", "status")},
        "generatedAt": "2026-01-01T00:00:00Z", "reviewedAt": "2026-01-02T00:00:00Z",
        "provenance": provenance, "exportLabeling": copy.deepcopy(review["exportLabeling"]),
        "decisions": decisions,
    }


def render_cards(cards, *, renumber=False):
    # Independent fixture spelling of the TypeScript protocol-9 wire format.
    result = []
    for index, card in enumerate(cards, 1):
        identifier = f"I{index:03d}" if renumber else card["id"]
        result.append(
            f"# {identifier}\n\nTitle: {card['title']}\nType: {card['type']}\n"
            f"Description:\n\n{card['description']}\n\nWorkflow:\n\n{card['workflow']}\n\n"
            f"Example:\n\n{card['example']}\n\nEvidence: {', '.join(card['evidence'])}"
        )
    return "\n\n".join(result) + ("\n" if cards else "")


def write_export(directory, review=None, approval=None):
    review = make_review() if review is None else review
    approval = approval_for(review) if approval is None else approval
    directory.mkdir(parents=True, exist_ok=True)
    lines, cards = review["current"]["summaryLines"], review["current"]["insights"]
    files = {
        "summary.md": "".join(line["text"] + line.get("ending", "\n") for line in lines),
        "summary_labeled.md": "".join(line["id"] + " " + line["text"] + line.get("ending", "\n") for line in lines),
        "insight.md": render_cards([card for card in cards if card["status"] == "accepted"], renumber=True),
        "insight_reviewed.md": render_cards(cards),
        "insight_declined.md": render_cards([card for card in cards if card["status"] == "rejected"]),
        "review.json": json.dumps(review, indent=2) + "\n",
        "approval.json": json.dumps(approval, indent=2) + "\n",
    }
    for name, text in files.items():
        (directory / name).write_bytes(text.encode("utf-8"))
    return review, approval


def collection_entry(directory, review, approval):
    cards = review["current"]["insights"]
    return {
        **{key: review[key] for key in ("reviewId", "projectName", "sourcePath", "status", "privacyStatus", "revisionCount")},
        "updatedAt": approval["reviewedAt"], "acceptedInsightCount": sum(card["status"] == "accepted" for card in cards),
        "declinedInsightCount": sum(card["status"] == "rejected" for card in cards),
        "insightCount": len(cards), "defaultAcceptedInsightCount": 0, "labelingComplete": True,
        "directory": directory, "files": list(review_exports.EXPORT_FILES),
    }


def write_manifest(root, entries):
    manifest = {"format": "oxygen-human-review-collection/v1", "exportedAt": "2026-01-02T00:00:00Z",
                "reviewCount": len(entries), "reviews": entries}
    (root / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return manifest


class ReviewExportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def normalize(self):
        return review_exports.normalize_export(self.root)

    def change_json(self, filename, change):
        path = self.root / filename
        value = json.loads(path.read_text())
        change(value)
        path.write_text(json.dumps(value))

    def collection(self, specifications):
        entries = []
        for directory, review, approval in specifications:
            write_export(self.root / directory, review, approval)
            entries.append(collection_entry(directory, review, approval))
        write_manifest(self.root, entries)

    def test_current_edited_cards_preserve_all_identities_and_declines(self):
        write_export(self.root)
        result = self.normalize()
        self.assertEqual(result["format"], "oxygen-cross-session-inputs/v1")
        self.assertEqual(result["counts"], {"trajectories": 1, "accepted": 2, "declined": 1})
        source = result["sources"][0]
        self.assertEqual(source["id"], "S001")
        self.assertEqual(source["directory"], ".")
        self.assertEqual(source["trajectoryKey"], "source:run/session-a")
        last = source["cards"][2]
        self.assertEqual((last["id"], last["currentId"], last["originalId"], last["acceptedExportId"]),
                         ("I003", "I003", "I006", "I002"))
        self.assertEqual(last["title"], "Edited title 3")
        self.assertEqual(source["cards"][1]["decision"], "rejected")
        self.assertIsNone(source["cards"][1]["acceptedExportId"])
        self.assertIsNone(source["cards"][1]["rejectionReason"])
        self.assertEqual(self.normalize(), result)

    def test_hashes_actual_bytes_including_ancillary_files(self):
        write_export(self.root)
        (self.root / ".DS_Store").write_bytes(b"ancillary\x00bytes")
        result = self.normalize()
        self.assertEqual(len(result["files"]), 8)
        for name, digest in result["files"].items():
            self.assertEqual(digest, hashlib.sha256((self.root / name).read_bytes()).hexdigest())
        self.assertNotEqual(result["files"]["summary.md"], "f" * 64)

    def test_reviewer_added_card_may_lack_evidence(self):
        review = make_review()
        card = review["current"]["insights"][2]
        card.update(authorship="reviewer", evidence=[])
        del card["sourceId"]
        write_export(self.root, review)
        normalized = self.normalize()["sources"][0]["cards"][2]
        self.assertEqual(normalized["authorship"], "reviewer")
        self.assertIsNone(normalized["originalId"])
        self.assertEqual(normalized["evidence"], [])

    def test_rejection_reason_is_preserved_only_if_supplied(self):
        review = make_review()
        review["current"]["insights"][1]["rejectionReason"] = "Too specific to this episode."
        write_export(self.root, review)
        self.assertEqual(self.normalize()["sources"][0]["cards"][1]["rejectionReason"],
                         "Too specific to this episode.")

    def test_empty_accepted_or_declined_view(self):
        for status in ("accepted", "rejected"):
            with self.subTest(status=status):
                review = make_review()
                for card in review["current"]["insights"]:
                    card.update(status=status, savedStatus=status)
                review["exportLabeling"].update(accepted=3 if status == "accepted" else 0,
                                                declined=3 if status == "rejected" else 0)
                write_export(self.root, review)
                result = self.normalize()
                self.assertEqual(result["counts"]["accepted"], 3 if status == "accepted" else 0)
                empty = "insight_declined.md" if status == "accepted" else "insight.md"
                self.assertEqual((self.root / empty).read_bytes(), b"")

    def test_generated_cards_require_valid_unique_content_evidence(self):
        for evidence in ([], ["L001"], ["L999"], ["L002", "L002"], [{}]):
            with self.subTest(evidence=evidence):
                write_export(self.root)
                self.change_json("review.json", lambda value: value["current"]["insights"][0].update(evidence=evidence))
                with self.assertRaisesRegex(ValueError, r"insights\[0\].evidence"):
                    self.normalize()

    def test_summary_kind_cannot_turn_heading_into_evidence(self):
        write_export(self.root)
        self.change_json("review.json", lambda value: value["current"]["summaryLines"][0].update(kind="content"))
        with self.assertRaisesRegex(ValueError, r"summaryLines\[0\].kind"):
            self.normalize()

    def test_incomplete_labels_even_when_pending_was_exported_as_accepted(self):
        mutations = [
            lambda value: value.update(status="in_review"),
            lambda value: value["current"]["insights"][0].update(status="pending"),
            lambda value: value["current"]["insights"][0].update(savedStatus="pending", defaultAccepted=True),
            lambda value: value["current"]["insights"][0].update(status="needs_review"),
            lambda value: value["exportLabeling"].update(needsReview=1, incompleteReviews=1),
            lambda value: value["exportLabeling"].update(pending=1, incompleteReviews=1),
        ]
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                write_export(self.root)
                self.change_json("review.json", mutation)
                with self.assertRaises(ValueError):
                    self.normalize()

    def test_decision_identity_and_renumbering_must_match(self):
        for key, value in (("reviewId", "I999"), ("reviewedExportId", "I999"),
                           ("sourceId", "I999"), ("authorship", "reviewer"),
                           ("status", "rejected"), ("savedStatus", "pending"),
                           ("defaultAccepted", True), ("exportId", "I003")):
            with self.subTest(key=key):
                write_export(self.root)
                self.change_json("approval.json", lambda obj: obj["decisions"][2].update({key: value}))
                with self.assertRaisesRegex(ValueError, r"approval.json.decisions\[2\]"):
                    self.normalize()

    def test_missing_decisions_and_required_null_fields_are_rejected(self):
        write_export(self.root)
        self.change_json("approval.json", lambda obj: obj["decisions"].pop())
        with self.assertRaisesRegex(ValueError, "decisions.length"):
            self.normalize()
        write_export(self.root)
        self.change_json("approval.json", lambda obj: obj["decisions"][1].pop("exportId"))
        with self.assertRaisesRegex(ValueError, "missing required decision field"):
            self.normalize()

    def test_all_five_markdown_views_are_checked_byte_for_byte(self):
        for name in ("summary.md", "summary_labeled.md", "insight.md", "insight_reviewed.md", "insight_declined.md"):
            with self.subTest(name=name):
                write_export(self.root)
                path = self.root / name
                path.write_bytes(path.read_bytes() + b"\n")
                with self.assertRaisesRegex(ValueError, name):
                    self.normalize()

    def test_crlf_and_missing_last_newline_are_preserved(self):
        review = make_review()
        review["current"]["summaryLines"][0]["ending"] = "\r\n"
        review["current"]["summaryLines"][1]["ending"] = ""
        write_export(self.root, review)
        source = self.normalize()["sources"][0]
        self.assertEqual(source["summaryLines"][0]["ending"], "\r\n")
        self.assertEqual(source["summaryLines"][1]["ending"], "")

    def test_trusted_hash_identity_and_untrusted_source_fallback(self):
        for verified in (True, False):
            for complete in (True, False):
                with self.subTest(verified=verified, complete=complete):
                    review = make_review()
                    approval = approval_for(review, input_hash="a" * 64, verified=verified)
                    approval["provenance"]["runComplete"] = complete
                    write_export(self.root, review, approval)
                    source = self.normalize()["sources"][0]
                    self.assertEqual(source["trajectoryKey"], "sha256:" + "a" * 64 if verified else "source:run/session-a")

    def test_verified_identity_survives_insight_to_redaction_stage_transition(self):
        for first_complete, second_complete in ((False, True), (True, False), (False, False)):
            for identical_content in (True, False):
                with self.subTest(first_complete=first_complete, second_complete=second_complete,
                                  identical_content=identical_content):
                    first = make_review(source_path="run-20260101T000000Z-trajectory-001-insight")
                    first.update(sourceStage="insight", privacyStatus="unredacted")
                    second = make_review(review_id="review-b",
                                         source_path="run-20260101T000000Z-trajectory-001-redacted",
                                         episode="Episode A" if identical_content else "Redacted episode")
                    a = approval_for(first, input_hash="a" * 64, verified=True)
                    b = approval_for(second, input_hash="a" * 64, verified=True)
                    a["provenance"]["runComplete"] = first_complete
                    b["provenance"]["runComplete"] = second_complete
                    self.collection([("a", first, a), ("b", second, b)])
                    if identical_content:
                        result = self.normalize()
                        self.assertEqual(result["counts"]["trajectories"], 1)
                        self.assertEqual(result["sources"][0]["trajectoryKey"], "sha256:" + "a" * 64)
                        self.assertEqual(len(result["duplicates"]), 1)
                    else:
                        # Distinct summaries rule out the summary-copy guard as
                        # the reason these stage exports share one identity.
                        with self.assertRaisesRegex(ValueError, "conflicting revisions/copies"):
                            self.normalize()

    def test_same_project_name_does_not_collapse_independent_episodes(self):
        first = make_review()
        second = make_review(review_id="review-b", source_path="run/session-b", episode="Episode B")
        self.collection([("z", first, approval_for(first)), ("a", second, approval_for(second))])
        result = self.normalize()
        self.assertEqual(result["counts"], {"trajectories": 2, "accepted": 4, "declined": 2})
        self.assertEqual([source["directory"] for source in result["sources"]], ["a", "z"])

    def test_exact_copies_deduplicate_and_retain_identifying_aliases(self):
        first = make_review()
        second = make_review(review_id="copied-review", source_path="copied/source")
        self.collection([("a", first, approval_for(first)), ("b", second, approval_for(second))])
        result = self.normalize()
        self.assertEqual(result["counts"], {"trajectories": 1, "accepted": 2, "declined": 1})
        self.assertEqual(result["sources"][0]["aliases"][0]["reviewId"], "copied-review")
        self.assertEqual(result["duplicates"][0]["directory"], "b")
        self.assertEqual(result["duplicates"][0]["sourceId"], "S001")
        self.assertEqual(len(result["files"]), 15)

    def test_duplicate_input_hash_or_source_path_conflicting_revisions_fail(self):
        for identity in ("hash", "path", "summary", "reviewId"):
            with self.subTest(identity=identity):
                first = make_review()
                second = make_review(review_id="review-b", source_path="run/session-b", episode="Episode B")
                second["current"]["insights"][0]["title"] = "Conflicting revision"
                a, b = approval_for(first), approval_for(second)
                if identity == "hash":
                    a = approval_for(first, input_hash="a" * 64, verified=True)
                    b = approval_for(second, input_hash="a" * 64, verified=True)
                elif identity == "path":
                    second["sourcePath"] = first["sourcePath"]
                elif identity == "summary":
                    second["current"]["summaryLines"] = first["current"]["summaryLines"]
                else:
                    second["reviewId"] = first["reviewId"]
                    b = approval_for(second)
                self.collection([("a", first, a), ("b", second, b)])
                with self.assertRaisesRegex(ValueError, "conflicting revisions/copies"):
                    self.normalize()

    def test_metadata_counts_and_identities_are_validated(self):
        review = make_review()
        for key, value in (("reviewCount", True), ("acceptedInsightCount", 5),
                           ("declinedInsightCount", 0), ("insightCount", 4),
                           ("defaultAcceptedInsightCount", 1), ("labelingComplete", False),
                           ("sourcePath", "wrong"), ("reviewId", "wrong")):
            with self.subTest(key=key):
                self.collection([("a", review, approval_for(review))])
                def mutate(manifest):
                    (manifest if key == "reviewCount" else manifest["reviews"][0])[key] = value
                self.change_json("manifest.json", mutate)
                with self.assertRaisesRegex(ValueError, "manifest.json"):
                    self.normalize()

    def test_approval_counts_and_snapshot_counts_are_validated(self):
        for filename in ("review.json", "approval.json"):
            with self.subTest(filename=filename):
                write_export(self.root)
                self.change_json(filename, lambda value: value["exportLabeling"].update(accepted=999))
                with self.assertRaisesRegex(ValueError, "exportLabeling.accepted"):
                    self.normalize()

    def test_unlisted_reviews_and_directory_traversal_fail(self):
        review = make_review()
        self.collection([("a", review, approval_for(review))])
        write_export(self.root / "unlisted")
        with self.assertRaisesRegex(ValueError, "unlisted review exports"):
            self.normalize()
        self.change_json("manifest.json", lambda value: value["reviews"][0].update(directory="../escape"))
        with self.assertRaisesRegex(ValueError, "relative directory"):
            self.normalize()

    def test_symlinks_are_rejected(self):
        write_export(self.root)
        (self.root / "copy.md").symlink_to(self.root / "summary.md")
        with self.assertRaisesRegex(ValueError, "symlinks"):
            self.normalize()

    def test_unsupported_versions_formats_and_raw_bundles_fail(self):
        for key, value in (("protocolVersion", 8), ("protocolVersion", 10),
                           ("format", "historical/v0"), ("exportScope", "all")):
            with self.subTest(key=key, value=value):
                write_export(self.root)
                self.change_json("review.json", lambda obj: obj.update({key: value}))
                with self.assertRaisesRegex(ValueError, key):
                    self.normalize()
        with self.assertRaisesRegex(ValueError, "extracted export directory"):
            review_exports.normalize_export(self.root / "review.json")

    def test_malformed_structures_are_location_rich_value_errors(self):
        mutations = [
            ("current", lambda obj: obj.update(current=[])),
            ("summaryLines", lambda obj: obj["current"].update(summaryLines={})),
            ("summaryLines", lambda obj: obj["current"]["summaryLines"].__setitem__(0, [])),
            ("insights", lambda obj: obj["current"].update(insights={})),
            ("insights", lambda obj: obj["current"]["insights"].__setitem__(0, None)),
            ("authorship", lambda obj: obj["current"]["insights"][0].update(authorship=[])),
            ("status", lambda obj: obj["current"]["insights"][0].update(status={})),
            ("workflow", lambda obj: obj["current"]["insights"][0].update(workflow=[])),
            ("summaryGroups", lambda obj: obj["current"].update(summaryGroups=[None])),
        ]
        for location, mutation in mutations:
            with self.subTest(location=location):
                write_export(self.root)
                self.change_json("review.json", mutation)
                with self.assertRaisesRegex(ValueError, location):
                    self.normalize()
        for field, value in (("decisions", [None]), ("provenance", [])):
            write_export(self.root)
            self.change_json("approval.json", lambda obj: obj.update({field: value}))
            with self.assertRaisesRegex(ValueError, field):
                self.normalize()

    def test_bad_json_duplicate_keys_and_missing_files(self):
        for raw in (b"{", b"[]", b'{"format": 1, "format": 2}', b'{"x": NaN}', b"\xff"):
            with self.subTest(raw=raw):
                write_export(self.root)
                (self.root / "review.json").write_bytes(raw)
                with self.assertRaisesRegex(ValueError, "review.json"):
                    self.normalize()
        write_export(self.root)
        (self.root / "insight_declined.md").unlink()
        with self.assertRaisesRegex(ValueError, "required export file is missing"):
            self.normalize()


if __name__ == "__main__":
    unittest.main()
