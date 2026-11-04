import type { InsightStatus, Review } from './review-types.ts';

export type QueuePosition = { reviewId: string; insightId: string };

export function isUndecided(status: InsightStatus) {
  return status !== 'accepted' && status !== 'rejected';
}

/** Every insight of every review, in review order. */
function slots(reviews: Review[]) {
  return reviews.flatMap((review) =>
    review.insights.map((insight) => ({
      reviewId: review.id,
      insightId: insight.id,
      undecided: isUndecided(insight.status) && review.status !== 'completed',
    })),
  );
}

function indexOf(list: QueuePosition[], from: QueuePosition) {
  return list.findIndex(
    (slot) =>
      slot.reviewId === from.reviewId && slot.insightId === from.insightId,
  );
}

/**
 * The next card that still needs a decision after `from`, continuing into the
 * following reviews and wrapping to the beginning. Null when nothing is left.
 */
export function nextUndecided(
  reviews: Review[],
  from: QueuePosition,
): QueuePosition | null {
  const list = slots(reviews);
  const start = indexOf(list, from);
  for (let step = 1; step <= list.length; step += 1) {
    const slot = list[(start + step + list.length) % list.length];
    if (slot?.undecided) {
      return { reviewId: slot.reviewId, insightId: slot.insightId };
    }
  }
  return null;
}

/** The card before or after `from`, crossing review boundaries; null at either end. */
export function neighbour(
  reviews: Review[],
  from: QueuePosition,
  direction: 1 | -1,
): QueuePosition | null {
  const list = slots(reviews);
  const target = list[indexOf(list, from) + direction];
  return target
    ? { reviewId: target.reviewId, insightId: target.insightId }
    : null;
}

export function queueSummary(reviews: Review[]) {
  const list = slots(reviews);
  return {
    total: list.length,
    undecided: list.filter((slot) => slot.undecided).length,
    reviews: reviews.length,
  };
}

/** A summary line as plain reading text: no list, table, heading or emphasis markers. */
export function evidencePlainText(line: string) {
  let text = line.trim();
  if (/^\|.*\|$/.test(text)) {
    if (/^\|[\s:|-]+\|$/.test(text)) return '';
    text = text
      .slice(1, -1)
      .split('|')
      .map((cell) => cell.trim())
      .filter(Boolean)
      .join(' · ');
  }
  text = text
    .replace(/^#{1,6}\s+/, '')
    .replace(/^(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/^\[[xX]\]\s+/, '☑ ')
    .replace(/^\[ \]\s+/, '☐ ');
  return text.replace(/\*\*|__|`/g, '').trim();
}
