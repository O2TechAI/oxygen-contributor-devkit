import type { Review } from './review-types.ts';

export function trajectoryIdentity(sourcePath: string, fallbackId: string) {
  const match = sourcePath.match(/^(run-.+?)-trajectory-(\d+)(?:-|$)/);
  return match
    ? { key: `${match[1]}/${match[2]}`, run: match[1], number: match[2] }
    : { key: fallbackId, run: 'Other reviews', number: '' };
}

type ReviewStage = Pick<Review, 'privacyStatus'> &
  Partial<Pick<Review, 'stage' | 'reviewLevel'>>;

export function isExtractionDraft(review: ReviewStage) {
  if (review.reviewLevel === 'global') return false;
  return (
    review.stage === 'insight' ||
    (review.privacyStatus === 'unredacted' && review.stage !== 'humanize')
  );
}

export function reviewVersion(review: ReviewStage) {
  if (review.reviewLevel === 'global') return 'Global';
  if (isExtractionDraft(review)) return 'Extraction draft';
  if (review.privacyStatus === 'redacted') return 'Redacted';
  if (review.stage === 'humanize') return 'Unredacted';
  return 'Review';
}

export function reviewContentLabel(review: ReviewStage) {
  const version = reviewVersion(review);
  return version === 'Unredacted' || version === 'Redacted'
    ? `${version} insights and summary`
    : version;
}

/** Keep raw extraction out of normal navigation; explicit links still work. */
export function visibleReviews(reviews: Review[], activeId = '') {
  return reviews.filter(
    (review) => !isExtractionDraft(review) || review.id === activeId,
  );
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

// Headings that name the section rather than the session.
const GENERIC_HEADING =
  /^(?:会话概览|会话概述|概览|概述|总览|摘要|overview|session overview|summary)$/i;

function headings(review: Pick<Review, 'summaryLines'>) {
  return review.summaryLines
    .filter((line) => /^#{1,6}\s+/.test(line.text))
    .map((line) => line.text.replace(/^#{1,6}\s+/, '').trim());
}

/** The Summary's first heading that names the session, or ''. */
export function summaryHeading(review: Pick<Review, 'summaryLines'>) {
  return (
    headings(review).find(
      (heading) => heading && !GENERIC_HEADING.test(heading),
    ) ?? ''
  );
}

/** The Summary's first specific heading, else the project name. */
export function reviewTitle(
  review: Pick<Review, 'summaryLines' | 'projectName'>,
) {
  return summaryHeading(review) || headings(review)[0] || review.projectName;
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
      groups.set(identity.key, {
        ...identity,
        title: reviewTitle(review),
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
        (review.reviewLevel === 'global' ||
          review.privacyStatus === 'redacted' ||
          review.privacyStatus === 'unredacted') &&
        (filters.version === 'all'
          ? !isExtractionDraft(review) ||
            (filters.selectedOnly && selected.has(review.id))
          : reviewVersion(review).toLowerCase() === filters.version) &&
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
