# Oxygen Review

Oxygen Review is the contributor approval surface for readable Summary and
Insight artifacts with Python-generated evidence labels. Historical grouped
reviews remain readable and editable.

## For reviewers: what is an insight?

Protocol v9 cards describe potential reusable skills worth developing for other
trajectories or projects. **Description** explains what the skill does and when to
use it, following the supplied skill-creator guidance. **Workflow** proposes the
abstract method. **Example** shows a recorded application through tasks, roles,
choices, and results understandable without the original project. **Evidence**
supports that application and the method's origin, not proof of
every generalized future application. **Title** reads like a skill name.

**Type** describes the candidate's origin: `user-agent` when requests, corrections,
feedback, or negotiation materially shaped it; `agent` when it comes from the
agent's methods, discoveries, failures, or recovery. Mixed cases use `user-agent`
when the user's contribution was material.

Accept recognizable, useful capabilities whose examples show how the method was
applied. Edit unnecessary discovery history, unclear descriptions, weak connections,
or inaccurate attribution. Reject generic,
redundant, misleading, or unsupported candidates. Preserve uncertainty and
separate proposed, attempted, reported, and observed outcomes in examples.

### Add a missing insight

Choose **Add insight**, paste one Markdown card, **Preview card**, add it, decide,
and **Save**. Reviewer-added cards remain editable in the same Markdown input.
**Copy chatbot prompt** and **Open prompt** select drafting guidance for the
active review's protocol. New reviews use the [skill-candidate prompt](public/reviewer-insight-prompt.md).

Reviewer-added v9 cards require Title, Type, Description, Workflow, and Example; Evidence is
optional. Cite valid content-line IDs from the current summary when supplied;
otherwise omit or leave Evidence blank. This does not permit invented facts.
Description, Workflow, and Example support Markdown paragraphs without mandatory bold lead-ins.

V8 reviews retain their five-field schema and [v8 drafting prompt](public/reviewer-insight-prompt-v8.md).
Older reviews retain Scope/Takeaway, original origin categories, and the
[historical drafting prompt](public/reviewer-insight-prompt-v7.md). Existing
annotations are not migrated or rewritten.

Review names include the trajectory number, summary title, original/redacted
version, and run identifier. This distinguishes different trajectories and reruns
even when they share a project name such as `example-project`.

## Run locally

Node.js 22.13 or newer is required.

```bash
npm ci
npm run db:local:init
npm run dev -- --hostname 127.0.0.1 --port 3000
```

Open `http://127.0.0.1:3000`. Local development uses an isolated project-local
D1 database through Miniflare. Bundled example reviews are inserted on first
database access; existing imports are preserved. For the complete collection,
generation, and local import workflow, use the [launch instruction](../readme.md#launch-the-complete-pipeline-from-codex).

### Local Node runtime

If the host cannot run Cloudflare's `workerd` (for example, because its glibc is
too old), launch the same app with:

```bash
npm run dev:node
```

Open `http://localhost:3000`. Choose another port with
`npm run dev:node -- --port 3001`. This serves the full review UI and API with
persistent SQLite storage at `.wrangler/node-local/reviews.sqlite`. The existing
migrations run automatically, and saving revisions uses database transactions.
It has its own database; Cloudflare/D1 reviews are not modified or automatically
copied. Import prepared run JSON files to populate it. Set `OXYGEN_REVIEW_DB` to
use another local SQLite path. The server binds to loopback; the existing optional
`OXYGEN_REVIEW_USERNAME` and `OXYGEN_REVIEW_PASSWORD` environment variables still
apply. The regular Cloudflare launch and deployment configuration is unchanged.

### Portable configuration and saved work

The checked-in app contains only synthetic example data. Import your own run
artifacts through the UI or the publisher; no workspace path or run is selected
in the source code. Local databases, environment files, generated trajectory
fixtures, and build output are ignored by Git.

- `OXYGEN_REVIEW_DB`: SQLite file to use with the Node runtime. Use a persistent
  location and the same file when restarting to resume saved reviews.
- `OXYGEN_REVIEW_USERNAME` and `OXYGEN_REVIEW_PASSWORD`: optional local login
  credentials, supplied together through the server environment.
- `OXYGEN_REVIEW_PUBLIC_URL`: optional public origin for page and sharing
  metadata, supplied in the build/server environment. No hosted origin is
  bundled with the app.

The Sites configuration leaves `project_id` unset while retaining the logical
`DB` binding. Configure your own project when deploying; local Node development
does not require a hosted project. The all-zero D1 ID in local configuration is
a placeholder, not a remote database identifier.

Choose **Apply edit**, then **Save**, and wait for the saved confirmation before
closing or refreshing the browser. Reopening loads the latest saved content,
decisions, and deletions from the database. Unsaved edits and checkbox selections
are browser-session state. Export bundles are outputs, not database backups or
editable-session import files.

## Publish a completed run

You can also choose **Import review** in the app and select a prepared run JSON
payload (such as `trajectory-001-redaction.json` from a completed run's
`review-imports` directory). The app shows the project, source, protocol, stage,
and card count after checking the manifest hashes, fields, and citations. Choose
**Import and open review** to create a separate review. Save any pending edits
before importing. Existing reviews and annotations are preserved.

This accepts the same payload as `POST /api/reviews`, including v9's Description,
Workflow, and Example. Preserve the `protocolVersion` recorded in the run
manifest; a prompt revision number is not a protocol version. Annotation export bundles have a
different envelope and are not run import files.

The default import target is a completed privacy-redaction stage:

```bash
python3 ../tools/publish-review.py \
  --project my-project \
  --source run-001 \
  --run-dir /absolute/path/to/input.jsonl.oxygen-agents
```

`--source` is required and must be a display-safe identifier, not a sensitive
local path.
Use `--stage insight` only for restricted unredacted review; such a review
cannot be marked complete.

The publisher verifies the selected files against `manifest.json`. The API
independently verifies matching manifest/payload protocol versions, stage completion, artifact hashes,
mechanical line labels, Insight boundaries, and substantive Evidence targets.
The artifact format is internally named `v5`; imports retain the run's actual
protocol version and are not restricted to protocol 5. V9, v8, and historical runs
use the same publishing command and API endpoints. V9 selects the six fields
`Title`, `Type`, `Description`, `Workflow`, `Example`, and `Evidence`; the three prose fields
support multiline Markdown, while title/type/evidence remain single-line.
The v9 parser validates field order, required values, origin labels, and citations.
Historical parsing remains available for existing schemas, including v7
Scope/Takeaway cards. The database stores these formats in its existing JSON columns.

## Review behavior

- The left pane renders the freeform Summary as GFM, including emphasis,
  numbered lists, task lists, inline code, tables, links, and separators, while
  retaining every physical `Lxxx` address.
- Card display, editing, preview, and export use the review's recorded protocol.
  V9 cards show Description, Workflow, then Example; v8 cards keep Description and Example; historical fields remain supported.
- Description, Workflow, Example, and historical Takeaway render paragraphs, emphasis, inline code, and line
  breaks. Raw HTML is disabled; links display as text within the clickable card.
- Evidence buttons select and reveal the corresponding Summary line.
- Editing cited Summary text reopens the affected cards. Deleting a line
  deterministically renumbers surviving lines, remaps citations, and reopens
  cards that lost evidence.
- Generated artifacts remain immutable in the original database columns. Every
  save creates an append-only revision snapshot.
- The cross **declines** an Insight (`rejected` in the saved data), retaining
  the card and its edits. Trash **deletes** the card from the current review
  after confirmation. Deleted cards are excluded from exports, including their
  original and revision content; stored originals and history remain preserved.
- Completion requires a redacted input and an accepted or rejected decision
  for every Insight. Empty Insight output is valid.

After editing, choose **Apply edit**, accept or decline the cards, then **Save**
and **Export**. Export is disabled while edits are unsaved or an editor is open.
Original/unredacted reviews and drafts can be exported without completing them.
Open **Trajectories** for one row per trajectory, with its original and redacted
versions, review status, and accepted/declined/pending counts. Search or filter by
run, version, and review status. On initial load, redacted versions from the
current run are selected by default, including unfinished reviews. Original
versions start unchecked and can be selected manually. Use **Select all filtered**, **Select all in
current run**, or individual checkboxes; **View selected** shows the full selection.
Selections remain checked while you open and edit individual reviews. Apply and
save edits before opening another review from the panel or exporting.
The version filter offers **All versions**, **Original**, and **Redacted**;
All versions includes only those two versions. The run filter lists individual
runs. **View selected** shows checked versions across runs and temporarily
disables the run filter; returning to the full list restores that filter.

**Export selected (N)** downloads a ZIP by default, organized by run, trajectory,
and review version, with `manifest.json` listing every included review and its
artifact directory. **Combined JSON** remains available. Every export contains
only the latest saved edited content. Original copies, previous revisions,
change notes, and trashed insights are excluded. The preview reports selected trajectories,
versions, and accepted/declined Insight counts, including pending insights in the
accepted total. Both single-review and bulk export warn when labeling is incomplete
and offer **Keep labeling** or **Export anyway**. Pending insights export as
accepted by default; their saved labels and the review's completion state remain
unchanged. Insights marked **Evidence changed** remain excluded until reviewed,
and the warning reports their count separately. Deleted insights stay excluded.

`POST /api/reviews/export` accepts `reviewIds` and optional `format` (`zip` or `json`,
default `json`). Historical export options from older clients are ignored;
exports always contain only the latest content. Open `?review=<id>&trajectories=1&run=<run-id>`
to show that run with its redacted versions selected immediately; this does not
reset any reviews. Reopening the panel preserves your checkbox choices, including
an explicitly cleared selection.

The export endpoint returns an `oxygen-human-review-bundle/v1` JSON document
whose `files` object contains:

- `summary.md` and `summary_labeled.md`: the saved edited Summary.
- `insight.md`: accepted cards (including pending cards accepted by default for
  export), numbered consecutively for downstream reuse.
- `insight_declined.md`: declined cards with their edited text and review IDs.
- `insight_reviewed.md`: current accepted, default-accepted, and declined cards,
  with its review ID. Join these IDs to the decisions in `approval.json`.
- `review.json`: only the latest saved structured content and its card statuses,
  with `exportScope: "latest"`. No original snapshots, revision snapshots, or
  embedded `originalText` fields are included. Decisions include `savedStatus`
  and `defaultAccepted`, distinguishing default acceptance from explicit labeling.
- `approval.json`: decisions, source/review/export ID mappings, provenance, and
  the latest review timestamp. Decisions include `savedStatus` and `defaultAccepted`;
  `exportLabeling` reports incomplete labeling and default acceptance counts.
  Declined cards have status `rejected` and no accepted export ID.

Combined bundles contain the same per-review files and accepted/declined counts.
Historical legacy-format Markdown exports include all card decisions and an
embedded JSON record of the latest saved content only. Internal originals and
revision history remain stored for the review app; they are never exported.

The built-in example is directly addressable at
`?review=rich-summary-insight-keys-example`.

## Legacy API

The historical `POST /api/reviews` pair format remains supported:

```json
{
  "projectName": "my-project",
  "sourcePath": "outputs/run-001",
  "summaryMarkdown": "# Trajectory summary\n\n...",
  "insightMarkdown": "# I001\nEvidence: L001\n\n..."
}
```

## Local trajectory reviews

Import project trajectories through **Import review** or the publisher. Generated
trajectory data stays in local run artifacts and the review database rather than
being bundled into the app. Existing database reviews and saved revisions remain
available, including previously imported protocol 7 examples.

### Recorded application examples (protocol v9)

Description briefly explains what the skill does and when it applies. Workflow
provides inferred reusable actions, decisions, and essential constraints. Example
abstracts an actual recorded application into understandable tasks, roles, choices,
and results. Preserve recorded actions and outcome status, keeping discovery
history only when it clarifies the application. Simplification must not add actions,
retrofit proposed steps into history, or invent success. Prefer successful cases;
informative partial or failed applications remain eligible.
Generalized Workflow recommendations need not all have been demonstrated in the
historical case. Evidence supports factual claims and the method's origin.
Rich Markdown is preserved through review and export. Existing reviews,
annotations, frozen prompts, and validators are not converted.
