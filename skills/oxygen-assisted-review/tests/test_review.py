"""Behavior tests against an isolated HTTP server; no production data is read."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
import uuid
from contextlib import closing
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("assisted_review", Path(__file__).parents[1] / "scripts" / "review.py")
helper = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(helper)


def fixture():
    return {"id": "fixture-review", "version": 0, "privacyEpoch": 0, "protocolVersion": 9, "format": "v5", "privacyStatus": "redacted",
            "projectName": "Synthetic", "sourcePath": "Synthetic", "provenance": {"inputSha256": "unchanged-import-receipt"},
            "trajectorySummary": {"originalText": "PRIVATE_NAME results", "text": "PRIVATE_NAME results"},
            "summaryGroups": [], "summaryLines": [{"id": "L001", "sourceId": "L001", "text": "PRIVATE_NAME verified a smoke test.", "originalText": "PRIVATE_NAME verified a smoke test.", "kind": "content", "ending": "\n"}],
            "status": "in_review", "insights": [{"id": "I001", "sourceId": "I001", "title": "Inspect smoke results", "originalText": "PRIVATE_NAME original", "text": "", "type": "user-agent",
            "description": "PRIVATE_NAME requires a smoke test before the full run.", "workflow": "Inspect the smoke result before submitting the full run.", "example": "PRIVATE_NAME inspected results; submission remained pending.", "evidence": ["L001"], "presentKeys": ["title", "type", "description", "workflow", "example", "evidence"], "status": "accepted"}]}


class FakeAPI:
    def __init__(self):
        self.review = fixture()
        self.snapshots = [{"version": 0, "note": "", "kind": "initial", "createdAt": "initial", "state": helper.state_of(self.review)}]
        self.requests = {}
        self.force_conflict = False
        self.uncertain_once = False
        self.login_count = 0
        self.neighbor = fixture()

    def process(self, method, path, value):
        if path == "/api/auth/login":
            self.login_count += 1
            return 200, {"authenticated": True}
        if path.startswith('/api/reviews/privacy-operations/'):
            result = self.requests.get(path.rsplit('/', 1)[1])
            return (200, {**copy.deepcopy(result), "replayed": True}) if result else (404, {"error": "not found"})
        if path.split('/')[3] != self.review['id']:
            return 404, {"error": "not found"}
        if method == "GET":
            return 200, {"review": self.review, "snapshots": self.snapshots}
        request_id = value["requestId"]
        if request_id in self.requests:
            return 200, {**copy.deepcopy(self.requests[request_id]), "replayed": True}
        if self.force_conflict or value["expectedVersion"] != self.review["version"]:
            self.force_conflict = False
            return 409, {"error": "PRIVATE_NAME must not leak from server errors"}
        if path.endswith("/privacy"):
            state = helper.baseline_state(value["state"])
            self.review = {**state, 'id': 'review-' + str(uuid.uuid4()), 'version': 0, 'privacyEpoch': 0,
                'protocolVersion': 9, 'format': 'v5', 'privacyStatus': 'redacted', 'projectName': value['projectName'],
                'provenance': {'hashVerified': False, 'runComplete': False}}
            self.review['sourcePath'] = 'review:' + self.review['id']
            self.snapshots = [{"version": 0, "note": "", "kind": "initial", "createdAt": "baseline", "state": state}]
            self.requests = {}
        else:
            self.review.update(helper.state_of(value))
            self.review['version'] += 1
            self.snapshots.append({"version": self.review['version'], "note": value['note'], "kind": "edit", "requestId": request_id, "createdAt": "later", "state": helper.state_of(self.review)})
        result = {"review": copy.deepcopy(self.review), "savedVersion": self.review['version'], "requestId": request_id}
        self.requests[request_id] = result
        if self.uncertain_once:
            self.uncertain_once = False
            return 503, {"error": "uncertain"}
        return 200, result


class HelperTests(unittest.TestCase):
    def setUp(self):
        # Honor the platform's temporary directory (or TMPDIR), outside Git.
        self.temp = tempfile.TemporaryDirectory(prefix="oxygen-review-tests-")
        self.root = Path(self.temp.name)
        self.archive = self.root / "private-history"
        self.api = FakeAPI()
        self.operation_id = str(uuid.uuid4())
        api = self.api

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def handle_request(self):
                length = int(self.headers.get("Content-Length", "0"))
                value = json.loads(self.rfile.read(length)) if length else None
                status, response = api.process(self.command, self.path, value)
                body = json.dumps(response).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            do_GET = handle_request
            do_POST = handle_request

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        self.env = patch.dict(os.environ, {}, clear=True)
        self.env.start()
        self.start()

    def tearDown(self):
        self.env.stop()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def args(self, *values):
        return helper.parser().parse_args(list(map(str, values)))

    def start(self, *extra):
        return helper.start(self.args("start", "--server", self.url, "--review", self.api.review["id"], "--output", self.archive, *extra))

    def read(self, history=False):
        return helper.read(self.args("read", self.archive, *(["--history"] if history else [])))

    def save_input(self, value, name="input.json"):
        path = self.root / name
        path.write_text(json.dumps(value))
        return path

    def apply(self, value, text="Make this clearer.", *extra):
        request_file = self.root / "request.txt"
        request_file.write_text(text)
        return helper.apply(self.args("apply", self.archive, "--request-file", request_file, "--state-file", self.save_input(value), *extra))

    def clean_bundle(self):
        value = self.read()
        # Unused convenience copies deliberately still contain private text.
        value['state'] = json.loads(json.dumps(value['state']).replace('PRIVATE_NAME', 'the researcher'))
        value['labels']['projectName'] = 'Research project'
        return value

    def privacy(self, value, *extra):
        request_file = self.root / "privacy-request.txt"
        request_file.write_text("PRIVATE_NAME is sensitive: remove it throughout saved history.")
        result = helper.privacy(self.args("privacy", self.archive, "--request-file", request_file,
            "--state-file", self.save_input(value, "sanitized.json"), '--request-id', self.operation_id, *extra))
        self.archive = Path(result['archive'])
        return result

    def test_initial_and_edit_keep_actual_decisions_and_private_permissions(self):
        initial = helper.load(self.archive / "0000-initial/snapshot.json")
        self.assertEqual(initial["state"]["insights"][0]["status"], "accepted")
        self.assertNotIn("originalText", json.dumps(initial))
        value = self.read()
        value["state"]["insights"][0]["description"] = "A clearer description."
        result = self.apply(value)
        self.assertEqual(result["savedVersion"], 1)
        self.assertEqual(self.api.review["insights"][0]["status"], "pending")
        self.assertIn("changes=1", result["url"])
        saved = self.archive / "0001"
        self.assertEqual((saved / "request.md").read_text(), "Make this clearer.")
        self.assertIn("+A clearer description.", (saved / "changes.diff").read_text())
        self.assertEqual(helper.load(saved / "receipt.json")["hashes"], helper.file_hashes(saved))
        for path in self.archive.rglob("*"):
            self.assertEqual(path.stat().st_mode & 0o077, 0)

    def test_relative_paths_remain_usable_from_a_different_working_directory(self):
        previous = Path.cwd()
        try:
            os.chdir(self.root)
            helper.start(self.args('start', '--server', self.url, '--review', self.api.review['id'],
                '--output', 'relative-history', '--database', 'reviews.sqlite', '--backup', 'backup.sqlite'))
            archive = self.root / 'relative-history'
            session = helper.load(archive / 'session.json')
            self.assertEqual(session['database'], str(self.root / 'reviews.sqlite'))
            self.assertEqual(session['backups'], [str(self.root / 'backup.sqlite')])
            elsewhere = self.root / 'elsewhere'
            elsewhere.mkdir()
            os.chdir(elsewhere)
            value = helper.read(self.args('read', '../relative-history'))
            value['state']['insights'][0]['description'] = 'A clearer description.'
            Path('state.json').write_text(json.dumps(value))
            Path('request.md').write_text('Make this clearer.')
            result = helper.apply(self.args('apply', '../relative-history', '--state-file', 'state.json', '--request-file', 'request.md'))
            self.assertEqual(result['savedVersion'], 1)
            self.assertTrue((archive / '0001' / 'snapshot.json').is_file())
        finally:
            os.chdir(previous)

    def test_backup_uses_configured_temporary_storage(self):
        source = self.root / 'source.sqlite'
        with closing(sqlite3.connect(source)) as db:
            db.execute('create table sample (value text)')
            db.execute("insert into sample values ('preserved')")
            db.commit()
        temporary = self.root / 'scratch'
        temporary.mkdir()
        created = []
        make_temporary = tempfile.mkstemp

        def record_temporary(**kwargs):
            fd, path = make_temporary(**kwargs)
            if kwargs.get('prefix') == 'oxygen-review-backup-':
                created.append(Path(path).parent)
            return fd, path

        with patch.dict(os.environ, {'TMPDIR': str(temporary)}), patch.object(tempfile, 'tempdir', None), patch.object(tempfile, 'mkstemp', side_effect=record_temporary):
            failures = helper.refresh_backups({'database': str(source), 'backups': [str(self.root / 'backup.sqlite')]})
            self.assertEqual(failures, [])
            self.assertEqual(created, [temporary])
        self.assertEqual(list(temporary.iterdir()), [])
        with closing(sqlite3.connect(self.root / 'backup.sqlite')) as db:
            self.assertEqual(db.execute('select value from sample').fetchone(), ('preserved',))

    def test_comment_replay_and_explicit_approval(self):
        value = self.read()
        first = self.apply(value, "Looks good; note the unresolved submission.")
        repeated = self.apply(value, "Looks good; note the unresolved submission.")
        self.assertEqual(first["requestId"], repeated["requestId"])
        self.assertTrue(repeated["replayed"])
        self.assertEqual(self.api.review["version"], 1)
        self.assertEqual(self.api.snapshots[-1]["note"], "Looks good; note the unresolved submission.")
        self.assertEqual((self.archive / "0001/changes.diff").read_text(), "No insight changes.\n")
        value = self.read()
        value["state"]["insights"][0]["workflow"] = "Inspect the recorded smoke result."
        self.apply(value, "Change the wording and approve it.", "--approve", "I001")
        self.assertEqual(self.api.review["insights"][0]["status"], "accepted")

    def test_open_link_uses_workspace_server_after_edit_and_replay(self):
        # The browser's forwarded port is on the client, not this workspace.
        session = helper.load(self.archive / 'session.json')
        session['browserUrl'] = 'http://localhost:53978/?review=fixture-review&insight=I001'
        helper.save(self.archive / 'session.json', session)
        value = self.read()
        value['state']['insights'][0]['description'] = 'A clearer description.'
        first = self.apply(value)
        repeated = self.apply(value)
        for result in (first, repeated):
            self.assertEqual(result['openUrl'], self.url + '/?review=fixture-review&insight=I001&changes=1')
            self.assertTrue(result['refreshRequired'])
            self.assertTrue(result['url'].startswith('http://localhost:53978/'))
            # The real helper output reaches the saved review from the workspace.
            parts = helper.parse.urlsplit(result['openUrl'])
            review_id = helper.parse.parse_qs(parts.query)['review'][0]
            history = helper.Client(helper.parse.urlunsplit((parts.scheme, parts.netloc, '', '', ''))).history(review_id)
            self.assertEqual(history['review']['version'], 1)
        self.assertEqual(self.api.review['version'], 1)

    def test_privacy_open_link_uses_workspace_server_and_only_new_identity(self):
        session = helper.load(self.archive / 'session.json')
        session['browserUrl'] = 'http://localhost:53978/?review=fixture-review&run=PRIVATE_NAME&insight=I001'
        helper.save(self.archive / 'session.json', session)
        clean = self.clean_bundle()
        first = self.privacy(clean)
        repeated = self.privacy(clean)
        for result in (first, repeated):
            self.assertEqual(result['openUrl'], self.url + '/?review=' + result['reviewId'] + '&changes=0')
            self.assertNotIn('PRIVATE_NAME', result['openUrl'])
            self.assertNotIn('fixture-review', result['openUrl'])
            self.assertTrue(result['refreshRequired'])

    def test_add_reorder_remove_and_preserve_existing_origin(self):
        value = self.read()
        added = copy.deepcopy(value["state"]["insights"][0])
        added.update({"id": "I002", "title": "Reviewer suggestion", "evidence": [], "example": "A proposed application, not an observed event."})
        added.pop("sourceId")
        value["state"]["insights"].insert(0, added)
        self.apply(value)
        first, second = self.api.review["insights"]
        self.assertEqual(first["authorship"], "reviewer")
        self.assertEqual(first["status"], "pending")
        self.assertEqual(second["id"], "I002")
        self.assertEqual(second["sourceId"], "I001")
        self.assertEqual(second["status"], "accepted")
        value = self.read()
        value["state"]["insights"].pop(0)
        self.apply(value, "Remove the suggestion.")
        self.assertEqual(len(self.api.review["insights"]), 1)
        self.assertEqual(self.api.review["insights"][0]["id"], "I001")

    def test_api_conflict_keeps_request_and_allows_reconciliation(self):
        value = self.read()
        self.api.force_conflict = True
        with self.assertRaisesRegex(helper.ReviewError, "409"):
            self.apply(value)
        self.assertEqual(self.api.review["version"], 0)
        self.assertNotIn("pending", helper.load(self.archive / "session.json"))
        self.assertEqual(helper.load(self.archive / "0001/receipt.json")["outcome"], "failed")
        self.apply(self.read(), "Reconciled request.")
        self.assertEqual(self.api.review["version"], 1)

    def test_uncertain_http_response_replays_exact_saved_state(self):
        value = self.read()
        self.api.uncertain_once = True
        with self.assertRaises(helper.ReviewError):
            self.apply(value)
        self.assertEqual(self.api.review["version"], 1)
        result = self.apply(value)
        self.assertTrue(result["replayed"])
        self.assertEqual(self.api.review["version"], 1)

    def test_archive_write_failure_reconciles_without_second_revision(self):
        value = self.read()
        with patch.object(helper, "write_snapshot", side_effect=OSError("disk unavailable")):
            with self.assertRaises(OSError):
                self.apply(value)
        self.assertEqual(self.api.review["version"], 1)
        self.assertIn("pending", helper.load(self.archive / "session.json"))
        result = self.apply(value)
        self.assertTrue(result["replayed"])
        self.assertEqual(helper.load(self.archive / "0001/snapshot.json")["version"], 1)

    def test_read_failure_records_last_known_state_without_replacing_saved_receipt(self):
        value = self.read()
        self.apply(value)
        receipt = helper.load(self.archive / "0001/receipt.json")
        with patch.object(helper.Client, "history", side_effect=helper.ReviewError("unavailable")):
            with self.assertRaises(helper.ReviewError):
                self.apply(value)
            with self.assertRaises(helper.ReviewError):
                self.apply(value, "New request while unavailable.")
        self.assertEqual(helper.load(self.archive / "0001/receipt.json"), receipt)
        failed = helper.load(self.archive / "0002/receipt.json")
        self.assertEqual(failed["outcome"], "failed")
        self.assertFalse(failed["snapshotFresh"])

    def test_stale_and_foreign_inputs_are_rejected(self):
        stale = self.read()
        self.apply(stale)
        with self.assertRaisesRegex(helper.ReviewError, "Version conflict"):
            self.apply(stale, "Different request from old state.")
        failed = helper.load(self.archive / "0002/receipt.json")
        self.assertEqual(failed["outcome"], "failed")
        self.assertEqual(failed["observedVersion"], 1)
        value = self.read()
        value["reviewId"] = "other-review"
        with self.assertRaisesRegex(helper.ReviewError, "another review"):
            self.apply(value)
        value = self.read()
        value["state"]["insights"][0]["evidence"] = ["L999"]
        with self.assertRaisesRegex(helper.ReviewError, "evidence"):
            self.apply(value)
        self.assertEqual(helper.load(self.archive / "0003/receipt.json")["outcome"], "failed")

    def test_privacy_replaces_every_prior_file_with_one_baseline(self):
        self.apply(self.read(), 'PRIVATE_NAME wants more readable examples.')
        old = self.archive
        neighbor = copy.deepcopy(self.api.neighbor)
        clean = self.clean_bundle()
        result = self.privacy(clean)
        self.assertFalse(old.exists())
        self.assertEqual(result['savedVersion'], 0)
        self.assertEqual(result['outcome'], 'saved')
        self.assertTrue(result['refreshRequired'])
        self.assertEqual(sorted(p.name for p in self.archive.iterdir()), ['.lock', '0000-initial', 'session.json'])
        self.assertEqual(len(self.api.snapshots), 1)
        self.assertEqual(self.api.snapshots[0]['kind'], 'initial')
        self.assertEqual(self.api.snapshots[0]['note'], '')
        self.assertEqual(self.api.review['provenance'], {'hashVerified':False,'runComplete':False})
        for path in self.archive.rglob('*'):
            if path.is_file():
                for secret in (b'PRIVATE_NAME', b'unchanged-import-receipt', b'fixture-review', b'sourceId'):
                    self.assertNotIn(secret, path.read_bytes(), path.name)
        self.assertEqual(self.api.neighbor, neighbor)
        self.assertTrue(self.privacy(clean)['replayed'])
        value = self.read()
        value['state']['insights'][0]['description'] = 'Improve this clean description.'
        self.apply(value, 'Clarify the new baseline.')
        self.assertTrue((self.archive / '0001/receipt.json').exists())
        self.assertNotIn('authorship', self.api.review['insights'][0])
        self.assertEqual(self.api.review['version'], 1)
        self.privacy(clean)
        self.assertEqual(self.api.review['version'], 1)
        self.assertEqual(helper.load(self.archive/'session.json')['lastVersion'], 1)
        self.assertTrue((self.archive/'0001/receipt.json').exists())

    def test_privacy_with_removed_evidence_requires_review(self):
        clean = self.clean_bundle()
        clean['state']['insights'][0]['evidence'] = []
        self.privacy(clean)
        self.assertEqual(self.api.review['insights'][0]['status'], 'needs_review')
        self.assertNotIn('authorship', self.api.review['insights'][0])

    def test_privacy_invalid_stale_or_legacy_inputs_do_not_reset(self):
        clean = self.clean_bundle()
        clean['state']['insights'][0]['evidence'] = ['L999']
        with self.assertRaisesRegex(helper.ReviewError, 'evidence'):
            self.privacy(clean)
        clean = self.clean_bundle()
        self.apply(self.read())
        with self.assertRaisesRegex(helper.ReviewError, 'Version conflict'):
            self.privacy(clean)
        args = self.args('privacy', self.archive, '--history-file', self.save_input(clean), '--request-file', self.root/'request.txt', '--request-id', self.operation_id)
        with self.assertRaisesRegex(helper.ReviewError, 'no longer supported'):
            helper.privacy(args)
        self.assertEqual(self.api.review['id'], 'fixture-review')

    def test_privacy_removes_comment_and_manual_edit_history(self):
        state = helper.state_of(self.api.review)
        state['insights'][0]['title'] = 'A manual browser edit'
        self.api.process('POST', '/api/reviews/fixture-review/revisions', {**state, 'expectedVersion':0, 'requestId':'browser-edit','note':'PRIVATE_NAME comment'})
        self.apply(self.read(), 'Keep this useful card.')
        self.privacy(self.clean_bundle())
        self.assertFalse((self.archive/'0001').exists())
        self.assertEqual(self.api.review['insights'][0]['title'], 'A manual browser edit')
        self.assertNotIn('browser-edit', json.dumps(self.api.requests))

    def test_privacy_removes_source_labels_and_old_query_filters(self):
        self.api.review['projectName'] = 'PRIVATE_NAME project'
        self.api.review['sourcePath'] = 'PRIVATE_NAME source'
        session = helper.load(self.archive/'session.json')
        session['browserUrl'] = self.url + '/?review=fixture-review&run=PRIVATE_NAME&insight=I002'
        helper.save(self.archive/'session.json', session)
        result = self.privacy(self.clean_bundle())
        self.assertEqual(self.api.review['projectName'], 'Research project')
        self.assertNotIn('PRIVATE_NAME', result['url'])
        self.assertNotIn('run=', result['url'])
        self.assertNotIn('insight=', result['url'])

    def test_privacy_archive_failure_recovers_from_saved_baseline(self):
        clean = self.clean_bundle()
        old = self.archive
        with patch.object(helper, 'write_snapshot', side_effect=OSError('disk unavailable')):
            with self.assertRaises(OSError):
                self.privacy(clean)
        self.assertEqual(self.api.review['version'], 0)
        self.assertIn('pendingPrivacy', helper.load(old/'session.json'))
        with self.assertRaisesRegex(helper.ReviewError, 'incomplete'):
            self.read()
        result = self.privacy(clean)
        self.assertTrue(result['replayed'])
        self.assertFalse(old.exists())
        self.assertFalse(helper.load(self.archive/'session.json')['cleanupPending'])

    def test_privacy_recovers_after_old_archive_deleted_before_publish(self):
        clean = self.clean_bundle()
        old = self.archive
        with patch.object(helper.os, 'rename', side_effect=OSError('interrupted publish')):
            with self.assertRaises(OSError):
                self.privacy(clean)
        self.assertFalse(old.exists())
        result = self.privacy(clean)
        self.assertEqual(result['outcome'], 'saved')
        self.assertTrue((self.archive/'0000-initial/snapshot.json').exists())

    def test_privacy_uncertain_response_reuses_the_same_baseline(self):
        clean = self.clean_bundle()
        self.api.uncertain_once = True
        with self.assertRaises(helper.ReviewError):
            self.privacy(clean)
        new_id = self.api.review['id']
        self.privacy(clean)
        self.assertEqual(self.api.review['id'], new_id)

    def test_external_privacy_epoch_prevents_old_archive_reuse(self):
        self.api.review['privacyEpoch'] = 1
        with self.assertRaisesRegex(helper.ReviewError, 'sanitized elsewhere'):
            self.read()

    def test_privacy_server_conflict_releases_pending_operation(self):
        self.api.force_conflict = True
        with self.assertRaisesRegex(helper.ReviewError, '409'):
            self.privacy(self.clean_bundle())
        self.assertNotIn('pendingPrivacy', helper.load(self.archive/'session.json'))
        self.privacy(self.clean_bundle())
        self.assertEqual(self.api.review['version'], 0)

    def test_later_reset_cannot_be_undone_by_older_recovery(self):
        clean = self.clean_bundle()
        old = self.archive
        previous_operation = self.operation_id
        self.privacy(clean)
        former = self.archive
        self.operation_id = str(uuid.uuid4())
        self.privacy(self.clean_bundle())
        current_id = self.api.review['id']
        self.assertFalse(former.exists())
        self.archive = old
        self.operation_id = previous_operation
        with self.assertRaises(helper.ReviewError):
            self.privacy(clean)
        self.assertEqual(self.api.review['id'], current_id)

    def test_archive_lock_rejects_concurrent_writer(self):
        with helper.locked(self.archive):
            with self.assertRaisesRegex(helper.ReviewError, "Another helper"):
                self.apply(self.read())

    def test_archive_git_and_symlink_guards(self):
        (self.root / ".git").mkdir()
        with self.assertRaisesRegex(helper.ReviewError, "outside Git"):
            self.read()
        (self.root / ".git").rmdir()
        (self.archive / "leak").symlink_to(self.root / "outside")
        with self.assertRaisesRegex(helper.ReviewError, "symlink"):
            self.read()

    def test_registered_database_backups_refresh_and_report_failure(self):
        source, backup = self.root / "source.sqlite", self.root / "backup.sqlite"
        with closing(sqlite3.connect(source)) as connection:
            connection.execute("CREATE TABLE example (text TEXT)")
            connection.execute("INSERT INTO example VALUES ('sanitized')")
            connection.commit()
        session = helper.load(self.archive / "session.json")
        session.update({"database": str(source), "backups": [str(backup), str(self.root / "missing-parent" / "backup.sqlite")]})
        helper.save(self.archive / "session.json", session)
        result = self.privacy(self.clean_bundle())
        self.assertEqual(result["backupFailures"], [{"backupIndex": 2, "status": "not_refreshed"}])
        self.assertEqual(result['outcome'], 'incomplete')
        self.assertFalse(result['refreshRequired'])
        with self.assertRaisesRegex(helper.ReviewError, 'incomplete'):
            self.read()
        (self.root/'missing-parent').mkdir()
        clean = json.loads((self.root/'sanitized.json').read_text())
        self.assertEqual(self.privacy(clean)['outcome'], 'saved')
        with closing(sqlite3.connect(backup)) as connection:
            self.assertEqual(connection.execute("SELECT text FROM example").fetchone()[0], "sanitized")

    def test_authentication_reads_environment_without_persisting_credentials(self):
        with patch.dict(os.environ, {"OXYGEN_REVIEW_USERNAME": "synthetic-user", "OXYGEN_REVIEW_PASSWORD": "synthetic-password"}):
            self.read()
        self.assertEqual(self.api.login_count, 1)
        self.assertNotIn("synthetic-password", (self.archive / "session.json").read_text())


if __name__ == "__main__":
    unittest.main()
