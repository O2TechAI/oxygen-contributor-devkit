import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


READER = load("read_source_test", SCRIPTS / "read_source.py")
RUN = load("trajectory_agents_reader_test", SCRIPTS / "trajectory_agents.py")

SUMMARY = "# Overview\n\nThe user asked for a check.\n"


class PartTests(unittest.TestCase):
    def test_parts_cover_the_source_exactly_and_prefer_line_breaks(self):
        data = b"".join(f"line {n} ".encode() * (n % 7 + 1) + b"\n" for n in range(3000))
        bounds = READER.parts(data, limit=1000)
        self.assertEqual(b"".join(data[a:b] for a, b in bounds), data)
        self.assertTrue(all(b - a <= 1000 for a, b in bounds))
        self.assertTrue(all(data[b - 1:b] == b"\n" for a, b in bounds))
        self.assertEqual(bounds, READER.parts(data, limit=1000))

    def test_a_line_longer_than_a_part_is_split_on_code_point_boundaries(self):
        data = ("前" * 2000 + "\n" + "tail\n").encode()
        bounds = READER.parts(data, limit=1000)
        self.assertEqual(b"".join(data[a:b] for a, b in bounds), data)
        for a, b in bounds:
            data[a:b].decode("utf-8")
            self.assertLessEqual(b - a, 1000)


class ReaderRunTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.source = Path(temporary.name) / "trajectory.md"
        lines = [f"## user\n\nRequest {n}: " + "细节 detail " * (n % 40) + "\n" for n in range(900)]
        lines.insert(400, "## tool call\n\n" + "x" * 40_000 + "\n")
        self.source.write_text("".join(lines))
        RUN.prepare(self.source)
        _, self.run = RUN.paths(self.source)
        self.count = len(READER.parts((self.run / "source.md").read_bytes()))

    def cli(self, *arguments):
        reader = self.run / "protocol" / "read_source.py"
        return subprocess.run([sys.executable, str(reader), *map(str, arguments)],
                              capture_output=True)

    def read(self, stage, numbers):
        for number in numbers:
            result = self.cli("part", number, "--stage", stage)
            self.assertEqual(result.returncode, 0, result.stderr)

    def finish_summary(self, numbers):
        RUN.issue_call(self.source, "summary")
        RUN.record_worker(self.source, "summary", "worker")
        self.read("summary", numbers)
        (self.run / "summary" / "summary.md").write_text(SUMMARY)
        return RUN.accept(self.source, "summary", worker_id="worker", worker_status="complete")

    def test_cli_prints_whole_parts_and_plan_tracks_what_is_left(self):
        self.assertGreater(self.count, 3)
        plan = json.loads(self.cli("plan", "--stage", "summary").stdout)
        self.assertEqual((plan["parts"], plan["unread"], plan["next_unread_part"]), (self.count, self.count, 1))
        printed = b""
        for number in range(1, self.count + 1):
            out = self.cli("part", number, "--stage", "summary").stdout
            header, rest = out.split(b"\n", 1)
            self.assertTrue(header.startswith(f"[part {number}/{self.count} ".encode()))
            body, end = rest.rsplit(b"[end of part", 1)
            self.assertEqual(end, f" {number}/{self.count}]\n".encode())
            printed += body if (self.run / "source.md").read_bytes()[len(printed):].startswith(body) else body[:-1]
        self.assertEqual(printed, (self.run / "source.md").read_bytes())
        plan = json.loads(self.cli("plan", "--stage", "summary").stdout)
        self.assertEqual((plan["unread"], plan["next_unread_part"]), (0, None))
        receipts = self.run / "reading" / "summary.jsonl"
        if os.name != "nt":
            self.assertEqual(receipts.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.cli("part", self.count + 1, "--stage", "summary").returncode, 1)
        repository = subprocess.run([sys.executable, str(SCRIPTS / "read_source.py"), "plan", "--stage", "summary"],
                                    capture_output=True)
        self.assertEqual(repository.returncode, 2)
        self.assertIn(b"--run-dir is required", repository.stderr)
        elsewhere = subprocess.run([sys.executable, str(SCRIPTS / "read_source.py"), "plan", "--stage", "summary",
                                    "--run-dir", str(self.run)], capture_output=True)
        self.assertEqual(json.loads(elsewhere.stdout)["parts"], self.count)

    def test_a_stage_is_accepted_only_after_every_part_was_read_in_that_stage(self):
        with self.assertRaisesRegex(RUN.RunError, f"source_not_fully_read: {self.count - 1} of {self.count} parts"):
            self.finish_summary(range(1, self.count))
        self.read("insight", [self.count])  # another stage's receipts do not count
        with self.assertRaisesRegex(RUN.RunError, "source_not_fully_read"):
            RUN.accept(self.source, "summary", worker_id="worker", worker_status="complete")
        self.read("summary", [self.count])
        result = RUN.accept(self.source, "summary", worker_id="worker", worker_status="complete")
        self.assertEqual(result["source_parts_read"], self.count)

    def test_only_reading_stages_get_the_reader_command(self):
        for stage in RUN.STAGES:
            template = (self.run / "protocol" / f"{stage}-template.md").read_bytes()
            self.assertEqual(b"# Source reader command" in template, stage in RUN.READING_STAGES)
        call = RUN.issue_call(self.source, "summary")
        prefix = json.loads(call["message"].split("# Source reader command (JSON argv prefix)\n")[1].split("\n# ")[0])
        self.assertEqual(prefix[1], str(self.run / "protocol" / "read_source.py"))

    def test_runs_prepared_before_the_reader_keep_self_reported_completion(self):
        manifest = json.loads((self.run / "manifest.json").read_bytes())
        del manifest["protocol_sha256"]["read_source.py"]
        RUN.save_manifest(self.run, manifest)
        self.assertEqual(self.finish_summary([])["status"], "complete")


if __name__ == "__main__":
    unittest.main()
