---
name: oxygen-assisted-review
description: Edit Oxygen review insights from conversational requests, save each request and resulting snapshot, and show changes in the review page. Use for agent-assisted review, including explicit privacy cleanup of saved review history.
---

# Assisted insight review

Use the current Oxygen review as the editable source. Apply clear requests
directly: rewriting, additions, removals, ordering, decisions, or comments.
Keep human readability the editorial priority. Ask only to resolve an ambiguous
target, instruction, privacy scope, or conflicting edit. No extraction worker or
routine approval step is needed.

## Read, edit, and show

1. Resolve the browser's `review` and `insight` query parameters against the
   saved review. If a card is not identified, use the user's title or description;
   ask when more than one target fits. Distinguish original and redacted reviews.
   Resolve the actual API address from the local server metadata: a browser's
   forwarded port may differ from the server port. Confirm that the server's
   recorded host matches the current workspace host and that the service responds
   before opening it; reconnect or resume the existing service if necessary.
2. Use one private archive for this review outside Git, under the configured run
   storage, following the workspace's storage policy. Use repository-relative
   tool paths and caller-supplied data locations; do not embed a developer's home
   or cluster paths. File arguments may be relative to the working directory;
   the helper resolves saved archive and database locations so later commands
   can run from another directory. Temporary files use the system temporary
   directory (configurable with `TMPDIR`); choose local storage for SQLite work.
   Initialize
   it once with `python3 scripts/review.py start --server URL --review ID
   --output ARCHIVE --browser-url BROWSER_URL`. Reuse the archive thereafter.
   Register managed local SQLite backups with `--database SOURCE --backup COPY`
   when available; repeat `--backup` for additional managed copies. Coordinate
   active backup writers first: the helper replaces cold backup copies.
3. Run `python3 scripts/review.py read ARCHIVE` immediately before editing.
   Save its result to a private working JSON file and edit its `state`.
   **Ground insight edits and additions in the existing saved summary.** Check
   the revised claims, workflow, and examples against that summary; existing
   Evidence labels can remain unchanged. Include content unsupported by the
   summary only when the user explicitly requests that content. A general
   request to rewrite or improve readability does not authorize unsupported
   additions. Identify explicitly requested unsupported content as a reviewer
   addition, without presenting it as an observed historical application.
   Preserve unrelated content, origin types, citation targets, and recorded
   outcomes. User additions are reviewer-authored proposals; empty Evidence is
   preferable to invented historical support. Preserve all six fields. A style
   change alone does not change the method's origin type.
4. Save the user's exact review request in a private UTF-8 file. Run
   `python3 scripts/review.py apply ARCHIVE --request-file REQUEST
   --state-file STATE --request-id UNIQUE_ID`. Reuse that ID when reconciling an
   interrupted attempt. Changed and added cards become pending; use repeated
   `--approve I001` only for cards the user explicitly approves. Comment-only
   requests use unchanged state and still receive a snapshot. After a confirmed
   save, remove working request/state files created by this agent; the archive
   retains the request and saved state. Keep uncertain submissions recoverable.
5. After every confirmed save, **automatically refresh or open the review**
   using browser controls. For Codex `open_in_codex`, use the helper's `openUrl`
   (the workspace server address); Codex establishes browser forwarding. The
   separate `url` is for direct navigation in an existing client browser.
   Passing that browser's forwarded localhost port back to the workspace opener
   can produce a connection error. Keep the selected insight in the query.
   Check the workspace URL responds before opening it. Do this before finishing;
   returning a link alone is insufficient when those controls are available.
   Ordinary edits open the saved request's in-page Changes panel. Resolve any
   pending browser editor before reloading; preserve drafts on conflicts and
   reread the saved state before reapplying intent. Do not repeat a stale save.
   If browser controls are unavailable or fail, report that separately from
   the successful save and provide the reload link. A routine
   change-by-change chat report is unnecessary; surface failures or limitations.

The script's `--help` describes arguments and environment-based authentication.
Credentials do not belong in archives or command-line arguments. The helper's
snapshots preserve actual decisions; contribution exports are not snapshots.
The fixed layout is `session.json`, `0000-initial/{snapshot.json,insights.md}`, and
one numbered directory per request containing `request.md`, `snapshot.json`,
`insights.md`, `changes.diff`, and `receipt.json`.

## Explicit privacy cleanup

Use `privacy` only when the user explicitly asks to anonymize sensitive material,
stop retaining a request, or remove information from saved history. Examples:
“This name is sensitive; anonymize it throughout saved history,” “Don't retain
this request,” and “Remove this identifier from the original and all snapshots.”
An ordinary “delete this insight” is an edit with retained history. Clarify which
information to remove if a privacy request is ambiguous.

**Every explicit privacy-removal request discards the current review's entire
managed history.** Sanitizing earlier revisions is insufficient: the sanitized
result becomes a new `0000` baseline, with no earlier states or comparisons.
This reset is part of the privacy request and needs no routine reconfirmation.

1. Resolve pending browser edits first. Read `python3 scripts/review.py read
   ARCHIVE`; sanitize its `state` and `labels.projectName`. Check the current
   summary, insights, and identifying details. Preserve valid evidence labels,
   origin types, and reviewer authorship. Earlier states will be deleted, not
   individually rewritten. The input's convenience `review` copy is not saved.
2. Save the request and sanitized bundle in private temporary files. Generate a
   random UUID, then run `python3 scripts/review.py privacy ARCHIVE --request-file
   REQUEST --state-file STATE --request-id UUID`. Reuse that UUID and exact input
   for recovery. `--history-file` is obsolete. Explicit approvals can use repeated
   `--approve I001`; otherwise edited cards return to pending.
3. Check the result. The helper returns a new opaque review ID, archive path, and
   URL. Use that new archive for subsequent edits. Its only retained history is
   `0000-initial/{snapshot.json,insights.md}` plus `session.json`; the next ordinary
   request starts at `0001`. Earlier requests, notes, diffs, receipts, import
   hashes, source links, and historical metadata are removed. Minimal opaque
   retry identifiers refer only to the surviving baseline.
4. Finish any interrupted archive replacement or failed registered-backup refresh
   before reporting completion. Follow the returned new archive path when retrying
   an incomplete cleanup. Never restore an earlier baseline after a later reset.
   Remove agent-created temporary inputs after success, including convenience
   copies and the privacy request itself. Report caller-owned copies that remain.
5. **Automatically open or refresh the review** using the URL selection in
   step 5 above (`openUrl` for Codex). It shows the new initial
   state without a comparison to discarded history. Report browser-launch failure
   separately; do not imply that the page refreshed when only the save succeeded.

The app replaces both its original and current content and deletes its previous
revisions. Old review URLs and stale saves cannot write into the replacement.
Registered local backups are refreshed; coordinate active backup writers so they
cannot restore superseded copies. No privacy-event revision or old-to-new review
mapping is retained. A reset also removes original import verification receipts;
exports must not claim verified original provenance.

This covers the current review, its registered archive, and registered local
backups. Original extraction runs, separate exports, infrastructure snapshots,
and chat history are outside this operation. Selective cleanup is not a full
redaction pass or forensic disk erasure. Surface any managed copy that could not
be cleaned; do not preserve an unsanitized backup for recovery.

Keep the result as reviewed skill candidates. Generate installable skills only
when the user requests that next step.
