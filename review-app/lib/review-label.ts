import type { Review } from './review-types.ts';

export function reviewLabels(reviews: Review[]): Map<string, string> {
  const entries = reviews.map((review) => {
    const trajectory = review.sourcePath.match(/trajectory[-_ ]?(\d+)/i)?.[1];
    const title = review.summaryLines
      .filter((line) => /^#{1,6}\s+/.test(line.text))
      .map((line) => line.text.replace(/^#{1,6}\s+/, '').trim())
      .find(
        (heading) =>
          !/^(overview|summary|trajectory summary|context|background)$/i.test(
            heading,
          ),
      );
    const project = review.projectName
      .split(' · ')
      .filter(
        (part) =>
          !/^(trajectory[-_ ]?\d+|original|redacted|review)$/i.test(
            part.trim(),
          ),
      )
      .join(' · ');
    const version = review.sourcePath.match(/(\d{8})T(\d{6})(\d*)Z/);
    const date = version
      ? `${version[1]} ${version[2].slice(0, 2)}:${version[2].slice(2, 4)}:${version[2].slice(4, 6)}`
      : review.sourcePath;
    const stage =
      review.privacyStatus === 'redacted'
        ? 'Redacted'
        : review.privacyStatus === 'unredacted'
          ? 'Original'
          : 'Review';
    const label = [
      trajectory ? `Trajectory ${trajectory}` : undefined,
      title || project,
      stage,
      date,
    ]
      .filter(Boolean)
      .join(' · ');
    return { id: review.id, label };
  });
  const counts = new Map<string, number>();
  for (const { label } of entries)
    counts.set(label, (counts.get(label) ?? 0) + 1);
  return new Map(
    entries.map(({ id, label }) => [
      id,
      (counts.get(label) ?? 0) > 1 ? `${label} · ${id}` : label,
    ]),
  );
}
