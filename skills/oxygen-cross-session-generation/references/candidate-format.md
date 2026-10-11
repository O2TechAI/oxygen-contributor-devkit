# Cross-session candidates v1

Use sequential `# C001`, `# C002`, … with exactly these six fields in order:
`Title`, `Type`, `Description`, `Workflow`, `Example`, `Evidence`.

## Field guidance

- **Title:** Name the recurring task at the scope where the procedure is useful.
- **Description:** Introduce the task, relevant environment and reason to use this
  workflow. Put settings and procedural detail in Workflow.
- **Workflow:** Connect concrete actions, settings, decisions and completion
  conditions. Preserve supported user defaults, task parameters and conditional
  exceptions, including stop conditions. Explain consequential choices; identify
  observed practices or proposed extensions without calling them user requirements.
- **Example:** Show distinct recorded applications under descriptive headings,
  keeping source IDs secondary. Establish enough context to understand the choice
  and outcome. Explain what each application contributes instead of repeating the
  full workflow. Preserve whether outcomes were observed, reported or unresolved.
- **Evidence:** Cite the frozen summary content supporting requirements and factual
  applications. Source references and provenance provide navigation, not explanation.

Write for a technical reader unfamiliar with the project. Use short paragraphs,
selective bold emphasis, steps for sequences and compact tables for alternatives
when helpful. There is no mandatory internal layout or step count. Keep important
qualifications beside their claims; put additional audit history in the sidecar or
synthesis report. Remove unnecessary reading while retaining necessary explanation.
When a procedure includes a calculation, define each symbol and condition where
the formula appears, and state what is transformed or averaged in which order.
Expand unfamiliar abbreviations on first use. A reader should be able to apply
the calculation without recovering its definitions from the source session.

## Worked demonstration

This example is adapted from recorded scheduling history. It demonstrates the
specificity and presentation to aim for, not a required topic. Its source IDs and
citations belong to the demonstration corpus; use only the current supplied corpus
for actual candidates, citations and provenance. The same campaign includes
distinct scheduling interventions, not demonstrated reuse across projects.

```markdown
# C001

Title: Submit CPU experiments using the user's smoke-test and queue rules
Type: user-agent
Description:

Run CPU-based API evaluations on the user's Slurm cluster while respecting the
agreed pilot scope, queue preferences and limits on duplicate work. Use this when
moving from a smoke test to a full evaluation or adapting an existing evaluation
to queue restrictions.

Workflow:

1. **Fix the authorized smoke scope.** Use the workload, partition and resource
   limits specified for that run. Check queue state and partition time limits
   before submission. The available history omits exact partition names and
   resource values; it does not establish a universal smoke partition.
2. **Check the smoke before expanding.** Validate result identities and expected
   coverage. Preserve completed results and resume missing work after a repair.
   Keep any instruction to stop for user review; in the recorded audit, the user
   separately authorized the full workload and changed its settings.
3. **Use the established full-run queue strategy.** The user directed future CPU
   work to queue all compatible partitions together. Keep the accepted workload
   separate from queue placement, and preserve running work the user excludes
   from changes. An alternate partition authorized for one session does not
   replace the global default.
4. **Choose the fallback that matches the constraint.**

   | Constraint | Recorded response |
   |---|---|
   | An authorized partition cannot share the compatible partition list | Separate queue entries share a `flock` guard and resumable output; cancel the unused entry once the other runs. |
   | The scheduler limits the number of submitted jobs | Keep the running job, cancel unstarted entries, and group remaining target/source pairs into fewer sequential jobs with a manifest. |

The shared lock protects concurrent execution; saved completion identities prevent
later invocations from repeating finished work. These are context-dependent
branches, not instructions to launch duplicate jobs for every evaluation.

Example:

**Repairing the smoke and expanding the audit (S002).** A pilot used one target per
dataset. Exact-ID validation rejected 35 decisions while preserving 344 completed
ones. The agent shortened judge-visible identifiers to `Q1`–`Q7` and resumed the
unresolved work; all smoke lanes were reported complete. The user then authorized
the full workload with two judges, two comparison histories and one randomized
presentation. Later queue changes established the compatible-partition default.
When the user requested an incompatible partition for one lane, two guarded
entries shared its resumable output; the unused entry was reported canceled, and
the other judge lane was left unchanged.

**Handling exceptions and a submission limit (S003).** In a separate scheduling
intervention, the user authorized alternate partitions first for one task and then
for the rest of the session, leaving the global default intact. The agent checked
time limits and reduced resource requests after rejection. A later saved-answer
rejudging wave hit a job-count limit: the agent kept the running rejudge and grouped
the remaining pairs into fewer sequential jobs. The record describes the
intervention, not completion of every pair.

Evidence: S002:L069, S002:L071, S002:L075, S002:L077, S002:L079, S003:L025, S003:L027, S003:L029
```

This supports a concrete queue procedure with a recorded smoke-to-full transition,
not a verified standing policy assigning one named partition to every smoke test
and another to every full run. Retain such exact choices when the actual corpus
supports them. Identify missing settings without recovering redacted values or
inventing parameters to make a demonstration look executable.

Description, Workflow, and Example support rich Markdown, including fenced code.
Card headings and field names inside fences are literal. Close every fence.
Title, Type and Evidence are single-line fields. Empty output is valid.

Type is exactly `user-agent` when user requests, corrections, feedback or
negotiation materially shaped the shared method; otherwise `agent` for agent
methods, discoveries, failures or recovery. Mixed origins use `user-agent` when
the user's contribution was material.

Evidence is a comma-separated list of unique qualified content-line references
resolving to frozen summaries. Distinct recorded applications in at least two
source trajectories must support every candidate; separate sessions in one project
qualify. Evidence supports user requirements and factual Example claims, not every
possible future use of a proposed Workflow. Proposed extensions remain identifiable
as proposals, and unsupported settings remain unspecified. Actual Examples cannot
include illustrative events that did not occur.

## Provenance sidecar

Save `candidate_provenance.json` alongside the Markdown:

```json
{
  "candidates": [
    {
      "id": "C001",
      "rationale": "Why these distinct applications support a useful personalized or detailed implementation workflow.",
      "sources": [
        {
          "sourceId": "S001",
          "cardIds": ["I002"],
          "application": "The specific recorded situation contributing support.",
          "declinedReuse": []
        },
        {
          "sourceId": "S002",
          "cardIds": ["I003"],
          "application": "A distinct situation and what it contributes.",
          "declinedReuse": [
            {"cardId": "I003", "difference": "How this materially improves the declined idea, without assuming its rejection reason."}
          ]
        }
      ]
    }
  ]
}
```

Use actual current IDs from the indexed cards, including every materially used
origin. `cardIds: []` is allowed for summary-only support. Provide one source
mapping per cited source, and one declinedReuse explanation per listed declined
card. The validator derives review IDs, original/current/accepted-export card IDs,
decisions, summary citations and null rejection reasons from the frozen corpus;
do not invent these in the sidecar. For no candidates use `{"candidates":[]}`.

The final JSON uses `oxygen-cross-session-candidates/v1`; all candidates have
`status: "draft"`. This format does not change source protocol v9 or imply review
approval. These artifacts are private candidates pending human review, not a
review-app import or installable skills.
