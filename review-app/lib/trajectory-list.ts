import type { Review } from './review-types.ts';

export function trajectoryIdentity(sourcePath: string, fallbackId: string) {
  const match = sourcePath.match(/^(run-.+?)-trajectory-(\d+)(?:-|$)/);
  return match
    ? { key: `${match[1]}/${match[2]}`, run: match[1], number: match[2] }
    : { key: fallbackId, run: 'Other reviews', number: '' };
}

export function reviewVersion(review: Pick<Review, 'privacyStatus'>) {
  return review.privacyStatus === 'redacted'
    ? 'Redacted'
    : review.privacyStatus === 'unredacted'
      ? 'Original'
      : 'Review';
}

export function defaultReviewSelection(reviews: Review[], run: string) {
  return reviews
    .filter(
      (review) =>
        review.privacyStatus === 'redacted' &&
        trajectoryIdentity(review.sourcePath, review.id).run === run,
    )
    .map((review) => review.id);
}

export type TrajectoryGroup = ReturnType<typeof trajectoryIdentity> & {
  title: string;
  reviews: Review[];
};

export function groupTrajectories(reviews: Review[]): TrajectoryGroup[] {
  const groups = new Map<string, TrajectoryGroup>();
  for (const review of reviews) {
    const identity = trajectoryIdentity(review.sourcePath, review.id);
    const group = groups.get(identity.key);
    if (group) group.reviews.push(review);
    else {
      const heading = review.summaryLines
        .find((line) => /^#{1,6}\s+/.test(line.text))
        ?.text.replace(/^#{1,6}\s+/, '');
      groups.set(identity.key, {
        ...identity,
        title: heading || review.projectName,
        reviews: [review],
      });
    }
  }
  return [...groups.values()].sort(
    (a, b) =>
      a.run.localeCompare(b.run) ||
      Number(a.number) - Number(b.number) ||
      a.key.localeCompare(b.key),
  );
}

export function decisionCounts(reviews: Review[]) {
  return reviews
    .flatMap((review) => review.insights)
    .reduce(
      (counts, insight) => {
        if (insight.status === 'accepted') counts.accepted += 1;
        else if (insight.status === 'rejected') counts.declined += 1;
        else counts.pending += 1;
        return counts;
      },
      { accepted: 0, declined: 0, pending: 0 },
    );
}

export function filterTrajectories(
  groups: TrajectoryGroup[],
  filters: {
    query: string;
    run: string;
    version: string;
    status: string;
    selectedOnly: boolean;
  },
  selectedIds: string[],
): TrajectoryGroup[] {
  const query = filters.query.trim().toLowerCase();
  const selected = new Set(selectedIds);
  return groups.flatMap((group) => {
    // View selected spans runs so every checked review stays accessible.
    if (!filters.selectedOnly && group.run !== filters.run) return [];
    const reviews = group.reviews.filter(
      (review) =>
        (review.privacyStatus === 'redacted' ||
          review.privacyStatus === 'unredacted') &&
        (filters.version === 'all' ||
          reviewVersion(review).toLowerCase() === filters.version) &&
        (filters.status === 'all' || review.status === filters.status) &&
        (!filters.selectedOnly || selected.has(review.id)) &&
        (!query ||
          `${group.number} ${group.title} ${group.run} ${review.projectName} ${review.sourcePath} ${review.id}`
            .toLowerCase()
            .includes(query)),
    );
    return reviews.length ? [{ ...group, reviews }] : [];
  });
}
