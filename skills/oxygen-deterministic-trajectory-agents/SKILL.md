---
name: oxygen-deterministic-trajectory-agents
description: Generate a readable thematic summary, label its lines with Python, and run fresh insight and privacy-redaction agents using fixed calls with one input path. Accepts extracted Markdown trajectories, frozen JSON/JSONL trajectories, or existing Markdown summaries. Controls invocation, not deterministic model prose.
---

# Summary and insight agents

Supply one extracted Markdown trajectory, frozen JSON/JSONL trajectory, or existing
Markdown summary. Prepare new workspace trajectories with the
[collection, stripping, and Markdown-export commands in the toolkit README](../../readme.md#1-collect-workspace-sessions).
Prefer the exported `.md` transcript for analysis. A Markdown input is frozen as
`source.md` and is the sole factual source; workers do not consult its source JSONL.

Current skill has four gates: initialization and acceptance of each worker's outputs.
The workers still interpret evidence and write prose. Python handles labeling,
card validation, stage order, and execution records. This pipeline produces Markdown.

## Fixed workers

Use `collaboration.spawn_agent` with `fork_turns="none"`, `model="gpt-6.1-sol"`,
and `reasoning_effort="high"`. Check host support before dispatch and use the
helper-generated arguments unchanged. Each stage gets a fresh worker.

Initialization saves the model settings, complete prompt templates, labeler, and
card parser in the run. Later stages use those saved versions. Repository edits or
changes to the original input do not invalidate an initialized run. The input path
selects the run; the generated task name and saved label-helper path derive from it.

Worker contracts define permitted inputs, outputs, and tools:

- [Summary worker](references/summary-worker.md): reads the frozen source and writes a neutral, readable account of the trajectory.
- [Insight worker](references/insight-worker.md): reads the frozen source and working copies of the accepted summary pair, may repair factual errors or meaningful omissions while preserving neutral narration, then relabels and infers reusable project skill candidates.
- [Redaction worker](references/redaction-worker.md): reads the accepted insight trio and writes privacy-edited outputs with new labels and citations.

Fresh context excludes parent history; host instructions, tools, workspace, and
sandbox still apply. Worker access restrictions are instructions, not a separate
sandbox. Fixed settings do not guarantee identical model prose.

## Four gates

| Gate | Required checks | Result |
|---|---|---|
| Initialize | Nonempty regular input that parses as JSON/JSONL or UTF-8 Markdown; new run destination. Live session storage must first be collected. | Freeze source, prompts, settings, and helpers. |
| Accept summary | Recorded worker completed successfully; readable summary is nonempty UTF-8. | Parent generates labels and records accepted output hashes. |
| Accept insight | Recorded worker completed successfully; final summary is nonempty UTF-8; labels reproduce it exactly; cards and citation targets are valid. | Accept the final unredacted trio. Empty insights are valid. |
| Accept redaction | Recorded worker completed successfully; redacted labels reproduce the summary exactly; retained cards and citation targets are valid. | Mark processing complete. Empty summary and insights are allowed. |

The prompts guide summary organization; exact headings are not acceptance gates.
Each insight card has sequential IDs and the six fields `Title`, `Type`, `Description`,
`Workflow`, `Example`, `Evidence`. Types `user-agent` and `agent` describe the
candidate's origin. Description briefly states what the skill does and when it applies,
following the skill-creator guidance supplied in the frozen card format. Workflow
proposes the abstract method. Example shows a recorded application through tasks,
roles, choices, and results understandable without the original project. Abstract
the setting without inventing actions or outcomes; partial or failed applications
can qualify when informative. Evidence supports the application and method's origin, not every generalized
recommendation. Description, Workflow, and Example support rich Markdown. Card and
field delimiters inside fences are literal content; unclosed fences are rejected.
An empty insight file is valid. Structural checks establish format and navigation;
usefulness and factual fidelity remain worker editorial responsibilities.

## Run one input

Run commands from this skill's directory. Replace INPUT and WORKER_ID with actual
values and pass paths as data or separate subprocess arguments.

1. Initialize: `python3 scripts/trajectory_agents.py prepare INPUT`.
2. For each stage in order (`summary`, `insight`, then optional `redaction`):
   - Run `python3 scripts/trajectory_agents.py STAGE-call INPUT`.
   - Pass the returned arguments unchanged to `collaboration.spawn_agent`.
   - Immediately record the returned ID:
     `python3 scripts/trajectory_agents.py record-worker INPUT --stage STAGE --worker-id WORKER_ID`.
   - Wait for that worker to terminate and inspect its final task result. Proceed
     only if it reports `{"status":"complete"}`. Tool termination by itself does
     not establish task success.
   - Accept:
     `python3 scripts/trajectory_agents.py accept-STAGE INPUT --worker-id WORKER_ID --worker-status complete`.
   - Advance only when acceptance succeeds.

The CLI's completion status is an attestation from the parent; Python cannot
query collaboration tools. The host tool log is authoritative for actual dispatch
and completion. The saved call records are provenance, not an acceptance gate.

For a Python host with asynchronous dispatch/wait adapters, the helper also exposes
`await orchestrate(INPUT, dispatch, wait, redact=True)`. This function implements
initialize/resume, dispatch, wait, accept, and advance in one loop. `dispatch(args)`
returns the actual worker ID. `wait(worker_id)` returns a dict with `status: complete`
only after successful termination and a successful task result. All other results
stop the item. These adapters must be supplied by the host; the standalone CLI has
no direct collaboration-tool connection. Use `redact=False` to stop after insights.

Only accepted redaction sets `run_complete: true`. Stopping after insight acceptance
completes the requested generation stages while overall privacy processing remains
incomplete. Neither value grants release approval.

## Recovery and duplicate prevention

Each stage can be issued once. A state-update lock prevents competing dispatch
claims. If dispatch was issued but the worker ID was not saved, reconcile the host
log and record the existing worker; never blindly spawn another worker.

On resuming an interrupted run, run
`python3 scripts/trajectory_agents.py verify-resume INPUT` once. It checks hashes of
the frozen source, saved protocol files, and accepted outputs. The Python
orchestrator does this automatically for existing runs. Normal stage transitions
check completion state without repeatedly validating earlier outputs or the
original input. Accepted outputs and saved protocol files must remain unchanged.

A stale `.operation-lock` requires reconciliation before removal. Worker errors or
invalid outputs stop that item and preserve its artifacts. Do not repair prose in
the parent or silently retry. Other batch items may continue.

## Import an accepted summary

To generate new insights from an earlier accepted first summary:

```bash
python3 scripts/trajectory_agents.py prepare-insight NEW_INPUT.jsonl --from-run PRIOR_INPUT.jsonl.oxygen-agents
python3 scripts/trajectory_agents.py insight-call NEW_INPUT.jsonl
```

Use a new input location with the prior input's extension. Import verifies the
prior frozen source and summary pair against their recorded hashes and checks
label correspondence. It supports summaries, records provenance, and
starts a new run using the current prompts. It does not import old insights or
redactions or run a summary worker. Continue with worker recording, waiting, and
acceptance as above. Report the summary as imported and insights as generated.

V7/v8 runs remain resumable with their frozen prompts and validators. V5/v6 runs
remain preserved; import their accepted summaries into a new run to continue.
Existing review cards and annotations keep their original schema and categories. Historical Gxxx/Lxxx review-app importers
need a separate adapter for the current format. This skill does not alter a
published review collection.

## Labeling and outputs

The labeler prefixes every physical line with `L001 `, `L002 `, etc., including
headings and blanks. It preserves original UTF-8 bytes, LF/CRLF endings, and final
unterminated lines. For standalone labeling:

```bash
python3 scripts/label_summary_lines.py summary.md summary_labeled.md
```

The destination must be new. Insight and redaction workers use the saved labeler
command in their generated prompts. Any summary edit requires regenerated labels
and rechecked citations. The insight stage owns its working summary copy; the
accepted first summary remains an audit artifact.

Runs are stored at INPUT.oxygen-agents/ and contain:

- `summary/summary.md` and `summary/summary_labeled.md`;
- `insight/summary.md`, `insight/summary_labeled.md`, and `insight/insight.md`;
- after redaction, `redaction/summary_redacted.md`, `redaction/summary_redacted_labeled.md`, and `redaction/insight_redacted.md`;
- the frozen `source.md` for Markdown inputs (transcript or summary), or
  `trajectory.json` for JSON/JSONL inputs; `protocol/` snapshots, call records,
  and `manifest.json`.

Directories use 0700; generated and accepted files use 0600. Report counts and paths
without private prose. Only redaction-stage files have undergone privacy editing.
Original-contributor review is required before release; structural acceptance does
not establish factual fidelity or privacy completeness.

For batches, canonicalize, deduplicate, and sort paths. Use three active workers by
default, or the user's limit capped at host capacity. Record requested and effective
limits locally. Dispatch eligible items in path order; stages within each item
remain sequential. Keep host settings and the initialization configuration
consistent across the batch.
