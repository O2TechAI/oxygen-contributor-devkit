import type { ReviewState } from './review-types.ts';

/** Only current, displayable content; embedded originals are intentionally absent. */
export type DiffState = ReviewState;

export type DiffLine = {
  kind: 'context' | 'added' | 'removed';
  text: string;
  oldLine?: number;
  newLine?: number;
};

export type DiffHunk = { heading: string; lines: DiffLine[] };

export function reviewDiffText(state: DiffState) {
  const lines = [
    `Review decision: ${state.status}`,
    '',
    '# Summary',
    state.trajectorySummary.text,
    ...state.summaryGroups.map(
      (group) =>
        `${group.id}: ${group.text}\nLines: ${group.lineIds.join(', ')}`,
    ),
    ...state.summaryLines.map((line) => `${line.id}: ${line.text}`),
    '',
    '# Insight order',
    state.insights.map((insight) => insight.id).join(', ') || '(empty)',
  ];
  const fields = [
    ['title', 'Title'],
    ['type', 'Type'],
    ['description', 'Description'],
    ['workflow', 'Workflow'],
    ['example', 'Example'],
    ['scope', 'Scope'],
    ['appliesWhen', 'Applies when'],
    ['takeaway', 'Takeaway'],
    ['why', 'Why'],
  ] as const;
  for (const insight of state.insights) {
    lines.push(
      '',
      `# ${insight.id}`,
      `Decision: ${insight.status}`,
      `Authorship: ${insight.authorship === 'reviewer' ? 'Reviewer addition' : 'Generated'}`,
    );
    for (const [field, label] of fields) {
      if (insight[field] !== undefined)
        lines.push(`${label}:`, insight[field] ?? '');
    }
    // Older cards can have free-form content rather than structured fields.
    if (!insight.description && !insight.takeaway && insight.text)
      lines.push('Text:', insight.text);
    lines.push(`Evidence: ${insight.evidence.join(', ')}`);
  }
  return lines.join('\n');
}

/** Line LCS with a bounded matrix; large changed blocks use a valid coarse diff. */
export function diffLines(before: string, after: string): DiffLine[] {
  if (before === after) return [];
  const a = before.split('\n');
  const b = after.split('\n');
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix])
    prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  )
    suffix++;
  const x = a.slice(prefix, a.length - suffix);
  const y = b.slice(prefix, b.length - suffix);
  const result: DiffLine[] = a.slice(0, prefix).map((text, index) => ({
    kind: 'context',
    text,
    oldLine: index + 1,
    newLine: index + 1,
  }));
  let oldLine = prefix + 1;
  let newLine = prefix + 1;
  const append = (kind: DiffLine['kind'], text: string) => {
    result.push({
      kind,
      text,
      ...(kind !== 'added' ? { oldLine: oldLine++ } : {}),
      ...(kind !== 'removed' ? { newLine: newLine++ } : {}),
    });
  };
  if ((x.length + 1) * (y.length + 1) > 2_000_000) {
    x.forEach((text) => append('removed', text));
    y.forEach((text) => append('added', text));
  } else {
    const width = y.length + 1;
    const matrix = new Uint32Array((x.length + 1) * width);
    for (let i = x.length - 1; i >= 0; i--) {
      for (let j = y.length - 1; j >= 0; j--) {
        matrix[i * width + j] =
          x[i] === y[j]
            ? matrix[(i + 1) * width + j + 1] + 1
            : Math.max(matrix[(i + 1) * width + j], matrix[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < x.length || j < y.length) {
      if (i < x.length && j < y.length && x[i] === y[j]) {
        append('context', x[i++]);
        j++;
      } else if (
        i < x.length &&
        (j === y.length ||
          matrix[(i + 1) * width + j] >= matrix[i * width + j + 1])
      ) {
        append('removed', x[i++]);
      } else {
        append('added', y[j++]);
      }
    }
  }
  a.slice(a.length - suffix).forEach((text) => append('context', text));
  return result;
}

export function reviewDiff(before: DiffState, after: DiffState): DiffHunk[] {
  const lines = diffLines(reviewDiffText(before), reviewDiffText(after));
  const ranges: { start: number; end: number }[] = [];
  lines.forEach((line, index) => {
    if (line.kind === 'context') return;
    const start = Math.max(0, index - 3);
    const end = Math.min(lines.length, index + 4);
    const previous = ranges.at(-1);
    if (previous && start <= previous.end) previous.end = end;
    else ranges.push({ start, end });
  });
  return ranges.map(({ start, end }) => {
    const hunk = lines.slice(start, end);
    const section =
      lines
        .slice(0, start + 1)
        .findLast((line) => /^# |^[A-Z][A-Za-z ]+:$/.test(line.text))?.text ??
      '';
    const oldStart =
      hunk.find((line) => line.oldLine !== undefined)?.oldLine ?? 0;
    const newStart =
      hunk.find((line) => line.newLine !== undefined)?.newLine ?? 0;
    return {
      heading:
        `@@ -${oldStart},${hunk.filter((line) => line.kind !== 'added').length} +${newStart},${hunk.filter((line) => line.kind !== 'removed').length} @@ ${section}`.trim(),
      lines: hunk,
    };
  });
}
