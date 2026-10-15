import { SaveConflictError } from './autosave.ts';
import type { Review, ReviewWriteResult } from './review-types.ts';

export type PendingReviewSave = {
  review: Review;
  note: string;
  status: Review['status'];
  requestId: string;
};

/** Versions advance only from confirmed saves or an explicit fresh load. */
export class ReviewRevisionClient {
  private versions = new Map<string, number>();
  private send: typeof fetch;

  constructor(send: typeof fetch = fetch) {
    // Native browser fetch requires Window as its receiver, even when stored.
    this.send = send.bind(globalThis);
  }

  loaded(review: Review) {
    this.versions.set(review.id, review.version ?? review.revisionCount);
  }

  versionFor(review: Review) {
    return (
      this.versions.get(review.id) ?? review.version ?? review.revisionCount
    );
  }

  async save({
    review,
    note,
    status,
    requestId,
  }: PendingReviewSave): Promise<ReviewWriteResult> {
    const response = await this.send(
      `/api/reviews/${encodeURIComponent(review.id)}/revisions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          trajectorySummary: review.trajectorySummary,
          summaryGroups: review.summaryGroups,
          summaryLines: review.summaryLines,
          insights: review.insights,
          note,
          status,
          expectedVersion: this.versionFor(review),
          requestId,
        }),
      },
    );
    if (!response.ok) {
      const result = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (response.status === 409 || response.status === 404) {
        throw new SaveConflictError(
          response.status === 404
            ? 'This review is no longer available. Its history may have been reset; old drafts cannot be saved into the new review.'
            : 'The saved review changed in another session. Your draft is retained; reconcile it before saving.',
        );
      }
      throw new Error(result?.error || 'Autosave failed. Please retry.');
    }
    const result = (await response.json()) as ReviewWriteResult;
    this.versions.set(review.id, result.savedVersion);
    return result;
  }
}
