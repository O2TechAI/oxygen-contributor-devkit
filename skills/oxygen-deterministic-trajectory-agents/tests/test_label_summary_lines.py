import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import stat
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/label_summary_lines.py"
SPEC = importlib.util.spec_from_file_location("label_summary", SCRIPT)
LABEL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LABEL)


class LabelSummaryTests(unittest.TestCase):
    def test_exact_line_labels_include_headings_and_blanks(self):
        self.assertEqual(
            LABEL.label_bytes(b"# Overview\n\nA decision.\n"),
            b"L001 # Overview\nL002 \nL003 A decision.\n",
        )

    def test_round_trip_rich_markdown_unicode_mixed_newlines_and_no_final_lf(self):
        original = "# Overview\r\n\r\n**中文:** preserve attribution.\n\n- First\n  - Nested\r\n| A | B |\n| --- | --- |\n\x60\x60\x60python\nprint('hello')\n\x60\x60\x60\nUnterminated\u2028still one physical line".encode()
        labeled = LABEL.label_bytes(original)
        recovered = b"".join(line.split(b" ", 1)[1] for line in LABEL.physical_lines(labeled))
        self.assertEqual(recovered, original)
        self.assertEqual(len(LABEL.physical_lines(labeled)), 12)

    def test_empty_and_trailing_lines_have_no_phantom_record(self):
        for source, expected in [
            (b"", b""), (b"\n", b"L001 \n"), (b"x", b"L001 x"),
            (b"x\n\n", b"L001 x\nL002 \n"), (b"x\r\n", b"L001 x\r\n"),
        ]:
            self.assertEqual(LABEL.label_bytes(source), expected)

    def test_more_than_999_lines(self):
        labeled = LABEL.label_bytes(b"x\n" * 1001)
        self.assertTrue(labeled.endswith(b"L1000 x\nL1001 x\n"))

    def test_code_comments_are_content_but_formatting_is_not(self):
        data = b"# Heading\n```python\n# this is a code comment\nprint(1)\n```\n---\n| --- | --- |\n"
        self.assertEqual(LABEL.evidence_lines(data), {
            "L003": "# this is a code comment", "L004": "print(1)",
        })

    def test_evidence_excludes_headings_and_blank_lines(self):
        self.assertEqual(LABEL.evidence_lines(b"# Heading\n\n- Fact.\n## Decision\nDone.\n"),
                         {"L003": "- Fact.", "L005": "Done."})

    def test_cli_preserves_source_reports_hashes_and_creates_private_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "source.md"
            output = Path(temporary) / "labeled.md"
            source.write_bytes(b"# Overview\n\nSYNTHETIC_PRIVATE_MARKER\n")
            original = source.read_bytes()
            stdout = io.StringIO()
            with contextlib.redirect_stdout(stdout):
                self.assertEqual(LABEL.main([str(source), str(output)]), 0)
            result = json.loads(stdout.getvalue())
            self.assertNotIn("SYNTHETIC_PRIVATE_MARKER", stdout.getvalue())
            self.assertEqual(result["physical_lines"], 3)
            self.assertEqual(result["source_sha256"], hashlib.sha256(original).hexdigest())
            self.assertEqual(result["labeled_sha256"], hashlib.sha256(output.read_bytes()).hexdigest())
            self.assertEqual(source.read_bytes(), original)
            self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)

    def test_existing_output_same_input_and_symlinks_are_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, output = Path(temporary) / "input.md", Path(temporary) / "output.md"
            source.write_bytes(b"Evidence\n")
            output.write_bytes(b"Keep existing output")
            with self.assertRaises(FileExistsError):
                LABEL.label_file(source, output)
            with self.assertRaises(ValueError):
                LABEL.label_file(source, source)
            self.assertEqual(output.read_bytes(), b"Keep existing output")
            link = Path(temporary) / "alias.md"
            link.symlink_to(source)
            with self.assertRaises(OSError):
                LABEL.label_file(link, Path(temporary) / "new.md")
            self.assertFalse((Path(temporary) / "new.md").exists())

    def test_invalid_utf8_reports_no_source_content_and_creates_nothing(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, output = Path(temporary) / "input.md", Path(temporary) / "output.md"
            source.write_bytes(b"PRIVATE_MARKER\xff")
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                self.assertEqual(LABEL.main([str(source), str(output)]), 1)
            self.assertNotIn("PRIVATE_MARKER", stderr.getvalue())
            self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
