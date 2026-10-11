### Write the Instructions

The frontmatter `description` should briefly explain what the skill does and when it applies. Include a meaningful boundary when similar requests should not activate the skill.

For example:

```yaml
description: Create or edit Word documents when formatting, tracked changes, or comments require document-specific handling.
```

Put detailed workflows and examples in the body or relevant references rather than listing them all in the description. Preserve supported optional frontmatter, such as existing `metadata`, when appropriate.

Write only the instructions needed for another Codex instance to perform the task well. State the desired outcome, non-obvious context, real constraints, and relevant references or tools. Preserve the user's explicit choices and existing authorization boundaries. Avoid prescribing a fixed structure, process, or number of steps when the task does not require one.
