# Insight categories and examples

Shared reference for selecting, writing, and reviewing reusable skill candidates from execution records. Read the category criteria before selection and consult the relevant demonstrations when drafting. The extraction prompt determines the required application evidence; these categories are non-exhaustive, with no category quota or length target.

All excerpts below are synthetic reference data. Their names, preferences, and local `Lxxx` evidence IDs do not describe the current task or user. Each demonstration independently starts at `I001`; never cite these examples as production evidence.

## Categories

Classify by the central reusable decision. Personalization can modify any category; use contextual personalization as the primary category when adapting behavior is the central contribution. Categories may overlap: a diagnostic procedure ending in verification can remain one coherent card. Category labels guide selection and assessment, not additional card fields. Preserve a substantive method outside this initial taxonomy when its evidence and scope qualify.

| Category | Required reusable contribution | Insufficient by itself |
| --- | --- | --- |
| Verification and review | Connect a claim or requirement to the necessary check and the conclusion or action its result permits. | Advice to verify work without identifying the evidence and its consequence. |
| Diagnosis and recovery | Connect a symptom to informative observations and a justified next investigation or correction; recovery may remain unresolved. | An error followed by a retry, with no supported reason for choosing that action. |
| Research and data workflows | Explain consequential evidence-selection, alignment, transformation, or interpretation choices and their assumptions. | A numerical result or advice to compare fairly without a comparison procedure. |
| Recurring operational workflows | Explain connected actions, dependencies, state transitions, handoffs, and completion conditions. | A chronological command list without consequential relationships between actions. |
| Scoped tool and domain knowledge | Identify a relevant contract or environmental constraint and explain how it changes the correct action. | An isolated tool fact without a behavioral consequence. |
| Contextual personalization | Preserve a user-endorsed behavior, its context, and supported defaults or exceptions, with a recorded application. | Treating an agent choice or a one-time instruction as a lasting user preference. |

`Type` describes origin: use `user-agent` when user input materially shaped the method, and `agent` when the discovery originated from the agent. A generic task request alone does not determine the type; an objective correction is not automatically personalization.

## Apply the criteria

1. **Locate the application.** Identify a recorded situation and the future task it could help with. A single-session candidate needs one actual application; cross-session extraction requires distinct applications across at least two trajectories. Separate sessions of one project qualify, while repeated accounts of one event or copied instructions do not establish recurrence.
2. **Identify the useful contribution.** Use the closest category to explain the consequential decision or connected procedure. A correction, implementation method, local contract, or established user requirement can supply value without surprise or universal applicability. Combine compatible branches without implying that every application executed the entire combined workflow.
3. **Choose the details that carry the method.** Retain settings, commands, limits, and checks when they change a reader's decision or make the central procedure usable. It is appropriate to omit secondary implementation detail and historical particulars. For the requirements you carry forward, distinguish enduring defaults, task parameters, temporary exceptions, and unresolved choices. Attribute user requirements, observed agent behavior, and proposed synthesis separately.
4. **Keep resources and evidence bounded.** Explain the role and known availability of recorded scripts, templates, or references; a reported filename does not establish its contents or present availability. Missing or redacted settings remain unavailable. Narrow unsupported claims and exclude candidates whose remaining content is merely generic advice.
5. **Review the card as working guidance.** First read it without source context: can a reader identify the task, follow the important decisions, and distinguish established choices from unresolved ones? Then verify recorded applications, attribution, settings, and outcome status against the supplied evidence. Failed or partial applications can qualify without invented success.

Use the demonstrations below for selection and presentation, not as a checklist of topics to generate. Keep the required six fields. Use categories to guide selection and review; neither extractor needs to output category bookkeeping.

## Readable cards

**Human understanding is the highest editorial priority.** These cards are for people, who should be able to follow the central idea on a first reading. Reduce information density even when that means retaining fewer details. A card need not preserve everything learned from the source or serve as a complete execution manual.

Lead with the main idea and explain why it matters before introducing mechanics. Give each paragraph or step one main job, and use connected sentences rather than packing several facts into clauses, parentheses, or table cells. More words can make a card easier to read when they provide explanation and breathing room; a lower word count is not the goal.

Select details by consequence: would omitting this change the central decision, erase a defining user requirement, or make the claim misleading? If not, omit it when it competes with understanding. Names, paths, counts, implementation variants, and audit history need not all appear. Retain the qualifications that make the selected claims accurate, including scope, exceptions, uncertainty, and outcome status. If the essential detail is still overwhelming, narrow the card's scope rather than compressing everything into it. Full source inspection and evidence obligations remain unchanged.

Teach the main path before considering additional branches. A useful secondary branch may be left out entirely; covering every supported variation is not a condition of a good card. When several methods or calculations compete for attention, choose the one central question the card will explain. Introduce its concepts in ordinary language before using their technical names. A sequence of correct inventories is still too dense, even when each inventory has a bold heading.

For example, this synthetic writing comparison shows how a longer explanation can ask less of the reader. It is style guidance, not a factual application or another candidate.

**Dense:** “Map source, stable-review, original/current and accepted-export IDs; account for filtering, renumbering, normalization and imported hashes before comparing snapshots.”

**Easier to follow:** “First establish that you are comparing the same card. An export may give it a new display number after other cards are filtered out, even though its text has not changed. Use its permanent identity to make the match.

“Then compare the saved text. Keep the full identifier map in the audit report, where a reviewer can inspect it if needed.”

The revision selects one decision and explains its reason. It leaves the wider export audit outside this passage instead of hiding it in a compressed list.

- **Description:** Orient the reader to one recognizable task and explain the benefit in plain language. Introduce only the context needed to understand it.
- **Workflow:** Explain the main path, why its key decisions matter, and how to recognize completion. Introduce an essential branch where it becomes relevant. Use steps or a small table only when they lower the reader's effort.
- **Example:** Choose the clearest recorded application, or distinct applications sufficient to show cross-session reuse. Give each a descriptive heading and a short account of the situation, consequential choice, and outcome. Additional episodes and technical history can stay in the source or existing supporting reports; the card need not retell every application.

Explain unfamiliar terms and necessary notation beside their use. Include a formula only when it helps the reader understand or apply the central method, with its direction and operations made clear. Keep qualifications near their claims and proposed recommendations distinct from recorded actions. Before checking evidence, read the card as a person new to the project: can they comfortably explain the main idea and follow its reasoning without unpacking a dense inventory? Revise until they can.

## Examples

### 1. Verification and review

Source:

```text
L001 User: Evaluate 200 assigned case IDs; report a full-run aggregate only when all have results.
L002 Tool: Job accepted. Agent: The evaluation is complete.
L003 User: Check the finished output against the assigned IDs.
L004 Tool: Job succeeded, but only 192 expected IDs have results; eight are missing.
L005 Agent: I listed the missing IDs and reported incomplete coverage without a full-run aggregate.
```

Expected card:

```markdown
# I001

Title: Check case coverage before declaring an evaluation complete
Type: user-agent
Description:

Check whether a batch evaluation covered its assigned cases before reporting completion or a full-run aggregate. A submitted or successfully finished job can still leave cases missing.

Workflow:

1. **Identify the required workload.** Use the assigned case manifest and the results from the matching run. Keep job submission, process termination, and case coverage as separate facts.
2. **Check coverage by ID.** Compare the returned case IDs with the manifest and list any missing cases. A successful process exit does not establish that every assigned case has a result.
3. **Match the report to the coverage.** Under a full-coverage requirement, report completion and a full-run aggregate only after every assigned case has a result. If cases remain missing, report incomplete coverage and make the population of any partial aggregate explicit.

Example:

**A successful job with eight missing cases.** The agent declared completion after job submission, and the user requested a check against the assigned IDs. The finished job had results for **192 of 200 cases**. The agent listed the eight missing IDs, reported incomplete coverage, and withheld the full-run aggregate.

Evidence: L001, L002, L003, L004, L005
```

### 2. Diagnosis and recovery

Source:

```text
L001 Tool: Sync to archive-2025 refused because the workspace is read-only.
L002 Agent retries with a longer timeout. Tool: Same refusal.
L003 User: That workspace is archived; use active-2026 for this task.
L004 Agent attempts the new target. The record ends before a result.
```

Expected card:

```markdown
# I001

Title: Resolve a known target-state refusal before changing timeouts
Type: user-agent
Description:

Choose the next recovery action when a sync is refused because its destination cannot accept writes. Use the known target state to decide whether to change the destination or investigate further.

Workflow:

**Identify why the target is ineligible.** Read the refusal alongside target-state evidence or the user's explanation. A read-only error alone does not establish that a workspace is archived. When an archived destination is the identified cause and a valid replacement is specified for the task, use that replacement; a longer timeout does not change the original target's eligibility.

**Verify the new attempt.** Retry against the selected destination and inspect the result before claiming recovery. If the record ends at the attempt, preserve that unresolved status.

Example:

**Switching from an archived workspace.** Sync to `archive-2025` was refused as read-only, and a longer timeout produced the same refusal. The user explained that the workspace was archived and selected `active-2026` for the task. The agent attempted the new target, but no result was recorded: **recovery remained unverified**.

Evidence: L001, L002, L003, L004
```

### 3. Research and data workflows

Source:

```text
L001 User: Compare observed quality on the same completed tasks; report completion separately across 120 assigned IDs.
L002 Tool: A solved 80/100 completed tasks; B solved 68/80. Agent ranks B higher.
L003 User: Those rates cover different task sets. Align IDs and limit the conclusion.
L004 Tool: On 60 shared completed tasks, A solved 51 and B 48.
L005 Agent reports 51/60 versus 48/60, completion of 100/120 versus 80/120, and no full-population ranking.
```

Expected card:

```markdown
# I001

Title: Separate matched-task quality from completion coverage
Type: user-agent
Description:

Compare systems that completed different subsets of an assigned workload. Separate quality on shared completed tasks from completion coverage so that each comparison has a clear population.

Workflow:

1. **Align the quality comparison.** Match task IDs and compare solved counts on tasks completed by both systems. Use that same shared subset as the denominator for each system.
2. **Measure completion separately.** For each system, compare its completed task count with the full assigned manifest. Keep this denominator distinct from the shared-task denominator.
3. **State what each result supports.** Report quality on the shared subset alongside completion of the assigned workload. The subset comparison does not establish a quality ranking over all assigned tasks.

Example:

**Correcting a comparison across different task sets.** The agent initially ranked B higher using A's 80/100 and B's 68/80 solved rates. After the user requested matching task IDs, the agent reported:

| Measure | System A | System B |
| --- | --- | --- |
| Solved among 60 shared completed tasks | 51/60 | 48/60 |
| Completed among 120 assigned tasks | 100/120 | 80/120 |

The revised report kept these populations separate and made no quality ranking over all 120 assigned tasks.

Evidence: L001, L002, L003, L004, L005
```

### 4. Recurring operational workflows

Source:

```text
L001 User: Beacon release preparation precedes publication; publication requires explicit approval.
L002 Tool: Patch r17 created; 18 unit checks passed; integration checks were not run because their service was unavailable.
L003 Agent's handoff says ready to ship. User: Say prepared for review; carry artifact, validation, and approval status.
L004 Agent's revised handoff identifies r17, completed and unperformed checks, and pending approval. Tool: Release remains draft.
```

Expected card:

```markdown
# I001

Title: Preserve artifact and approval status in release handoffs
Type: user-agent
Description:

Prepare a release handoff that lets the next contributor identify the artifact, understand its validation status, and see whether publication is authorized. Use when preparing a release and publishing it are separate stages.

Workflow:

1. **Identify the artifact.** Name the patch or release and its revision so the next contributor knows which work the handoff describes.
2. **Separate completed and unperformed validation.** List the checks that ran and their results, then the checks that did not run and why. Keep unavailable checks visible even when other checks passed.
3. **State the current publication status.** Apply this release process's approval requirement. While required approval is pending, describe the artifact as prepared for review and retain its draft status.

Example:

**Preparing Beacon patch r17 for review.** The agent's first handoff said the release was ready to ship. The user corrected that status and required the handoff to carry the artifact, validation, and approval state.

The revised handoff identified **r17**, reported **18 passing unit checks**, and explained that integration checks had not run because their service was unavailable. Approval was still pending, and the release remained a draft.

Evidence: L001, L002, L003, L004
```

### 5. Scoped tool and domain knowledge

Source:

```text
L001 Tool: TaskLedger v2 returns two items with cursor p2; page p2 is empty but has cursor p3.
L002 Agent reads the reference: Filtering can leave intermediate pages empty. Only null next_cursor ends pagination; retain query filters.
L003 Agent follows p3 with the same filters. Tool: Three more items, next_cursor=null.
L004 Agent reports five items in the complete returned listing.
```

Expected card:

```markdown
# I001

Title: Follow continuation tokens through empty TaskLedger v2 pages
Type: agent
Description:

Retrieve a complete TaskLedger v2 listing when filtering can leave an intermediate page empty. This API uses the continuation cursor, rather than page length, to indicate whether more pages remain.

Workflow:

1. **Keep the query consistent.** Retain the same filters when requesting each page.
2. **Follow the continuation cursor.** If `next_cursor` is non-null, request that page even when the current page contains no items.
3. **Finish at a null cursor.** Accumulate the returned items and report the total after reaching `next_cursor=null`.

This termination rule belongs to TaskLedger v2. Apply it to another endpoint only when that endpoint documents the same contract.

Example:

**An empty page before the final results.** The first page returned two items and cursor `p2`. Page `p2` was empty but pointed to `p3`. After checking the API reference, the agent followed `p3` with the same filters and received three more items with `next_cursor=null`. It reported **five items** in the complete returned listing.

Evidence: L001, L002, L003, L004
```

### 6. Contextual personalization

Source:

```text
L001 User: For quick research updates on my phone, use concise Chinese with English model/method names. English manuscript requests should remain English.
L002 Agent gives a brief Chinese update comparing Cedar-7B with MemoryPatch, retaining the English names and noting the result came from one run.
L003 User: Use this format for my future quick research updates.
```

Expected card:

```markdown
# I001

Title: Use concise Chinese for this user's quick research updates
Type: user-agent
Description:

Write quick research updates in the format this user approved for reading on a phone. The preference governs these updates while preserving the requested language for other kinds of writing.

Workflow:

Choose the language and level of detail for the requested kind of writing:

| Context | User-endorsed choice |
| --- | --- |
| Quick research update for this user | Write concise Chinese; retain model and method names in English. |
| English manuscript request | Keep the manuscript text in English. |

Apply the update format to future quick research updates. For other requests, follow the explicitly requested language rather than extending this contextual preference to all writing.

Example:

**A phone-readable model comparison.** The agent gave a brief Chinese update comparing Cedar-7B with MemoryPatch, kept both names in English, and noted that the result came from one run. The user approved that format for future quick research updates. Their separate instruction to keep English manuscript requests in English remained part of the preference's scope.

Evidence: L001, L002, L003
```
