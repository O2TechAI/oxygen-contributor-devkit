import type { Review } from './review-types.ts';
import type { SourceKind } from './oxygen-api.ts';
import {
  buildTrajectoryIndex,
  generationLabel,
  type IndexRun,
  type Version,
} from './trajectory-index.ts';
import { decisionCounts, reviewTitle } from './trajectory-list.ts';

/** Same limit as the review export. */
export const MAX_SUBMISSION_REVIEWS = 500;

/** What a run tells us about its trajectories and workers (from the local service). */
export type SubmissionRun = IndexRun;

export type SuggestedAgent = {
  host: SourceKind;
  model: string;
  effort: string;
};

/** Used when neither the runs nor the reviews say which model made them. */
export const DEFAULT_AGENT: SuggestedAgent = {
  host: 'codex',
  model: 'gpt-6.1-sol',
  effort: 'high',
};

/**
 * Why a review cannot be submitted, or null. Mirrors what the cross-session
 * helper accepts: completed protocol-9 reviews of individual trajectories.
 * Unredacted reviews may be submitted; the pages warn about them.
 */
export function submissionEligibility(review: Review): string | null {
  if (review.reviewLevel === 'global')
    return 'Global insights are the result of this step, not a trajectory.';
  if (review.format !== 'v5' || review.protocolVersion !== 9)
    return 'This review uses an older format that cannot be submitted.';
  const open = review.insights.filter(
    (insight) => insight.status !== 'accepted' && insight.status !== 'rejected',
  ).length;
  if (open)
    return `${open} ${open === 1 ? 'card needs' : 'cards need'} a decision.`;
  if (review.status !== 'completed') return 'Not marked complete yet.';
  return null;
}

export type SubmissionRow = {
  review: Review;
  /** `run-<id>`, or "Other reviews" for reviews that did not come from a run. */
  run: string;
  number: string;
  /** The Summary heading; the only title stored with a submission. */
  title: string;
  /** The trajectory's name on this computer: session start and the agent's title. */
  label: string;
  /** Which run produced it, e.g. "Run of Nov 4, 2026, 20:26 · gpt-6.1-terra". */
  generation: string | null;
  version: Version | null;
  reason: string | null;
  /** All versions of one session share a group; one may be chosen. */
  group: string;
  counts: ReturnType<typeof decisionCounts>;
};

function runOf(runs: SubmissionRun[], run: string) {
  return runs.find((item) => `run-${item.id}` === run);
}

/**
 * Every version of every generation, grouped by session (see trajectory-index),
 * then reviews that did not come from a run. Global reviews and raw extraction
 * drafts are not trajectories and are left out.
 */
export function submissionRows(
  reviews: Review[],
  runs: SubmissionRun[] = [],
): SubmissionRow[] {
  const index = buildTrajectoryIndex(reviews, runs);
  const rows: SubmissionRow[] = [];
  const row = (
    review: Review,
    fields: Pick<
      SubmissionRow,
      'run' | 'number' | 'label' | 'generation' | 'version' | 'group'
    >,
  ) =>
    rows.push({
      review,
      title: reviewTitle(review),
      reason: submissionEligibility(review),
      counts: decisionCounts([review]),
      ...fields,
    });
  for (const session of index.sessions) {
    for (const generation of session.generations) {
      for (const version of ['redacted', 'unredacted'] as const) {
        const review = generation[version];
        if (!review) continue;
        row(review, {
          run: generation.run,
          number: generation.number,
          label: session.label,
          generation: generationLabel(generation),
          version,
          group: session.key,
        });
      }
    }
  }
  for (const review of index.other) {
    row(review, {
      run: 'Other reviews',
      number: '',
      label: reviewTitle(review),
      generation: null,
      version: null,
      group: review.id,
    });
  }
  return rows;
}

/**
 * The rows to list: every submittable version, or, for a trajectory with none,
 * its main review with the reason.
 */
export function visibleSubmissionRows(rows: SubmissionRow[]) {
  const eligible = new Set(
    rows.filter((row) => !row.reason).map((row) => row.group),
  );
  const shown = new Set<string>();
  return rows.filter((row) => {
    if (eligible.has(row.group)) return !row.reason;
    if (shown.has(row.group)) return false;
    shown.add(row.group);
    return true;
  });
}

/**
 * One version per trajectory: a completed redacted review before an unredacted
 * one, then the newest run's.
 */
export function defaultSubmissionSelection(rows: SubmissionRow[]) {
  const chosen = new Map<string, SubmissionRow>();
  const rank = (row: SubmissionRow) => (row.version === 'unredacted' ? 1 : 0);
  for (const row of rows) {
    if (row.reason) continue;
    const current = chosen.get(row.group);
    if (!current || rank(row) < rank(current)) chosen.set(row.group, row);
  }
  return rows
    .filter((row) => chosen.get(row.group) === row)
    .map((row) => row.review.id);
}

/** Check or uncheck a row; checking one copy of a session unchecks the others. */
export function toggleSubmission(
  selected: string[],
  rows: SubmissionRow[],
  reviewId: string,
) {
  const row = rows.find((item) => item.review.id === reviewId);
  if (!row || row.reason) return selected;
  if (selected.includes(reviewId))
    return selected.filter((id) => id !== reviewId);
  const copies = new Set(
    rows
      .filter((item) => item.group === row.group)
      .map((item) => item.review.id),
  );
  return [...selected.filter((id) => !copies.has(id)), reviewId];
}

/** Why this selection cannot be submitted, or null. The server checks it again. */
export function selectionProblem(rows: SubmissionRow[], selected: string[]) {
  if (!selected.length) return 'Choose at least one trajectory.';
  if (selected.length > MAX_SUBMISSION_REVIEWS)
    return `Choose at most ${MAX_SUBMISSION_REVIEWS} trajectories.`;
  if (new Set(selected).size !== selected.length)
    return 'A trajectory was chosen twice.';
  const byId = new Map(rows.map((row) => [row.review.id, row]));
  const groups = new Set<string>();
  for (const id of selected) {
    const row = byId.get(id);
    if (!row) return 'A chosen review is no longer available.';
    if (row.reason) return `${row.label}: ${row.reason}`;
    if (groups.has(row.group))
      return `${row.label}: two versions of the same session were chosen; keep one.`;
    groups.add(row.group);
  }
  return null;
}

function hostFor(model: string): SourceKind {
  return /^(opus|sonnet|haiku|fable|claude)/i.test(model) ? 'claude' : 'codex';
}

/** The worker most of the chosen trajectories were made with. */
export function suggestedAgent(
  rows: SubmissionRow[],
  runs: SubmissionRun[] = [],
): SuggestedAgent {
  const tally = new Map<string, { agent: SuggestedAgent; count: number }>();
  for (const row of rows) {
    const run = runOf(runs, row.run);
    const { model, reasoningEffort } = row.review.provenance;
    const agent: SuggestedAgent | null = run
      ? { host: run.host, model: run.model, effort: run.effort ?? '' }
      : model
        ? { host: hostFor(model), model, effort: reasoningEffort ?? '' }
        : null;
    if (!agent) continue;
    const key = `${agent.host}/${agent.model}/${agent.effort}`;
    const entry = tally.get(key) ?? { agent, count: 0 };
    entry.count += 1;
    tally.set(key, entry);
  }
  const top = [...tally.values()].sort((a, b) => b.count - a.count)[0];
  return top?.agent ?? DEFAULT_AGENT;
}

/** Reviews changed (or removed) since they were submitted. */
export function changedSinceSubmission(
  submitted: { reviewId: string; version?: number; updatedAt: string }[],
  reviews: Pick<Review, 'id' | 'version' | 'updatedAt'>[],
) {
  const current = new Map(reviews.map((review) => [review.id, review]));
  return submitted
    .filter(({ reviewId, version, updatedAt }) => {
      const review = current.get(reviewId);
      return (
        !review ||
        review.updatedAt !== updatedAt ||
        (version !== undefined && review.version !== version)
      );
    })
    .map(({ reviewId }) => reviewId);
}

// ---------------------------------------------------------------------------
// Global insights reviews: submitted next to the trajectories once completed.

export type GlobalRow = {
  review: Review;
  /** The submission and generation that produced it, from its source path. */
  origin: { submissionId: string; jobId: string } | null;
  reason: string | null;
  counts: ReturnType<typeof decisionCounts>;
};

export function globalOrigin(sourcePath: string) {
  const match = /^submission-(.+)-insights-(.+)$/.exec(sourcePath);
  return match ? { submissionId: match[1], jobId: match[2] } : null;
}

/** Why a global review cannot be submitted, or null. */
export function globalEligibility(review: Review): string | null {
  const open = review.insights.filter(
    (insight) => insight.status !== 'accepted' && insight.status !== 'rejected',
  ).length;
  if (open)
    return `${open} ${open === 1 ? 'card needs' : 'cards need'} a decision.`;
  if (review.status !== 'completed') return 'Not marked complete yet.';
  return null;
}

export function globalRows(reviews: Review[]): GlobalRow[] {
  return reviews
    .filter((review) => review.reviewLevel === 'global')
    .map((review) => ({
      review,
      origin: globalOrigin(review.sourcePath),
      reason: globalEligibility(review),
      counts: decisionCounts([review]),
    }))
    .sort((a, b) => b.review.generatedAt.localeCompare(a.review.generatedAt));
}

/** Completed global reviews are included by default. */
export function defaultGlobalSelection(rows: GlobalRow[]) {
  return rows.filter((row) => !row.reason).map((row) => row.review.id);
}

/**
 * Whether a global review still describes the chosen trajectories: generated
 * from a submission of exactly these reviews, none edited since.
 */
export function globalCurrent(
  row: GlobalRow,
  submissions: {
    id: string;
    reviews: { reviewId: string; version?: number; updatedAt: string }[];
  }[],
  reviews: Pick<Review, 'id' | 'version' | 'updatedAt'>[],
  selected: string[],
) {
  const source = submissions.find(
    (submission) => submission.id === row.origin?.submissionId,
  );
  if (!source) return { known: false, current: false, changed: 0 };
  const changed = changedSinceSubmission(source.reviews, reviews).length;
  const sameSet =
    source.reviews.length === selected.length &&
    source.reviews.every((item) => selected.includes(item.reviewId));
  return { known: true, current: changed === 0 && sameSet, changed };
}
