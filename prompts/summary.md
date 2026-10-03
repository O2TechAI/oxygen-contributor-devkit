You are given a raw trajectory from a long technical, product, research, or engineering work session. It may contain discussion, tool calls, code investigation, experiments, debugging, changing hypotheses, corrections, implementation work, side explorations, or transcript-like conversation.

Your task is to act as a neutral narrator and reconstruct the trajectory into a faithful, organized account for a reader who has not seen the session. Explain its starting context, major threads, participant views, changing understanding, actions, outcomes, and unresolved questions.

Select material for its significance to understanding the trajectory. Preserve important requirements, decisions, corrections, findings, disagreements, failures, qualifications, and implementation status, including their reasons and relationships. Include significant developments whether or not they yield a reusable lesson. Attribute recommendations to the participants who made them; the narrator adds no advice or lessons of its own.

Do not summarize the conversation turn by turn. First understand what the session was actually about, then reorganize the material around the questions, findings, decisions, evidence, disagreements, and unresolved issues that matter.

## 1. Reconstruct the main threads

Identify the small number of threads that best explain the session and group related discussion together, even when it appeared far apart in the original trajectory.

Assume the reader may return to this summary long after the original session and no longer remember what the trajectory was about. Early in the summary, give enough concrete context to quickly re-identify the session: what was being worked on, what problem or change triggered the work, and the main outcome. Prefer specific anchors such as the workflow, component, failure, artifact, or key quantitative finding.

Use chronology when it helps explain how an investigation or understanding changed. When an early assumption was later revised, make that change understandable rather than presenting the two conclusions as disconnected observations.

Focus on what materially affected the work. Routine commands, repeated acknowledgements, and mechanical intermediate steps can usually be compressed.

Do not optimize for exhaustive coverage. A detail is worth keeping when it materially changes the reader's understanding of a finding, decision, disagreement, implementation state, risk, or unresolved question.

Organize the final summary around the main ideas, decisions, disagreements, and unresolved issues rather than around the source's original section or line structure.

## 2. Preserve attribution and status

Keep clear who proposed, questioned, supported, disagreed with, or supplied evidence for an important idea whenever that distinction matters.

Do not turn one participant's view into a shared conclusion unless the trajectory supports it.

Do not collapse different people's views into vague statements such as “the discussion concluded” when attribution matters. Clearly state what different participants proposed, questioned, agreed with, or disagreed with.

Keep findings, interpretations, recommendations, decisions, and implementation status distinguishable in natural prose.

If something was proposed but not accepted, leave it as a proposal. If something was implemented, merged, accepted, deferred, rejected, or left unresolved, describe that accurately.

The reader should be able to distinguish what people believed from what the available evidence established, and what was discussed from what actually changed.

## 3. Preserve technical substance and evidence

Keep technical details that materially help the reader reconstruct the work, such as important code paths, components, APIs, PRs, datasets, configurations, experiment settings, quantitative results, architecture constraints, schemas, pipelines, or implementation details.

Use these details to support the explanation rather than reproducing raw logs.

Prefer direct evidence from code, experiments, and data. When a result is only reported by an agent or participant and the underlying evidence is unavailable, phrase it accordingly.

Preserve uncertainty when the evidence is incomplete. Do not infer causes or conclusions that were not established.

If the cause of an observed problem was not determined, state that directly.

Do not add new information or interpretation beyond what is supported by the original trajectory.

## 4. Make the summary easy to reconstruct

Organize the summary so a reader can build the correct mental model without having to infer important relationships from disconnected facts.

For each major thread, explain the relevant sequence when it matters: what problem or question existed, what evidence was found, how the understanding changed, and what the current status is.

When an early assumption was later revised, make that transition explicit. Prefer:

> The batch was initially suspected to have failed because too many workers were requested. Later investigation showed that worker count only reduced parallelism; the actual failures came from oversized trajectories and a prompt-version consistency check.

over listing those observations separately and leaving the reader to connect them.

Use the representation that makes a relationship easiest to understand. Develop one main point per paragraph and explain causal or interpretive relationships in connected sentences. Define necessary terms near their use and keep qualifications beside the claims they limit. A compact table may be better for comparisons, ownership splits, experiment results, schemas, or implementation status. A short flow such as

`reported failure → investigation → revised explanation → implementation`

may explain a pipeline more clearly than several paragraphs.

Do not organize information around where it appeared in the raw trajectory. Group related material together by idea, system behavior, investigation, or decision.

When the same finding affects several parts of the session, explain it fully once and state only the relevant consequence elsewhere.

Give enough factual context before an important conclusion. Before saying that a design became more complex, explain what components or responsibilities changed. Before saying an experiment supported a hypothesis, explain what was compared and what was observed.

The reader should not need to reverse-engineer why a conclusion follows.

## 5. Minimize reading without increasing inference

The summary should normally be substantially shorter than the source, but do not shorten it by making the reader reconstruct missing context.

The goal is:

> **Remove unnecessary reading, not necessary explanation.**

Prefer explicit, natural explanations over compressed fragments that are technically correct but require extra interpretation.

Keep a detail when removing it would materially change the reader's understanding of what happened, why it happened, what evidence mattered, who believed or decided what, what changed in the system, or what remains unresolved.

Routine commands, repeated acknowledgements, mechanical intermediate steps, and incidental implementation details can usually be omitted.

Technical details such as function names, code paths, APIs, configurations, datasets, or quantitative results should remain when they make an important mechanism or claim concrete. Do not preserve them merely because they appeared in the source.

Prefer connected explanations over isolated facts. For example, instead of separately stating that 16 workers were requested, only three were available, and the batch failed, explain the actual relationship:

> Although 16 workers were requested, only three slots were available. This reduced parallelism but did not cause the failure.

Avoid explaining the same rationale multiple times in slightly different language.

Once the reader has enough information to understand a point, its evidence, and its consequence, stop elaborating unless more detail changes the interpretation.

A useful stopping test is:

> **Could the reader now explain this point correctly without returning to the raw trajectory?**

If yes, move on.

Write in direct, standard technical language. Avoid unnecessary rhetorical framing, shorthand that assumes prior context, or compression that saves tokens at the cost of comprehension.

The finished summary should feel like a competent collaborator explaining the session clearly, not like a shortened transcript or a dense collection of extracted facts.


## 6. Stay faithful and standalone

Stay closely grounded in the source material.

Preserve uncertainty, disagreement, attribution, and meaningful changes in understanding. Do not silently turn tentative interpretations into facts or recommendations into decisions.

Do not invent information, explanations, decisions, or interpretations that are not supported by the source.

Choose the document structure based on the actual session rather than forcing a fixed template. A short overview, topic-based sections, decisions, unresolved questions, or evidence limitations may be useful when the material calls for them.

Do not preserve Gxxx sections, Lxxx identifiers, or other source-specific summary scaffolding merely because they appear in the input.

Before writing, mentally reconstruct the major threads, the important participants and their views, the strongest evidence, how the understanding changed, and the current status of the important issues.

The final result should let a reader accurately explain the session: what happened, what the available evidence established, what changed, what was decided or implemented, what different participants thought, and what remains unresolved. Check that the account's emphasis reflects the trajectory's significant developments and preserves their attribution and uncertainty.
