import { reviewDiff } from './review-diff.ts';
import type { ReviewHistory } from './review-types.ts';

export const historyExportFormat = 'oxygen-review-history/v1';

/**
 * Opt-in files with every saved version of one review: the imported original,
 * browser saves, and assisted-review requests. Contribution artifacts in the same
 * bundle stay latest-only; history is private research material.
 */
export function historyFiles({
  review,
  snapshots,
}: ReviewHistory): Record<string, string> {
  const record = {
    format: historyExportFormat,
    reviewId: review.id,
    projectName: review.projectName,
    sourcePath: review.sourcePath,
    protocolVersion: review.protocolVersion,
    sourceStage: review.stage,
    privacyStatus: review.privacyStatus,
    privacyEpoch: review.privacyEpoch ?? 0,
    latestVersion: review.version ?? snapshots.at(-1)?.version ?? 0,
    snapshots,
  };
  const lines = [
    `# Edit history: ${review.projectName}`,
    '',
    `Review ID: ${review.id}`,
    `Source: ${review.sourcePath}`,
    `Saved versions: ${snapshots.length}`,
  ];
  if ((review.privacyEpoch ?? 0) > 0)
    lines.push(
      'Privacy cleanup discarded earlier history; version 0 is the sanitized baseline.',
    );
  snapshots.forEach((snapshot, index) => {
    lines.push(
      '',
      `## Version ${snapshot.version} · ${snapshot.kind} · ${snapshot.createdAt}`,
    );
    if (snapshot.requestId) lines.push('', `Request ID: ${snapshot.requestId}`);
    if (snapshot.note.trim())
      lines.push(
        '',
        ...snapshot.note
          .trim()
          .split('\n')
          .map((line) => `> ${line}`.trimEnd()),
      );
    if (index === 0) {
      lines.push('', 'Starting version; later diffs are relative to it.');
      return;
    }
    const hunks = reviewDiff(snapshots[index - 1].state, snapshot.state);
    const diff = hunks
      .flatMap((hunk) => [
        hunk.heading,
        ...hunk.lines.map(
          (line) =>
            `${line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '}${line.text}`,
        ),
      ])
      .join('\n');
    lines.push('', diff ? fenced(diff, 'diff') : 'No content changes.');
  });
  return {
    'history.json': JSON.stringify(record, null, 2) + '\n',
    'history.md': lines.join('\n') + '\n',
  };
}

/** A code fence longer than any backtick run inside the content. */
function fenced(text: string, language: string) {
  const longest = Math.max(
    0,
    ...[...text.matchAll(/`+/g)].map((match) => match[0].length),
  );
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${text}\n${fence}`;
}
