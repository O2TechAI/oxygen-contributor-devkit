#!/usr/bin/env python3
"""Save agent-assisted review requests and snapshots without using exports.

Use --help or COMMAND --help. Authentication is read from environment variables
OXYGEN_REVIEW_COOKIE or OXYGEN_REVIEW_USERNAME/OXYGEN_REVIEW_PASSWORD. Credentials
are never persisted. Archives must be private directories outside Git. File
arguments accept relative paths; temporary storage follows the system default
or TMPDIR. Saved data paths are resolved when the archive is initialized.
"""
from __future__ import annotations

import argparse
import copy
import difflib
import hashlib
import http.cookiejar
import json
import os
from pathlib import Path
import re
import shutil
import uuid
import sqlite3
import sys
import tempfile
from contextlib import closing, contextmanager
from datetime import datetime, timezone
from urllib import error, parse, request

STATE_KEYS = ("trajectorySummary", "summaryGroups", "summaryLines", "insights", "status")
STATUSES = {"pending", "accepted", "rejected", "needs_review"}


class ReviewError(Exception):
    """Safe diagnostic that never embeds request content or server response bodies."""

    def __init__(self, message, http_status=None):
        super().__init__(message)
        self.http_status = http_status


def stamp():
    return datetime.now(timezone.utc).isoformat()


def stripped(value):
    if isinstance(value, dict):
        return {k: stripped(v) for k, v in value.items() if k != "originalText"}
    if isinstance(value, list):
        return [stripped(v) for v in value]
    return value


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode()


def digest(value):
    return hashlib.sha256(encoded(value)).hexdigest()


def load(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise ReviewError("Cannot read the required JSON file.") from None


def safe_path(path):
    path = Path(os.path.abspath(path))
    if any(p.is_symlink() for p in (path, *path.parents)):
        raise ReviewError("Managed paths must not contain symlinks.")
    return path


def outside_git(path):
    path = safe_path(path)
    if any((p / ".git").exists() for p in (path, *path.parents)):
        raise ReviewError("The private review archive must be outside Git.")
    return path


def atomic(path, data):
    path = safe_path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(path.parent, 0o700)
    fd, temporary = tempfile.mkstemp(prefix=".writing-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data if isinstance(data, bytes) else data.encode())
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def save(path, value):
    atomic(path, encoded(value))


@contextmanager
def locked(path, create=False):
    root = outside_git(path)
    if not root.exists() and not create:
        raise ReviewError("Archive does not exist; run start first.")
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(root, 0o700)
    for child in root.rglob("*"):
        if child.is_symlink():
            raise ReviewError("Archive contains a symlink; refusing to read or change it.")
    # Atomic directory creation also works when the shared filesystem's advisory
    # lock service is unavailable. A crash leaves a claim for explicit recovery.
    claim = root / ".operation-lock"
    try:
        claim.mkdir(mode=0o700)
    except FileExistsError:
        raise ReviewError("Another helper is using this archive; reconcile a stale .operation-lock before retrying.") from None
    try:
        yield root
    finally:
        claim.rmdir()


class Client:
    def __init__(self, server):
        parts = parse.urlsplit(server)
        if parts.scheme not in {"http", "https"} or not parts.netloc or parts.username or parts.password or parts.query or parts.fragment:
            raise ReviewError("Provide an HTTP(S) server URL without credentials, query, or fragment.")
        self.server = server.rstrip("/")
        self.opener = request.build_opener(request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        self.cookie = os.environ.get("OXYGEN_REVIEW_COOKIE")
        username, password = os.environ.get("OXYGEN_REVIEW_USERNAME"), os.environ.get("OXYGEN_REVIEW_PASSWORD")
        if not self.cookie and username and password:
            self.call("POST", "/api/auth/login", {"username": username, "password": password})

    def call(self, method, path, body=None):
        headers = {"Accept": "application/json"}
        if self.cookie:
            headers["Cookie"] = self.cookie
        data = None if body is None else encoded(body)
        if data is not None:
            headers["Content-Type"] = "application/json"
        try:
            with self.opener.open(request.Request(self.server + path, data=data, headers=headers, method=method), timeout=45) as response:
                return json.load(response)
        except error.HTTPError as exc:
            code = exc.code
            exc.close()
            if code == 409:
                raise ReviewError("Version conflict (HTTP 409): read fresh state and reconcile; the saved review was not overwritten.", 409) from None
            raise ReviewError(f"Review API rejected the operation (HTTP {code}); request content omitted.", code) from None
        except (error.URLError, TimeoutError, ValueError, OSError):
            raise ReviewError("Review API unavailable or returned invalid JSON. Retry with the same request ID to reconcile an uncertain save.") from None

    def history(self, review_id):
        value = stripped(self.call("GET", f"/api/reviews/{parse.quote(review_id, safe='')}/revisions"))
        if value.get("review", {}).get("id") != review_id or not isinstance(value.get("snapshots"), list):
            raise ReviewError("Review history identity or format is invalid.")
        return value


def state_of(review):
    try:
        return stripped({key: review[key] for key in STATE_KEYS})
    except KeyError:
        raise ReviewError("Review state is incomplete.") from None


def snapshot(review, state=None, version=None):
    return {"reviewId": review["id"], "version": review["version"] if version is None else version,
            "privacyEpoch": review.get("privacyEpoch", 0), "protocolVersion": review["protocolVersion"],
            "format": review["format"], "labels": {key: review.get(key, "") for key in ("projectName", "sourcePath")},
            "state": state_of(review) if state is None else stripped(state)}


def markdown(snap):
    state = snap["state"]
    result = [f"# Review {snap['reviewId']}", f"Review status: {state['status']}", "## Trajectory summary", state["trajectorySummary"]["text"], "## Summary lines"]
    result.extend(f"{line['id']} {line['text']}" for line in state["summaryLines"])
    for group in state["summaryGroups"]:
        result.extend([f"### Group {group['id']}", group["text"], "Lines: " + ", ".join(group["lineIds"])])
    for card in state["insights"]:
        result.extend([f"# {card['id']}", f"Status: {card['status']}", f"Authorship: {card.get('authorship', 'extracted')}"])
        if card.get("sourceId"):
            result.append("Source ID: " + card["sourceId"])
        fields = ("title", "type", "description", "workflow", "example", "scope", "takeaway", "appliesWhen", "why", "text")
        for field in fields:
            if card.get(field):
                result.append(f"{field[0].upper() + field[1:]}:\n\n{card[field]}")
        result.append("Evidence: " + ", ".join(card["evidence"]))
    return "\n\n".join(result).rstrip() + "\n"


def delta(before, after):
    a, b = markdown(before), markdown(after)
    if a == b:
        return "No insight changes.\n"
    return "".join(difflib.unified_diff(a.splitlines(True), b.splitlines(True), fromfile="before", tofile="after"))


def write_snapshot(directory, snap):
    save(directory / "snapshot.json", stripped(snap))
    atomic(directory / "insights.md", markdown(snap))


def file_hashes(directory):
    return {name: hashlib.sha256((directory / name).read_bytes()).hexdigest()
            for name in ("request.md", "snapshot.json", "insights.md", "changes.diff") if (directory / name).exists()}


def entries(root):
    values = []
    for path in sorted(root.iterdir()):
        if re.fullmatch(r"\d{4,}(?:-initial)?", path.name) and path.is_dir():
            value = {"directory": path.name, "snapshot": load(path / "snapshot.json")}
            if (path / "request.md").exists():
                value["request"] = (path / "request.md").read_text(encoding="utf-8")
                value["receipt"] = load(path / "receipt.json")
            values.append(value)
    return values


def next_directory(root):
    numbers = [int(p.name.split("-")[0]) for p in root.iterdir() if re.fullmatch(r"\d{4,}(?:-initial)?", p.name)]
    return root / f"{max(numbers, default=0) + 1:04d}"


def context(session, history):
    review = history["review"]
    if review.get("privacyEpoch", 0) != session.get("privacyEpoch", 0):
        raise ReviewError("Saved history was sanitized elsewhere. This archive is stale; reconcile all archived content before further edits.")


def read_bundle(root, session, history, include_history=False):
    review = history["review"]
    value = {"reviewId": review["id"], "server": session["server"], "expectedVersion": review["version"],
             "privacyEpoch": review.get("privacyEpoch", 0), "review": review, "state": state_of(review),
             "labels": {key: review[key] for key in ("projectName", "sourcePath")}}
    if include_history:
        value["labels"] = {key: review[key] for key in ("projectName", "sourcePath")}
        value["snapshots"] = history["snapshots"]
        value["archive"] = entries(root)
        value["baseHash"] = digest(value)
    return value


def validate_state(state, review):
    if not isinstance(state, dict) or set(state) != set(STATE_KEYS):
        raise ReviewError("State must contain exactly trajectorySummary, summaryGroups, summaryLines, insights, and status.")
    if state["status"] not in {"ready", "in_review", "completed"}:
        raise ReviewError("Invalid review status.")
    if not isinstance(state["trajectorySummary"], dict) or not isinstance(state["trajectorySummary"].get("text"), str):
        raise ReviewError("Invalid trajectory summary.")
    if not all(isinstance(state[key], list) for key in ("summaryGroups", "summaryLines", "insights")):
        raise ReviewError("Summary groups, lines, and insights must be lists.")
    line_ids = set()
    for index, line in enumerate(state["summaryLines"], 1):
        if not isinstance(line, dict) or line.get("id") != f"L{index:03}" or not isinstance(line.get("text"), str) or "\n" in line["text"] or "\r" in line["text"]:
            raise ReviewError("Summary lines must have consecutive IDs and physical-line text.")
        if line.get("kind") == "content":
            line_ids.add(line["id"])
    all_lines = {line["id"] for line in state["summaryLines"]}
    for group in state["summaryGroups"]:
        if not isinstance(group, dict) or not isinstance(group.get("text"), str) or not isinstance(group.get("lineIds"), list) or not set(group["lineIds"]).issubset(all_lines):
            raise ReviewError("Summary group references are invalid.")
    for index, card in enumerate(state["insights"], 1):
        if not isinstance(card, dict) or card.get("id") != f"I{index:03}" or card.get("status") not in STATUSES:
            raise ReviewError("Insight IDs must be consecutive and decisions valid.")
        evidence = card.get("evidence")
        if not isinstance(evidence, list) or any(not isinstance(value, str) for value in evidence) or len(evidence) != len(set(evidence)) or not set(evidence).issubset(line_ids):
            raise ReviewError("Insight evidence must reference unique content lines.")
        if card.get("authorship") not in {None, "reviewer"}:
            raise ReviewError("Unsupported insight authorship.")
        if review["protocolVersion"] == 9:
            keys = ["title", "type", "description", "workflow", "example", "evidence"]
            if card.get("type") not in {"agent", "user-agent"} or any(not isinstance(card.get(k), str) or not card[k].strip() for k in keys[:-1]) or sorted(card.get("presentKeys", [])) != sorted(keys) or card.get("text") != "":
                raise ReviewError("Protocol 9 insights require the six existing fields and a valid origin type.")
        if not evidence and card.get("authorship") != "reviewer" and card["status"] not in {"needs_review", "rejected"}:
            raise ReviewError("Extracted insights need evidence; reviewer additions may have empty evidence.")
    if state["status"] == "completed" and (review.get("privacyStatus") != "redacted" or any(c["status"] not in {"accepted", "rejected"} for c in state["insights"])):
        raise ReviewError("Completion requires a redacted review with every insight decided.")


def prepare_state(value, current, approved):
    state = stripped(copy.deepcopy(value.get("state", value)))
    if "expectedVersion" in state:
        del state["expectedVersion"]
    previous = current["insights"]
    origins = {c.get("sourceId", c["id"]): c for c in previous}
    seen = set()
    for index, card in enumerate(state.get("insights", []), 1):
        old_id = card.get("id")
        source = card.get("sourceId")
        old = origins.get(source) if source else next((c for c in previous if c["id"] == old_id), None)
        if old is None and not source:
            old = next((c for c in previous if c["id"] == old_id and c == card), None)
        if old is None:
            card["authorship"] = "reviewer"
            card.pop("sourceId", None)
        else:
            key = old.get("sourceId", old["id"])
            if key in seen:
                raise ReviewError("An existing insight cannot appear twice; add a new reviewer card instead.")
            seen.add(key)
            if old.get("sourceId"):
                card["sourceId"] = old["sourceId"]
            if old.get("authorship"):
                card["authorship"] = old["authorship"]
        changed = old is None or {k: v for k, v in card.items() if k not in {"id", "status"}} != {k: v for k, v in old.items() if k not in {"id", "status"}}
        card["id"] = f"I{index:03}"
        if changed:
            card["status"] = "needs_review" if not card.get("evidence") and card.get("authorship") != "reviewer" else "pending"
        if card["id"] in approved:
            card["status"] = "accepted"
    if not set(approved).issubset({c["id"] for c in state.get("insights", [])}):
        raise ReviewError("An explicit approval references a missing insight.")
    if state.get("status") == "completed" and any(c.get("status") not in {"accepted", "rejected"} for c in state.get("insights", [])):
        state["status"] = "in_review"
    validate_state(state, current)
    return state


def review_url(session, version, *, workspace=False):
    browser = parse.urlsplit(session.get("browserUrl") or session["server"])
    # Codex opens workspace URLs and establishes its own browser forwarding.
    # A client-side forwarded localhost port is not a workspace listener.
    parts = parse.urlsplit(session["server"]) if workspace else browser
    query = dict(parse.parse_qsl(browser.query))
    query.update({"review": session["reviewId"], "changes": str(version)})
    return parse.urlunsplit((parts.scheme, parts.netloc, parts.path or "/", parse.urlencode(query), ""))


def operation_id(kind, fingerprint, supplied=None):
    value = supplied or "assisted-" + kind + "-" + fingerprint[:32]
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", value):
        raise ReviewError("Request ID must contain 1–128 letters, digits, dots, underscores, colons, or hyphens.")
    return value


def finish_entry(root, session, pending, response):
    directory = root / pending["directory"]
    review = response["review"]
    if review.get("id") != session["reviewId"] or response.get("savedVersion") != review.get("version"):
        raise ReviewError("Save response identity or version is invalid; retry the same request ID.")
    after = snapshot(review)
    write_snapshot(directory, after)
    atomic(directory / "request.md", pending["request"])
    atomic(directory / "changes.diff", delta(pending["before"], after))
    receipt = {"requestId": pending["requestId"], "savedVersion": review["version"], "outcome": "saved", "kind": pending["kind"],
               "createdAt": pending["createdAt"], "completedAt": stamp(), "inputHash": pending["inputHash"], "hashes": file_hashes(directory)}
    save(directory / "receipt.json", receipt)
    session.pop("pending", None)
    session["lastVersion"] = max(session.get("lastVersion", 0), review["version"])
    session["privacyEpoch"] = review.get("privacyEpoch", session.get("privacyEpoch", 0))
    save(root / "session.json", session)
    return {"requestId": pending["requestId"], "savedVersion": review["version"], "archive": str(directory),
            "url": review_url(session, review["version"]), "openUrl": review_url(session, review["version"], workspace=True),
            "replayed": response.get("replayed", False), "refreshRequired": True}


def record_failure(root, request_id, fingerprint, request_text, observed, *, kind="edit", fresh=True):
    """Retain the request with observed state; never label a failed save accepted."""
    existing = next((entry for entry in entries(root) if entry.get("receipt", {}).get("requestId") == request_id), None)
    if existing and existing["receipt"].get("outcome") == "saved":
        return
    directory = root / existing["directory"] if existing else next_directory(root)
    write_snapshot(directory, observed)
    atomic(directory / "request.md", request_text)
    atomic(directory / "changes.diff", "No insight changes were saved by this request.\n")
    save(directory / "receipt.json", {"requestId": request_id, "inputHash": fingerprint, "outcome": "failed",
                                     "kind": kind, "observedVersion": observed["version"], "snapshotFresh": fresh,
                                     "createdAt": stamp(), "hashes": file_hashes(directory)})


def start(args):
    with locked(args.output, create=True) as root:
        session_path = root / "session.json"
        if session_path.exists():
            existing = load(session_path)
            if existing["reviewId"] != args.review or existing["server"] != args.server.rstrip("/"):
                raise ReviewError("Archive already belongs to another review or server.")
            return {"archive": str(root), "reviewId": args.review, "existing": True}
        if any(p.name not in {".lock", ".operation-lock"} for p in root.iterdir()):
            raise ReviewError("New archive directory is not empty.")
        client = Client(args.server)
        history = client.history(args.review)
        review = history["review"]
        if args.backup and not args.database:
            raise ReviewError("Registered backups require --database pointing to their SQLite source.")
        database = str(safe_path(args.database)) if args.database else None
        backups = [str(outside_git(p)) for p in args.backup]
        if database in backups:
            raise ReviewError("A backup cannot replace its source database.")
        session = {"schemaVersion": 1, "reviewId": args.review, "server": client.server,
                   "browserUrl": args.browser_url, "createdAt": stamp(), "lastVersion": review["version"],
                   "privacyEpoch": review.get("privacyEpoch", 0), "database": database, "backups": backups}
        write_snapshot(root / "0000-initial", snapshot(review))
        save(session_path, session)
        return {"archive": str(root), "reviewId": args.review, "version": review["version"]}


def read(args):
    with locked(args.archive) as root:
        session = load(root / "session.json")
        if session.get("pendingPrivacy") or session.get("cleanupPending"):
            raise ReviewError("Privacy cleanup is incomplete; repeat privacy with the same sanitized bundle before reading history.")
        history = Client(session["server"]).history(session["reviewId"])
        context(session, history)
        result = read_bundle(root, session, history, args.history)
        if session.get("pending"):
            result["pendingRequestId"] = session["pending"]["requestId"]
        return result


def apply(args):
    value = load(args.state_file)
    try:
        request_text = Path(args.request_file).read_text(encoding="utf-8")
    except OSError:
        raise ReviewError("Cannot read request file.") from None
    fingerprint = digest({"request": request_text, "input": value, "approve": args.approve})
    request_id = operation_id("edit", fingerprint, args.request_id)
    with locked(args.archive) as root:
        session = load(root / "session.json")
        if session.get("pendingPrivacy") or session.get("cleanupPending"):
            raise ReviewError("Finish the interrupted privacy operation before editing.")
        if value.get("reviewId", session["reviewId"]) != session["reviewId"] or value.get("server", session["server"]) != session["server"]:
            raise ReviewError("Edited state belongs to another review or server.")
        client = Client(session["server"])
        try:
            history = client.history(session["reviewId"])
        except ReviewError:
            if not session.get("pending"):
                record_failure(root, request_id, fingerprint, request_text, entries(root)[-1]["snapshot"], fresh=False)
            raise
        context(session, history)
        pending = session.get("pending")
        if pending and (pending["requestId"] != request_id or pending["inputHash"] != fingerprint):
            raise ReviewError("An earlier request is unfinished; retry its exact inputs and request ID first.")
        if not pending:
            for entry in entries(root):
                receipt = entry.get("receipt", {})
                if receipt.get("requestId") == request_id:
                    if receipt.get("inputHash") != fingerprint:
                        raise ReviewError("Request ID was already used for different inputs.")
                    if receipt.get("outcome") != "saved":
                        raise ReviewError("This request failed definitively. Read fresh state and submit reconciled inputs with a new request ID.")
                    return {"requestId": request_id, "savedVersion": receipt["savedVersion"], "replayed": True,
                            "url": review_url(session, receipt["savedVersion"]),
                            "openUrl": review_url(session, receipt["savedVersion"], workspace=True), "refreshRequired": True}
            try:
                expected = value.get("expectedVersion")
                if type(expected) is not int or expected != history["review"]["version"]:
                    raise ReviewError("Version conflict: read fresh state and reconcile before applying.")
                if value.get("privacyEpoch", session.get("privacyEpoch", 0)) != session.get("privacyEpoch", 0):
                    raise ReviewError("Edited state predates a privacy cleanup; read fresh sanitized state.")
                state = prepare_state(value, history["review"], args.approve)
            except ReviewError:
                record_failure(root, request_id, fingerprint, request_text, snapshot(history["review"]))
                raise
            pending = {"requestId": request_id, "inputHash": fingerprint, "request": request_text, "kind": "edit", "createdAt": stamp(),
                       "directory": next_directory(root).name, "before": snapshot(history["review"]),
                       "body": {**state, "expectedVersion": expected, "requestId": request_id, "note": request_text}}
            session["pending"] = pending
            save(root / "session.json", session)
        directory = root / pending["directory"]
        try:
            response = client.call("POST", f"/api/reviews/{parse.quote(session['reviewId'], safe='')}/revisions", pending["body"])
        except ReviewError as exc:
            write_snapshot(directory, pending["before"])
            atomic(directory / "request.md", request_text)
            atomic(directory / "changes.diff", "No insight changes; save failed or its outcome is not yet confirmed.\n")
            definitive = exc.http_status is not None and 400 <= exc.http_status < 500
            save(directory / "receipt.json", {"requestId": request_id, "inputHash": fingerprint, "outcome": "failed" if definitive else "unconfirmed", "kind": "edit", "createdAt": pending["createdAt"], "hashes": file_hashes(directory)})
            if definitive:
                session.pop("pending", None)
                save(root / "session.json", session)
            raise
        return finish_entry(root, session, pending, response)


def refresh_backups(session):
    failures = []
    for index, destination in enumerate(session.get("backups", []), 1):
        temporary = None
        try:
            source = safe_path(session["database"])
            target = outside_git(destination)
            if not source.is_file() or not target.parent.is_dir() or any(Path(str(target) + suffix).exists() for suffix in ("-wal", "-shm", "-journal")):
                raise OSError("Unavailable database or active backup")
            # SQLite locking is unreliable on shared/NFS scratch. Build the
            # consistent database on node-local scratch, then publish bytes.
            fd, temporary = tempfile.mkstemp(prefix="oxygen-review-backup-")
            os.close(fd)
            with closing(sqlite3.connect(source.as_uri() + "?mode=ro", uri=True)) as database, closing(sqlite3.connect(temporary)) as backup:
                database.backup(backup)
            atomic(target, Path(temporary).read_bytes())
        except (OSError, sqlite3.Error, ReviewError):
            failures.append({"backupIndex": index, "status": "not_refreshed"})
        finally:
            if temporary and os.path.exists(temporary):
                os.unlink(temporary)
    return failures


def baseline_state(state):
    """Retain content fields, never hidden source identities or embedded originals."""
    def select(value, keys):
        return {key: copy.deepcopy(value[key]) for key in keys if key in value}
    return {
        "trajectorySummary": select(state["trajectorySummary"], ("text",)),
        "summaryGroups": [select(group, ("id", "text", "lineIds")) for group in state["summaryGroups"]],
        "summaryLines": [select(line, ("id", "text", "ending", "kind")) for line in state["summaryLines"]],
        "insights": [select(card, ("id", "authorship", "title", "presentKeys", "text", "type", "appliesWhen", "scope", "takeaway", "description", "workflow", "example", "why", "evidence", "status")) for card in state["insights"]],
        "status": state["status"],
    }


def privacy_operation(value):
    try:
        parsed = uuid.UUID(value)
        if parsed.version != 4 or str(parsed) != value.lower():
            raise ValueError()
    except (ValueError, AttributeError, TypeError):
        raise ReviewError("Privacy requires --request-id with a random UUID (uuid4), reused for retries.") from None
    return str(parsed)


def reset_url(session, review_id, *, workspace=False):
    parts = parse.urlsplit(session["server"] if workspace else session.get("browserUrl") or session["server"])
    # Run filters, selected source IDs and old links are deliberately discarded.
    return parse.urlunsplit((parts.scheme, parts.netloc, "/", parse.urlencode({"review": review_id, "changes": 0}), ""))


def remove_archive(root):
    """Delete only the explicitly managed archive, under its writer lock."""
    if not root.exists():
        return
    with locked(root):
        for child in root.iterdir():
            if child.name == ".operation-lock":
                continue
            if child.is_dir():
                shutil.rmtree(child)
            else:
                child.unlink()
    root.rmdir()


def reset_privacy(args):
    if args.history_file is not None:
        raise ReviewError("--history-file is no longer supported. Read fresh state, sanitize its state and labels.projectName, and use --state-file; privacy now discards earlier history.")
    if args.state_file is None:
        raise ReviewError("Privacy requires --state-file with the sanitized current-state bundle.")
    value = load(args.state_file)
    # The request is an authorization input only; never persist it or its hash.
    try:
        Path(args.request_file).read_text(encoding="utf-8")
    except OSError:
        raise ReviewError("Cannot read privacy request file.") from None
    request_id = privacy_operation(args.request_id)
    root = outside_git(args.archive)
    client = Client(value["server"])
    clean = baseline_state(value["state"])
    project = value.get("labels", {}).get("projectName")
    if not isinstance(project, str) or not project.strip():
        raise ReviewError("Provide the sanitized labels.projectName in the state bundle.")
    fingerprint = digest({"state": clean, "projectName": project, "approvedInsightIds": args.approve})
    # This operation directory contains only a clean staged baseline, never a
    # copy of old history or a mapping from old to new review identities.
    operation_root = root.parent / (".privacy-" + request_id)
    stage = operation_root / "baseline"
    completed = False
    result = None
    with locked(operation_root, create=True):
        try:
            response = client.call("GET", f"/api/reviews/privacy-operations/{request_id}")
        except ReviewError as exc:
            if exc.http_status != 404:
                raise
            response = None
        if response is None:
            with locked(root):
                session = load(root / "session.json")
                if session.get("pending"):
                    raise ReviewError("Resolve the unfinished edit before resetting history.")
                if session.get("cleanupPending") or stage.exists():
                    raise ReviewError("The saved baseline is no longer available; a later reset may have replaced it. Do not restore this earlier state.")
                if value.get("reviewId") != session["reviewId"] or value.get("server") != session["server"]:
                    raise ReviewError("Edited state belongs to another review or server.")
                previous_pending = session.get("pendingPrivacy")
                if previous_pending and previous_pending != {"requestId": request_id, "inputHash": fingerprint}:
                    raise ReviewError("Finish the pending privacy reset with the same inputs and operation UUID.")
                history = client.history(session["reviewId"])
                context(session, history)
                if value.get("expectedVersion") != history["review"]["version"]:
                    raise ReviewError("Version conflict: read fresh state before resetting history.")
                prepared = baseline_state(prepare_state(value, history["review"], args.approve))
                session["pendingPrivacy"] = {"requestId": request_id, "inputHash": fingerprint}
                save(root / "session.json", session)
                try:
                    response = client.call("POST", f"/api/reviews/{parse.quote(session['reviewId'], safe='')}/privacy",
                        {"expectedVersion": value["expectedVersion"], "requestId": request_id,
                         "state": prepared, "projectName": project, "approvedInsightIds": args.approve})
                except ReviewError as exc:
                    if exc.http_status is not None and 400 <= exc.http_status < 500:
                        session.pop("pendingPrivacy", None)
                        save(root / "session.json", session)
                    raise
        current = response["review"]
        if not re.fullmatch(r"review-[0-9a-f-]{36}", current.get("id", "")) or response.get("savedVersion") != 0 or current.get("version") != 0:
            raise ReviewError("Invalid baseline response; preserve sanitized inputs and retry the operation UUID.")
        destination = root.parent / current["id"]
        if destination.exists():
            with locked(destination):
                fresh = load(destination / "session.json")
                if fresh.get("resetOperation") != {"requestId": request_id, "inputHash": fingerprint}:
                    raise ReviewError("Destination belongs to different baseline inputs.")
        else:
            if stage.exists():
                fresh = load(stage / "session.json")
                if fresh.get("resetOperation") != {"requestId": request_id, "inputHash": fingerprint}:
                    raise ReviewError("Recovery inputs differ from the staged baseline.")
            else:
                session = load(root / "session.json")
                if session.get("pendingPrivacy") != {"requestId": request_id, "inputHash": fingerprint}:
                    raise ReviewError("Operation does not belong to this archive or its sanitized inputs.")
                fresh = {"schemaVersion": 1, "reviewId": current["id"], "server": session["server"],
                         "browserUrl": reset_url(session, current["id"]), "createdAt": stamp(),
                         "lastVersion": 0, "privacyEpoch": 0, "database": session.get("database"),
                         "backups": session.get("backups", []), "cleanupPending": True,
                         "resetOperation": {"requestId": request_id, "inputHash": fingerprint}}
                save(stage / "session.json", fresh)
            # Recreate a partially written clean snapshot from the server result.
            write_snapshot(stage / "0000-initial", snapshot(current))
            remove_archive(root)
            os.rename(stage, destination)
        # A crash after publishing but before removing an older directory must
        # never leave a second archive that could reveal editing history.
        if root != destination:
            remove_archive(root)
        with locked(destination):
            # Preserve metadata from ordinary edits that completed during recovery.
            fresh = load(destination / "session.json")
            if fresh.get("resetOperation") != {"requestId": request_id, "inputHash": fingerprint}:
                raise ReviewError("The baseline changed during recovery; do not restore earlier content.")
            failures = refresh_backups(fresh)
            fresh["cleanupPending"] = bool(failures)
            save(destination / "session.json", fresh)
        completed = not failures
        result = {"requestId": request_id, "reviewId": current["id"], "savedVersion": 0,
                  "archive": str(destination), "url": reset_url(fresh, current["id"]),
                  "openUrl": reset_url(fresh, current["id"], workspace=True),
                  "replayed": response.get("replayed", False), "outcome": "saved" if completed else "incomplete",
                  "backupFailures": failures, "refreshRequired": completed,
                  "privacyScope": "New initial baseline only in this review, its registered archive and successfully refreshed backups. External source runs, exports, infrastructure backups and chat history are outside this operation."}
    if completed:
        remove_archive(operation_root)
    return result


def privacy(args):
    try:
        return reset_privacy(args)
    finally:
        # Failed validation or a definitive server rejection has no clean staged
        # baseline to recover. Do not accumulate empty operation traces.
        if args.request_id and re.fullmatch(r"[0-9a-fA-F-]{36}", args.request_id):
            operation = outside_git(args.archive).parent / (".privacy-" + args.request_id.lower())
            if operation.exists() and not (operation / "baseline").exists():
                try:
                    remove_archive(operation)
                except (OSError, ReviewError):
                    pass  # An active operation owns its lock; leave it alone.


def parser():
    result = argparse.ArgumentParser(description=__doc__)
    sub = result.add_subparsers(dest="command", required=True)
    first = sub.add_parser("start", help="Capture initial state in a private archive outside Git")
    first.add_argument("--server", required=True)
    first.add_argument("--review", required=True)
    first.add_argument("--output", required=True, type=Path)
    first.add_argument("--browser-url", help="Optional client-facing URL; results also include openUrl using --server for workspace browser tools")
    first.add_argument("--database", type=Path, help="SQLite source for explicit registered backup refresh")
    first.add_argument("--backup", action="append", type=Path, default=[], help="Registered cold SQLite backup to replace after privacy cleanup; repeatable")
    second = sub.add_parser("read", help="Fetch fresh editable state; --history optionally includes editing history")
    second.add_argument("archive", type=Path)
    second.add_argument("--history", action="store_true")
    for name, help_text, input_flag in (("apply", "Save an edited state and verbatim user request", "--state-file"), ("privacy", "Discard earlier history and save sanitized current state as a new initial baseline", "--state-file")):
        command = sub.add_parser(name, help=help_text)
        command.add_argument("archive", type=Path)
        command.add_argument("--request-file", required=True, type=Path)
        command.add_argument(input_flag, required=name == "apply", type=Path)
        if name == "privacy":
            command.add_argument("--history-file", type=Path, help=argparse.SUPPRESS)
        command.add_argument("--request-id", required=name == "privacy", help="Stable retry ID; privacy requires a random UUID, ordinary edits default to an input hash")
        command.add_argument("--approve", action="append", default=[], metavar="I001", help="Explicitly approve this final card ID, including a changed/new card; repeatable")
    return result


def main(argv=None):
    args = parser().parse_args(argv)
    os.umask(0o077)
    try:
        result = {"start": start, "read": read, "apply": apply, "privacy": privacy}[args.command](args)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 1 if result.get("outcome") == "incomplete" else 0
    except (ReviewError, OSError, KeyError, TypeError, ValueError):
        exc = sys.exc_info()[1]
        print(str(exc) if isinstance(exc, ReviewError) else "Operation could not complete safely. Preserve inputs and retry with the same request ID; sensitive content omitted.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
