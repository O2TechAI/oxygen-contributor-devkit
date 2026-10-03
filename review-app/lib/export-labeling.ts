import type { Review } from './review-types.ts';

export function exportLabelingSummary(reviews: Review[]) {
  const counts = {
    accepted: 0,
    declined: 0,
    pending: 0,
    needsReview: 0,
    incompleteReviews: 0,
  };
  for (const review of reviews) {
    let incomplete = false;
    for (const insight of review.insights) {
      if (insight.status === 'accepted') counts.accepted += 1;
      if (insight.status === 'rejected') counts.declined += 1;
      if (insight.status === 'pending') {
        counts.accepted += 1;
        counts.pending += 1;
        incomplete = true;
      }
      if (insight.status === 'needs_review') {
        counts.needsReview += 1;
        incomplete = true;
      }
    }
    if (incomplete) counts.incompleteReviews += 1;
  }
  return counts;
}
