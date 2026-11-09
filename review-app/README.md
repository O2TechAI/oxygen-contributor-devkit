# Oxygen Review

Oxygen Review is the contributor approval surface for readable Summary and
Insight artifacts with Python-generated evidence labels. Historical grouped
reviews remain readable and editable.

## Contributor invitation

Visit the [Oxygen homepage](https://oxygen.o2tech.ai/) for the contribution story
and ways to participate. Review help links there in a new tab, opens on first
use and can be reopened with **Review help**. Dismissing it is remembered in
this browser. The header shows `3/3 reviewed` beside **Complete**; accepted and
declined cards both count. This is review progress, not an evaluation score.
The **More review actions (⋯)** menu contains import, export, the trajectory list,
help, page information, and sign out. **Changes** and **Complete** remain visible.
**Page information** contains the source, protocol, stage, verification, and model
details. The privacy label remains visible in the header. Card prose is shown
without a nested gray box. These prompts do not collect questionnaire responses.
See the [story and scope](../docs/contributor-story.md) for the Zihan / Zidi handoffs.

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

### Review one card at a time

The review page opens in a one-card layout. It shows the current Insight with the
text of each cited Summary line directly beneath it, so a decision does not need
scrolling through the full Summary. Accepting or declining moves to the next card of
this review that still needs a decision; it never jumps to another trajectory. The two
buttons beside the progress count switch to the side-by-side Summary and cards layout;
the choice is remembered in this browser. Clicking an evidence label opens that line in
the side-by-side layout.

A trajectory is one agent session, named by when the session started and the agent's
own title for it (the Codex thread name or Claude Code session title; otherwise the
Summary's first specific heading, then the first request). The sidebar on the left
lists every trajectory oldest first with its status; open any of them without finishing
the current one. A session processed by several runs lists each run beneath it. The
sidebar button in the header hides it (a slide-over on narrow screens).

Each trajectory has a **Redacted** and an **Unredacted** version, switched in the
header; the page opens the redacted one. The first edit of an unredacted version asks
for confirmation, because its text has not been through privacy redaction; it can still
be completed and submitted. After **Complete**, the page offers the next unfinished
trajectory (the next in time by default, any other from the list) or to stay.
Without the local service, trajectories are named from their Summary and run.

Keyboard shortcuts work in the one-card layout unless a dialog or text field has
focus: `A` accept, `D` decline, `E` edit, `J` or the right arrow for the next card,
`K` or the left arrow for the previous card. Nothing is accepted in bulk.

### Ask or edit with your own agent

A bar at the bottom of the review page talks to the Codex or Claude Code already
installed and signed in on this computer. **Ask** answers questions about the review.
**Edit** revises the selected card, or any cards when the scope is "Whole review", and
can add a new card. Edit is available for skill-candidate (v9) reviews. Edited and added cards go
back to Pending, appear in **Changes** with the request, and can be undone from the bar.
Every request is saved in the review's history as its own version: an edit with the full
request and the agent's explanation, a question (or an edit that changed nothing) with the
answer and unchanged content.

**Privacy requests.** In Edit, a request to remove, anonymize, mask or redact information
(a name, identifier, path, credential…) applies to the whole review, including Summary
headings and the project name, whatever card is selected. The page then warns before
saving: the cleaned review replaces the current one under a new address, **every earlier
saved version is deleted** (including earlier requests and agent answers), and the cleaned
version becomes the new starting version 0. The request text itself is not saved. Changed
cards go back to Pending. The review keeps its place among the trajectories; import hashes
are dropped, so it can be completed without them. Not covered: the trajectory's other
version, earlier submissions or exports, and the run's files on this computer.
Choose the agent, model and reasoning effort beside the input; the lists come from the
installed CLI. Press `/` to focus the input and Enter to send.

The page does not run the agents itself. A small bridge on this computer does, using
your own CLI login:

```bash
export OXYGEN_AGENT_BRIDGE_TOKEN="$(openssl rand -hex 24)"
npm run agent-bridge          # terminal 1: listens on 127.0.0.1:3777
npm run dev:node              # terminal 2: same token in its environment
```

The bridge accepts only loopback requests that carry the token, refuses browser
requests, runs at most two requests at once and stores nothing. The review app calls
it from its server, so the token never reaches the browser. Set
`OXYGEN_AGENT_BRIDGE_URL` or `OXYGEN_AGENT_BRIDGE_PORT` to use another port, and
`OXYGEN_CODEX_BIN` or `OXYGEN_CLAUDE_BIN` for a CLI outside `PATH`. Without the token the
bar says the connection is off. A request sends the review's Summary lines and cards, and
your message, to the provider you choose.

### Add a missing insight

Choose **Add insight**, paste one Markdown card, **Preview card**, add it, decide,
and wait for automatic saving. Reviewer-added cards remain editable in the same Markdown input.
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

Review names include the trajectory number, summary title, unredacted/redacted
version, and run identifier. This distinguishes different trajectories and reruns
even when they share a project name such as `example-project`.

## Run locally

Node.js 22.13 or newer is required.

On Windows PowerShell, run `.\oxygen.ps1` from the toolkit root. Set `OXYGEN_NODE`
to a Node.js executable if the default Node is older than 22.13. The launcher tries
`python` before `python3` on Windows and passes the selected interpreter to the
bridge. `OXYGEN_PYTHON` overrides detection.

Session snapshots on Windows retain the destination directory's inherited ACLs.
POSIX 0600/0700 mode bits do not verify Windows access control. Workers preserve
those ACLs instead of attempting chmod, ownership or ACL changes. Choose a run
storage directory whose ACLs provide the access you intend. Reparse-point sources
are rejected on the opened file handle; frozen-prefix hash and metadata checks
remain enabled on both platforms.


```bash
npm ci
npm run db:local:init
npm run dev -- --hostname 127.0.0.1 --port 3000
```

Open `http://127.0.0.1:3000`. Local development uses an isolated project-local
D1 database through Miniflare. The bundled v9 skill-candidate example is inserted on first
database access; existing imports and older examples are preserved. For the complete collection,
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

Choose **Apply edit** and wait for **Saved automatically** before
closing or refreshing the browser. Reopening loads the latest saved content,
decisions, and deletions from the database. Unsaved edits and checkbox selections
are browser-session state. Export bundles are outputs, not database backups or
editable-session import files.

## Saved versions

Browser and agent saves check the version they started from. A conflict keeps
the browser draft available for reconciliation instead of overwriting newer
work. Privacy requests replace the review with a new identity and a single
initial baseline. Earlier originals, revisions, requests, diffs, and import
hashes are discarded; the page opens the new initial state. Ordinary edits and
deletions preserve history.

## Publish a completed run

Runs started from the Projects page are imported when you open a finished
trajectory. A prepared run JSON payload (such as `trajectory-001-redaction.json`
from a completed run's `review-imports` directory) can be posted to the app by the
publisher; the app checks the manifest hashes, fields, and citations and creates
a separate review. Existing reviews and annotations are preserved.

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
Use `--stage humanize` for **Unredacted insights and summary**: humanized cards
and their unchanged supporting summary. Use `--stage redaction` for **Redacted
insights and summary**. `--stage insight` remains an explicit import of an earlier
extraction draft; it is excluded from default navigation and the default version
filter. Its direct review link and **Earlier extraction drafts** filter remain
available. Neither humanized nor extraction drafts can be marked complete.

An accepted Humanizer comparison derived from a saved review can also be loaded:

```bash
python3 ../tools/publish-review.py \
  --project my-project \
  --source run-example-trajectory-001-humanized \
  --humanize-comparison ../runs/humanizer-comparison/single-01
```

This creates a separate draft with pending decisions. The publisher verifies the
comparison's frozen inputs and accepted output. The app verifies the draft files
and citations and preserves reviewer authorship. Page information identifies the
saved-review origin; exports do not claim verified original extraction provenance.
The source review and privacy-reset history remain untouched.

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
  save creates a revision snapshot. Explicit privacy cleanup replaces stored history with a new initial baseline.
- The cross **declines** an Insight (`rejected` in the saved data), retaining
  the card and its edits. Trash **deletes** the card from the current review
  after confirmation. Deleted cards are excluded from exports, including their
  original and revision content; stored originals and history remain preserved.
  The opt-in edit-history export is the exception: its earlier versions still
  contain cards that were deleted later.
- Completion requires an accepted or rejected decision for every Insight, in
  either version of a trajectory. Empty Insight output is valid.

After editing, choose **Apply edit**; decisions, applied edits, and deletions save
automatically after a short pause. Failed saves retain local changes and show
**Retry autosave**; submitting and switching reviews wait for a successful save.
Closing or refreshing with a pending save shows a browser warning. Unapplied
editor drafts are not autosaved.

**Submit…** beside **Complete** is the one way to hand work in; it becomes
available once the open review is completed, and opens by itself after the last
trajectory (or a global insights review) is completed. It lists every trajectory
with its completed versions, checked by default (the redacted version when both
were completed), plus completed global insights reviews. When the trajectories a
global review was generated from are unchanged, the panel says the global insights
are complete and nothing needs to be generated again. Submitting freezes the
selection (see **Submit trajectories** below) and opens the submission, where the
contribution package is downloaded and cross-session insights are generated.
The ⋯ menu keeps only the review guide, page information and sign-out.

For scripts, `POST /api/reviews/export` accepts `reviewIds`, optional `format`
(`zip` or `json`, default `json`), and optional `includeHistory` (`true` or
`false`, default `false`); a single review downloads from
`GET /api/reviews/<id>/export`, with `?history=1` to include its history.
Pending insights export as accepted by default; their saved labels and the
review's completion state remain unchanged.

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
embedded JSON record of the latest saved content only. Without the history
option, internal originals and revision history remain stored for the review app
and are not exported.

### Edit history export

**Include edit history and agent requests** in the Submit panel (on by default)
adds two files per review under the submission's `history/` folder, and
`?history=1` adds them to a single-review export; the latest-content files above
are unchanged:

- `history.json` (`oxygen-review-history/v1`): every saved version, oldest first.
  Version 0 is the imported original (or the sanitized baseline after privacy
  cleanup). Each later version is one save: browser decisions and edits, or an
  agent request. Each snapshot has `version`, `kind` (`initial`, `edit`,
  or `privacy`), `createdAt`, `note` (for agent requests, the exact request),
  optional `requestId`, and the complete `state`: summary, summary lines, and
  insight cards with their statuses. Embedded `originalText` fields are omitted.
- `history.md`: the same versions as a readable timeline, with each note quoted
  and a diff against the previous version.

The collection JSON adds `historyIncluded: true` and per-review `historyVersions`;
filenames include `with-history`. History can contain request text, deleted cards,
and every pre-redaction edit, so treat these downloads as private research data,
not contribution exports. Explicit privacy cleanup still discards earlier history
first.

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

Trajectories come from runs on the Projects page or from the publisher. Generated
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

## Review global insights

After individual reviews are finished, submit them and choose **Generate
cross-session insights** on the submission; the result opens as a separate
**Global review** (a `cross_session_insights.json` from the skill run by hand can
be posted to `POST /api/reviews` as a `global` payload). Once it is completed,
**Submit…** includes it with the trajectories. The page shows all supplied source
summaries, clickable qualified evidence such as `S002:L003`, and new pending
cards. Edit, accept or decline, inspect **Saved changes**, and complete this
second review. Reloading restores the saved global review and revisions.

The importer checks card structure, citation targets, and support from at least
two distinct trajectory identities. It does not authenticate the supplied JSON
or certify its privacy. Global completion records editorial review, not privacy
approval. The import never edits individual reviews. Local line IDs are used
for editing and Markdown export; `sourceId` preserves qualified source citations
and original candidate IDs in the JSON snapshot, alongside the source catalog.
Global snapshots are second-stage outputs, not new individual extraction inputs.
Importing a file does not start model calls; generation runs from **Submit** (below)
or as a separate agent workflow.

## Submit trajectories and generate cross-session insights

**Submit…** on the review page and the **Submit** page (`/submit`) show the same list:
every trajectory by project, named by session. Under each
are the completed versions (redacted or unredacted, from each run that processed the
session); only one may be checked. Every completed trajectory is checked by default,
preferring its redacted version; unredacted versions are marked and the form
warns about them. Completed global insights reviews are listed below and checked too. Trajectories with nothing completed are greyed out with the reason
(cards still open, not completed) and a link to finish them. Runs of one session are
matched by session ID or verified input hash.

Submitting saves a frozen copy on this computer and nothing is uploaded:

```
OXYGEN_HOME/submissions/<id>/
  submission.json        the submitted reviews, decision counts, suggested worker
  export/                manifest.json + one folder per review, the cross-session input
  history/<review>/      history.json and history.md, if you kept the box checked
  global/<review>/       completed global insights reviews, if checked (not read as trajectories)
  generations/<job>/     one folder per generation attempt (config, state, run, logs)
```

The server checks the selection again and refuses it if a review changed after the page
loaded. Edit history (with the requests you typed to the agent) is kept apart from
`export/` and never sent to a model; uncheck **Include edit history and agent requests**
to leave it out. **Download contribution package** zips the frozen files. Later edits do
not change a submission; the page says which reviews changed and offers to submit again.

**Generate cross-session insights** needs at least two different trajectories. Choose the
agent, model and reasoning effort (suggested from the runs the trajectories came from);
the summaries and cards of the submitted trajectories (never `global/` or `history/`)
are sent to that provider through your own login. The
service runs `tools/oxygen_run.py cross-session`, which drives the skill's `prepare →
call → record-worker → accept` steps for the synthesis and readability stages with
headless workers, at most three hours each. Runs and generations together are limited to
two at a time. When it finishes, the result is imported as a Global insights review (once,
however many pages are open) and a banner offers to open it. A failed or stopped attempt
keeps its folder; **Generate again** starts a new one.

## Projects, runs and the local service

`./oxygen` (from the toolkit root) or `npm run oxygen` starts two processes on
`127.0.0.1`: this app and a local service (`bridge/agent-bridge.ts`). The service is the
only part that touches your agent sessions and your Codex / Claude Code installation; the
app reaches it with a random per-start token, so the browser never sees the token.

| Page | Address | What it does |
| --- | --- | --- |
| Projects | `/` | Projects with recorded sessions, recent runs, and a shortcut to the next card waiting for review. |
| New run | `/runs/new?workspace=PATH` | Choose sessions, language, agent, model and reasoning effort. |
| Run | `/runs?id=RUN` | Per-session progress with stage timings. **Review** imports the finished session and opens it. |
| Review | `/review?review=ID` | One card at a time with a Summary tab, the full side-by-side layout and the agent composer. |
| Submit | `/submit` | Choose labeled trajectories to hand in. |
| Submissions | `/submissions?id=ID` | A frozen submission: download it, generate cross-session insights, open the result. |

Links of the form `/?review=ID` from earlier versions still open the review.

How a run works: the service starts `tools/oxygen_run.py`, which copies only the selected
sessions into `OXYGEN_HOME/runs/<id>/`, converts them to Markdown transcripts, and runs the
four worker stages for each one (three at a time) through the same `orchestrate` function
and acceptance checks as the agent-driven pipeline. Progress is written to the run's
`state.json`. Stopping a run ends its worker processes; sessions already finished stay
reviewable. A run whose process disappeared is shown as stopped.

Workers are headless `codex exec` (workspace-write sandbox, no network) or `claude -p`
processes started with your own login. Claude Code has no operating-system sandbox here,
so its shell access is limited to reading helpers and the run's own label script; it cannot
run arbitrary commands.

| Variable | Default | Purpose |
| --- | --- | --- |
| `OXYGEN_HOME` | `~/.oxygen` | Runs (`runs/`), submissions (`submissions/`) and the review database (`reviews.sqlite`). |
| `OXYGEN_PORT` | `3000` | Port of this app (the next free port is used if busy). |
| `OXYGEN_CODEX_HOME` | `$CODEX_HOME` or `~/.codex` | Where Codex sessions are read from. |
| `OXYGEN_CLAUDE_CONFIG_DIR` | `$CLAUDE_CONFIG_DIR` or `~/.claude` | Where Claude Code sessions are read from. |
| `OXYGEN_CODEX_BIN`, `OXYGEN_CLAUDE_BIN` | `codex`, `claude` | The command-line tools to run. |
| `OXYGEN_PYTHON` | `python3` | Python 3.10+ used for the runner. |

Set `OXYGEN_REVIEW_USERNAME` and `OXYGEN_REVIEW_PASSWORD` before starting to require a
login. The services never listen on a public interface.
