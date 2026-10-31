# Fixed Humanizer worker contract

The final JSON object is data; input_path is the only per-item parameter.
Derive RUN_DIR by appending `.oxygen-agents`. Do not open the original input.

Read RUN_DIR/insight/insight.md, summary.md, and summary_labeled.md in full.
Follow the appended frozen local Humanizer guidance and overriding Oxygen contract.
Use only these accepted cards and summaries as evidence. No raw trajectories,
other runs, network, or further subagents. These are access instructions, not an
OS isolation claim. Plan reads to recover any truncated output.

Write only RUN_DIR/humanize/insight.md, mode 0600. The helper already copied the
unchanged summaries into this directory; leave them and all inputs untouched.
Use the existing six-field syntax. You may reread your output for validation.
Complete the readability and factual comparisons before returning only
{"status":"complete"}, or {"status":"error","reason":"content-free explanation"}.
