import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "collect_workspace_sessions.py"


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


COLLECT = load_module("collect_workspace_sessions", SCRIPT)
STRIP = load_module("strip_tool_outputs", ROOT / "strip_tool_outputs.py")


def record(kind, payload):
    return json.dumps({"type": kind, "payload": payload}, ensure_ascii=False).encode() + b"\n"


class CollectWorkspaceSessionsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.workspace = self.root / "workspace with spaces"
        self.workspace.mkdir()
        self.home = self.root / "codex"
        (self.home / "sessions").mkdir(parents=True)
        self.output = self.root / "private"

    def source(self, name="main", cwd=None, source="cli", session_id=None, archive=False, body=b""):
        folder = self.home / ("archived_sessions" if archive else "sessions") / "2026" / "09"
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / (name + ".jsonl")
        meta = {"id": session_id or name, "cwd": str(cwd or self.workspace), "source": source}
        path.write_bytes(record("session_meta", meta) + body)
        return path

    def collect(self, **kwargs):
        return COLLECT.collect(self.workspace, self.home, self.output, **kwargs)

    def snapshot(self, manifest, index=0):
        return self.output / manifest["sessions"][index]["snapshot_path"]

    def test_workspace_membership_and_initial_metadata(self):
        self.source("exact")
        self.source("nested", cwd=self.workspace / "child" / "nested", source="vscode")
        self.source("normalized", cwd=str(self.workspace / "child") + "/../", source="exec")
        alias = self.root / "alias"
        alias.symlink_to(self.workspace, target_is_directory=True)
        self.source("alias", cwd=alias)
        self.source("sibling", cwd=str(self.workspace) + "-other")
        self.source("outside", cwd=self.root, body=record("turn_context", {"cwd": str(self.workspace)}))
        self.source("moved", body=record("turn_context", {"cwd": str(self.root)}))
        result = self.collect()
        self.assertTrue(result["complete"])
        self.assertEqual({x["session_id"] for x in result["sessions"]},
                         {"exact", "nested", "normalized", "alias", "moved"})
        self.assertEqual(result["counts"]["excluded_by_reason"], {"outside_workspace": 2})

    def test_subagent_variants_and_main_forks(self):
        variants = ["subagent", {"subagent": "review"}, {"subagent": {"other": "guardian"}},
                    {"subagent": {"thread_spawn": {"parent_thread_id": "parent"}}},
                    {"subagent": None}]
        for i, source in enumerate(variants):
            self.source(str(i), source=source)
        main = self.source("fork")
        meta = json.loads(main.read_bytes())["payload"]
        meta["forked_from_id"] = "parent"
        main.write_bytes(record("session_meta", meta))
        result = self.collect()
        self.assertTrue(result["complete"])
        self.assertEqual(result["counts"]["excluded_by_reason"]["subagent"], len(variants))
        self.assertEqual([x["session_id"] for x in result["sessions"]], ["fork"])

    def test_unclassified_metadata_and_malformed_headers_do_not_leak(self):
        sentinel = "PRIVATE_CONVERSATION_SENTINEL"
        for name, source in [("missing", None), ("future", {"future": sentinel}),
                             ("unknown_string", sentinel)]:
            self.source(name, source=source)
        for name, payload in [("no_id", {"cwd": str(self.workspace), "source": "cli"}),
                              ("no_cwd", {"id": "x", "source": "cli"}),
                              ("relative_cwd", {"id": "x", "cwd": "relative", "source": "cli"})]:
            self.source(name).write_bytes(record("session_meta", payload))
        self.source("malformed").write_bytes((sentinel + "\n").encode())
        self.source("wrong_type").write_bytes(record("response_item", {"text": sentinel}))
        self.source("duplicate").write_bytes(b'{"type":"session_meta","type":"' + sentinel.encode() + b'"}\n')
        self.source("good", body=record("response_item", {"type": "message", "text": sentinel}))
        result = self.collect()
        self.assertFalse(result["complete"])
        self.assertEqual(result["counts"]["snapshots"], 1)
        self.assertEqual(result["counts"]["excluded_by_reason"]["unclassified"], 6)
        self.assertEqual(result["counts"]["failed"], 3)
        self.assertNotIn(sentinel, json.dumps(result))
        self.assertNotIn(sentinel, (self.output / "manifest.json").read_text())

    def test_archives_deduplication_and_differing_copies(self):
        first = self.source("same", session_id="shared")
        second = self.source("same", session_id="shared", archive=True)
        different = self.source("different", session_id="shared", archive=True, body=b"{}\n")
        result = self.collect()
        self.assertTrue(result["complete"])
        self.assertEqual(result["counts"]["selected"], 3)
        self.assertEqual(result["counts"]["snapshots"], 2)
        self.assertEqual(result["counts"]["duplicates"], 1)
        entries = sorted(result["sessions"], key=lambda x: len(x["source_locations"]))
        self.assertEqual({x["source_path"] for x in entries[1]["source_locations"]}, {str(first), str(second)})
        self.assertEqual(entries[0]["source_path"], str(different))
        self.assertEqual(len(list((self.output / "snapshots").iterdir())), 2)

    def test_same_basename_different_content_never_collides(self):
        self.source("same")
        self.source("same", archive=True, body=b"{}\n")
        result = self.collect()
        names = [entry["snapshot_path"] for entry in result["sessions"]]
        self.assertEqual(len(set(names)), 2)

    def test_snapshot_bytes_hash_permissions_and_trailing_fragment(self):
        body = b'  {"type":"response_item","payload":{"type":"message","text":"secret"}}\r\n'
        path = self.source(body=body)
        expected = path.read_bytes()
        fragment = b'{"in_progress":'
        path.write_bytes(expected + fragment)
        result = self.collect()
        entry = result["sessions"][0]
        self.assertEqual(self.snapshot(result).read_bytes(), expected)
        self.assertEqual(entry["sha256"], hashlib.sha256(expected).hexdigest())
        self.assertEqual(entry["bytes"], len(expected))
        self.assertEqual(entry["source_locations"][0]["omitted_trailing_bytes"], len(fragment))
        self.assertEqual(path.read_bytes(), expected + fragment)
        for directory in (self.output, self.output / "snapshots"):
            self.assertEqual(stat.S_IMODE(directory.stat().st_mode), 0o700)
        for file in (self.snapshot(result), self.output / "manifest.json"):
            self.assertEqual(stat.S_IMODE(file.stat().st_mode), 0o600)
        self.assertEqual(json.loads((self.output / "manifest.json").read_text()), result)

    def test_mutations_during_capture(self):
        real_verify = COLLECT._verify_prefix
        for change in ("append", "truncate", "replace", "prefix_edit", "edit_and_append"):
            with self.subTest(change=change):
                self.output = self.root / change
                path = self.source(body=b'{"original":1}\n')
                before = path.read_bytes()

                def mutate_then_verify(stream, source_path, initial, length, digest):
                    if change == "append":
                        with source_path.open("ab") as target:
                            target.write(b'{"later":1}\n')
                    elif change == "truncate":
                        with source_path.open("r+b") as target:
                            target.truncate(length - 5)
                    elif change == "replace":
                        replacement = self.root / "replacement"
                        replacement.write_bytes(before)
                        replacement.replace(source_path)
                    else:
                        with source_path.open("r+b") as target:
                            target.seek(length - 3)
                            target.write(b"2")
                            if change == "edit_and_append":
                                target.seek(0, 2)
                                target.write(b"{}\n")
                    real_verify(stream, source_path, initial, length, digest)

                with patch.object(COLLECT, "_verify_prefix", side_effect=mutate_then_verify):
                    result = self.collect()
                if change == "append":
                    self.assertTrue(result["complete"])
                    self.assertEqual(self.snapshot(result).read_bytes(), before)
                else:
                    self.assertFalse(result["complete"])
                    self.assertEqual(result["sessions"], [])
                    self.assertEqual(list((self.output / "snapshots").iterdir()), [])

    def test_metadata_change_between_selection_and_capture_is_rejected(self):
        path = self.source()
        real_freeze = COLLECT.freeze_source

        def change_metadata(stream, source_path, initial, metadata, snapshots):
            source_path.write_bytes(path.read_bytes().replace(b'"cli"', b'"bad"'))
            return real_freeze(stream, source_path, initial, metadata, snapshots)

        with patch.object(COLLECT, "freeze_source", side_effect=change_metadata):
            result = self.collect()
        self.assertFalse(result["complete"])
        self.assertEqual(result["errors"][0]["reason"], "source_metadata_changed")

    def test_unreadable_file_and_symlinks_do_not_stop_other_sessions(self):
        unreadable = self.source("unreadable")
        good = self.source("good")
        (good.parent / "link.jsonl").symlink_to(good)
        (self.home / "sessions" / "linked-dir").symlink_to(good.parent, target_is_directory=True)
        real_open = COLLECT.open_source

        def deny_one(path):
            if path == unreadable:
                raise PermissionError("PRIVATE_ERROR_TEXT")
            return real_open(path)

        with patch.object(COLLECT, "open_source", side_effect=deny_one):
            result = self.collect()
        self.assertFalse(result["complete"])
        self.assertEqual(result["counts"]["snapshots"], 1)
        self.assertNotIn("PRIVATE_ERROR_TEXT", json.dumps(result))
        self.assertEqual(len(result["errors"]), 3)

    def test_output_refusals(self):
        self.source()
        existing = self.root / "existing"
        existing.mkdir()
        sentinel = existing / "preserve"
        sentinel.write_text("untouched")
        alias = self.root / "storage-alias"
        alias.symlink_to(self.home / "sessions", target_is_directory=True)
        for output in (existing, self.home / "sessions" / "output",
                       self.home / "archived_sessions" / "output", alias / "output"):
            with self.subTest(output=output), self.assertRaises(COLLECT.CollectionError):
                COLLECT.collect(self.workspace, self.home, output)
        self.assertEqual(sentinel.read_text(), "untouched")

    def test_dry_run_writes_nothing_and_cli_exit_status(self):
        self.source()
        command = [sys.executable, str(SCRIPT), "--workspace", str(self.workspace),
                   "--codex-home", str(self.home), "--dry-run"]
        before = sorted(str(p) for p in self.root.rglob("*"))
        result = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        manifest = json.loads(result.stdout)
        self.assertEqual(manifest["counts"]["selected"], 1)
        self.assertNotIn("snapshot_path", manifest["sessions"][0])
        self.assertEqual(before, sorted(str(p) for p in self.root.rglob("*")))
        self.source("unknown", source="future")
        result = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertFalse(json.loads(result.stdout)["complete"])

    def test_empty_store_and_missing_roots(self):
        result = self.collect()
        self.assertTrue(result["complete"])
        self.assertEqual(result["sessions"], [])
        self.assertEqual(result["missing_roots"], [str(self.home / "archived_sessions")])
        (self.home / "sessions").rmdir()
        result = COLLECT.collect(self.workspace, self.home, dry_run=True)
        self.assertFalse(result["complete"])
        self.assertEqual(result["errors"][0]["reason"], "missing_sessions_root")

    def test_codex_home_resolution(self):
        self.source()
        with patch.dict(os.environ, {"CODEX_HOME": str(self.home)}):
            result = COLLECT.collect(self.workspace, dry_run=True)
            self.assertEqual(result["counts"]["selected"], 1)
        fallback = self.root / ".codex"
        fallback.mkdir()
        (fallback / "sessions").mkdir()
        with patch.dict(os.environ, {"CODEX_HOME": ""}), patch.object(Path, "home", return_value=self.root):
            result = COLLECT.collect(self.workspace, dry_run=True)
            self.assertEqual(result["codex_home"], str(fallback))
            self.assertTrue(result["complete"])

    def test_chunk_boundaries_and_large_trailing_fragment(self):
        path = self.source(body=b"{}\n" + b"x" * 200)
        expected = path.read_bytes()[:-200]
        with patch.object(COLLECT, "CHUNK_SIZE", 31):
            result = self.collect()
        self.assertEqual(self.snapshot(result).read_bytes(), expected)
        self.assertEqual(result["sessions"][0]["bytes"], len(expected))

    def test_collected_snapshot_passes_unchanged_stripper(self):
        body = record("response_item", {"type": "function_call", "name": "exec",
                                        "arguments": "keep-call", "call_id": "c"})
        body += record("response_item", {"type": "function_call_output", "call_id": "c",
                                         "output": "REMOVE_THIS_OUTPUT"})
        path = self.source(body=body)
        original = path.read_bytes()
        manifest = self.collect()
        output = self.output / "stripped.jsonl"
        report = STRIP.filter_rollout(self.snapshot(manifest), output, self.output / "report.json")
        self.assertEqual(report["input"]["sha256"], manifest["sessions"][0]["sha256"])
        self.assertIn(b"keep-call", output.read_bytes())
        self.assertNotIn(b"REMOVE_THIS_OUTPUT", output.read_bytes())
        self.assertEqual(path.read_bytes(), original)
        self.assertEqual(self.snapshot(manifest).read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
