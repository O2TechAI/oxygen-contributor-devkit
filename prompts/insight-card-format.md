# Insight card format

Use exactly `Title`, `Type`, `Description`, `Workflow`, `Example`, and `Evidence`, once each in that order, under sequential `# I001`, `# I002`, etc. headings. Title, Type, and Evidence are nonempty single-line fields. Description, Workflow, and Example support Markdown.

## Skill-creator writing guidance

The following relevant guidance is supplied directly from the installed skill-creator's “Write the Instructions” section; no external lookup is needed:

> The frontmatter `description` should briefly explain what the skill does and when it applies. Include a meaningful boundary when similar requests should not activate the skill.
>
> Put detailed workflows, tool choices, examples, and operating modes in the body or relevant references rather than listing them all in the description.
>
> Write only the instructions needed for another Codex instance to perform the task well. State the desired outcome, non-obvious context, real constraints, and relevant references or tools. Preserve the user's explicit choices and existing authorization boundaries. Avoid prescribing a fixed structure, process, or number of steps when the task does not require one.

For these candidate cards, Description serves that catalog role. Workflow contains the abstract method, and Example shows a recorded application in a setting understandable without the original project. The cards are proposals for future skills, not completed executable skills.

## Demonstration

Derive actual facts and citations from the supplied record. This demonstration abstracts a recorded application; its table is an editorial choice, not a required template.

````markdown
# I001

Title: Control Roles in Simulator Evaluations
Type: user-agent
Description:

Separate the model under evaluation from assistants, generators, and judges when comparing user simulators or other multi-agent systems. Use when auxiliary roles can alter the generated trajectory or its score.

Workflow:

Map model calls to their causal roles. Keep auxiliary roles fixed across candidates and record their assignments. When correcting a role assignment, decide what to reuse by which artifacts it could affect: a changed judge may allow rescoring saved outputs, while a changed interaction partner requires regenerating affected conversations. Keep original and corrected results distinguishable.

Example:

An evaluation compared user-simulator models, but each candidate also supplied the assistant and judge. The correction assigned fixed auxiliary models separately from the simulator, separating the behavior being evaluated from the roles influencing it.

Applying this separation also determined which existing results could be reused:

| Existing material | Application |
|---|---|
| Saved standalone responses | Retain the responses and judge them using the separately assigned judge. |
| Interactive conversations | Regenerate them with the fixed assistant, because its replies influence subsequent simulated-user turns. |

The agent reported launching the corrected evaluation wave, with role assignments recorded and original outputs kept separate.

Evidence: L029, L031, L033
````

## Field guidance

- **Title:** Name a capability useful for a recurring project task.
- **Description:** Briefly state what the skill does and when it applies. Include a boundary only when useful for distinguishing similar requests.
- **Workflow:** Explain the proposed reusable approach through its consequential actions, decisions, and essential constraints. Generalize incidental project details. Choose paragraphs or steps to suit the method; no mandatory structure or step count.
- **Example:** Show how the method was applied in a recorded situation. Abstract the setting into understandable tasks, roles, and constraints, and explain consequential choices and results. Retain discovery history only when it clarifies the application. Preserve attribution and outcome status; simplifying the setting must not invent actions or success, or turn proposed Workflow steps into historical claims. Partial and failed applications can qualify; scenarios that did not occur cannot.
- **Evidence:** List final summary content-line IDs supporting the recorded application and origin of the method. Use individual comma-separated IDs without ranges. Generalized Workflow recommendations remain inferences and do not require proof of every future application.

Use paragraphs, subheadings, lists, tables, blockquotes, emphasis, inline code, and fenced code where helpful, without a length or formatting quota. Use Markdown subheadings or bold text for internal labels. Unindented single-word labels such as `Title:` or `Context:` outside code are reserved for card fields, and `# Ixxx` lines outside code begin cards. Close every code fence; apparent fields or card headings inside it are literal content.

## Origin types

Use exactly one type:

- `user-agent`: user requests, corrections, feedback, or negotiation materially shaped the capability.
- `agent`: the capability arose from the agent's methods, discoveries, failures, or recovery.

For mixed cases, choose `user-agent` when the user's contribution was material. Types describe the idea's origin, not its future audience, effectiveness, or a lasting user preference. There are no type quotas.

After summary edits or redaction, regenerate labels and check every citation against its final content. Leave the insight file empty when no useful candidate with a supported example remains. The parent validates fields, types, and citation targets; the worker judges usefulness and factual fidelity.
