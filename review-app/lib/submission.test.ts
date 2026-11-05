import assert from 'node:assert/strict';
import test from 'node:test';
import type { Review } from './review-types.ts';
import {
  changedSinceSubmission,
  DEFAULT_AGENT,
  defaultSubmissionSelection,
  selectionProblem,
  submissionEligibility,
  submissionRows,
  suggestedAgent,
  visibleSubmissionRows,
  toggleSubmission,
  type SubmissionRun,
} from './submission.ts';
import { classifySummaryLines } from './v5-format.ts';

function review(
  id: string,
  {
    run = 'run-a',
    number = '001',
    privacyStatus = 'redacted',
    status = 'completed',
    decisions = ['accepted', 'rejected'],
    updatedAt = '2026-11-01T00:00:00.000Z',
    ...rest
  }: Partial<Review> & {
    run?: string;
    number?: string;
    decisions?: string[];
  } = {},
): Review {
  return {
    id,
    projectName: 'Project',
    sourcePath: `${run}-trajectory-${number}-${privacyStatus}`,
    status,
    generatedAt: '',
    updatedAt,
    revisionCount: 1,
    version: 2,
    format: 'v5',
    protocolVersion: 9,
    stage: privacyStatus === 'redacted' ? 'redaction' : 'humanize',
    privacyStatus,
    provenance: { hashVerified: false, runComplete: true },
    trajectorySummary: { text: '', originalText: '' },
    summaryGroups: [],
    summaryLines: classifySummaryLines(`# Session ${id}\n`),
    insights: decisions.map((decision, index) => ({
      id: `I00${index + 1}`,
      title: 'Card',
      text: '',
      originalText: '',
      evidence: [],
      status: decision as Review['insights'][number]['status'],
    })),
    ...rest,
  };
}

void test('eligibility gives the first reason a review cannot be submitted', () => {
  assert.equal(submissionEligibility(review('ok')), null);
  assert.match(
    submissionEligibility({ ...review('g'), reviewLevel: 'global' })!,
    /Global insights/,
  );
  assert.match(
    submissionEligibility(review('old', { protocolVersion: 7 }))!,
    /older format/,
  );
  assert.equal(
    submissionEligibility(review('u', { privacyStatus: 'unredacted' })),
    null,
  );
  assert.equal(
    submissionEligibility(
      review('p', {
        status: 'in_review',
        decisions: ['accepted', 'pending', 'needs_review'],
      }),
    ),
    '2 cards need a decision.',
  );
  assert.equal(
    submissionEligibility(review('c', { status: 'in_review' })),
    'Not marked complete yet.',
  );
});

void test('rows list both versions of each generation and skip drafts and global reviews', () => {
  const rows = submissionRows([
    review('humanized', { privacyStatus: 'unredacted' }),
    review('redacted'),
    review('draft', {
      number: '002',
      privacyStatus: 'unredacted',
      stage: 'insight',
    }),
    { ...review('global', { run: 'x' }), reviewLevel: 'global' },
    review('open', {
      number: '003',
      status: 'in_review',
      decisions: ['pending'],
    }),
    review('open-u', {
      number: '003',
      privacyStatus: 'unredacted',
      status: 'in_review',
      decisions: ['pending'],
    }),
  ]);
  assert.deepEqual(
    rows.map((row) => [row.review.id, row.version, row.reason === null]),
    [
      ['redacted', 'redacted', true],
      ['humanized', 'unredacted', true],
      ['open', 'redacted', false],
      ['open-u', 'unredacted', false],
    ],
  );
  assert.equal(rows[0].title, 'Session redacted');
  // Listed: every submittable version, else the trajectory's main review with its reason.
  assert.deepEqual(
    visibleSubmissionRows(rows).map((row) => row.review.id),
    ['redacted', 'humanized', 'open'],
  );
  // A redacted completion is chosen over an unredacted one.
  assert.deepEqual(defaultSubmissionSelection(rows), ['redacted']);
});

void test('a trajectory labeled only in its unredacted version is still checked by default', () => {
  const rows = submissionRows([
    review('r', { status: 'in_review', decisions: ['pending'] }),
    review('u', { privacyStatus: 'unredacted' }),
  ]);
  assert.deepEqual(defaultSubmissionSelection(rows), ['u']);
  assert.match(selectionProblem(rows, ['u', 'r'])!, /needs a decision/);
});

const runs: SubmissionRun[] = [
  {
    id: 'a',
    host: 'codex',
    model: 'gpt-6.1-terra',
    effort: 'low',
    trajectories: [{ index: 1, source: 'codex', sessionId: 'S1' }],
  },
  {
    id: 'b',
    host: 'codex',
    model: 'gpt-6.1-terra',
    effort: 'low',
    trajectories: [
      { index: 1, source: 'codex', sessionId: 'S1' },
      { index: 2, source: 'claude', sessionId: 'S2' },
    ],
  },
  { id: 'c', host: 'claude', model: 'opus', effort: '' },
];

void test('copies of one session across runs form one group and the newest is chosen by default', () => {
  const reviews = [
    review('a1', { run: 'run-a', updatedAt: '2026-11-01T00:00:00.000Z' }),
    review('b1', { run: 'run-b', updatedAt: '2026-11-03T00:00:00.000Z' }),
    review('b2', { run: 'run-b', number: '002' }),
    review('pending', { run: 'run-b', number: '003', status: 'in_review' }),
  ];
  const rows = submissionRows(reviews, runs);
  const group = (id: string) => rows.find((row) => row.review.id === id)!.group;
  assert.equal(group('a1'), group('b1'));
  assert.notEqual(group('a1'), group('b2'));
  assert.deepEqual(defaultSubmissionSelection(rows), ['b1', 'b2']);
});

void test('a verified input hash also joins copies', () => {
  const provenance = {
    hashVerified: true,
    runComplete: true,
    inputSha256: 'A'.repeat(64),
  };
  const rows = submissionRows([
    review('x', { run: 'run-x', provenance }),
    review('y', {
      run: 'run-y',
      provenance: { ...provenance, inputSha256: 'a'.repeat(64) },
    }),
  ]);
  assert.equal(rows[0].group, rows[1].group);
  assert.equal(defaultSubmissionSelection(rows).length, 1);
});

void test('checking one copy unchecks the other; ineligible rows cannot be checked', () => {
  const rows = submissionRows(
    [
      review('a1', { run: 'run-a' }),
      review('b1', { run: 'run-b', updatedAt: '2026-11-03T00:00:00.000Z' }),
      review('b2', { run: 'run-b', number: '002', status: 'in_review' }),
    ],
    runs,
  );
  let selected = defaultSubmissionSelection(rows);
  assert.deepEqual(selected, ['b1']);
  selected = toggleSubmission(selected, rows, 'a1');
  assert.deepEqual(selected, ['a1']);
  assert.deepEqual(toggleSubmission(selected, rows, 'b2'), ['a1']);
  assert.deepEqual(toggleSubmission(selected, rows, 'a1'), []);
});

void test('the server-side selection check refuses empty, ineligible, missing and duplicate-session selections', () => {
  const rows = submissionRows(
    [
      review('a1', { run: 'run-a' }),
      review('b1', { run: 'run-b' }),
      review('b2', { run: 'run-b', number: '002', status: 'in_review' }),
    ],
    runs,
  );
  assert.equal(selectionProblem(rows, ['a1']), null);
  assert.match(selectionProblem(rows, [])!, /at least one/);
  assert.match(selectionProblem(rows, ['b2'])!, /Not marked complete/);
  assert.match(selectionProblem(rows, ['gone'])!, /no longer available/);
  assert.match(selectionProblem(rows, ['a1', 'b1'])!, /same session/);
  assert.match(selectionProblem(rows, ['a1', 'a1'])!, /twice/);
});

void test('the suggested worker is the one most chosen trajectories were made with', () => {
  const rows = submissionRows(
    [
      review('a1', { run: 'run-a' }),
      review('b2', { run: 'run-b', number: '002' }),
      review('c1', { run: 'run-c' }),
    ],
    runs,
  );
  assert.deepEqual(suggestedAgent(rows, runs), {
    host: 'codex',
    model: 'gpt-6.1-terra',
    effort: 'low',
  });
  const imported = submissionRows([
    review('i', {
      run: 'other',
      provenance: {
        hashVerified: false,
        runComplete: true,
        model: 'opus',
        reasoningEffort: 'high',
      },
    }),
  ]);
  assert.deepEqual(suggestedAgent(imported), {
    host: 'claude',
    model: 'opus',
    effort: 'high',
  });
  assert.deepEqual(suggestedAgent([]), DEFAULT_AGENT);
});

void test('reviews edited or removed after submission are reported', () => {
  const submitted = [
    { reviewId: 'same', version: 2, updatedAt: 't1' },
    { reviewId: 'edited', version: 2, updatedAt: 't1' },
    { reviewId: 'removed', version: 2, updatedAt: 't1' },
  ];
  assert.deepEqual(
    changedSinceSubmission(submitted, [
      { id: 'same', version: 2, updatedAt: 't1' },
      { id: 'edited', version: 3, updatedAt: 't2' },
    ]),
    ['edited', 'removed'],
  );
});

void test('a generic first heading such as Overview is skipped in titles', () => {
  const [row] = submissionRows([
    review('t', {
      summaryLines: classifySummaryLines(
        '# 会话概览\n\nText.\n\n# 对原有流程的审查\n',
      ),
    }),
  ]);
  assert.equal(row.title, '对原有流程的审查');
});

void test('completed global insights are offered and known to be current while their trajectories are unchanged', async () => {
  const { globalRows, defaultGlobalSelection, globalCurrent, globalOrigin } =
    await import('./submission.ts');
  const global = (
    id: string,
    status: Review['status'],
    decisions: string[],
  ) => ({
    ...review(id, { status, decisions }),
    reviewLevel: 'global' as const,
    sourcePath: 'submission-S1-insights-J1',
  });
  const done = global('g-done', 'completed', ['accepted', 'rejected']);
  const open = global('g-open', 'in_review', ['accepted', 'pending']);
  const rows = globalRows([review('t1'), done, open]);
  assert.deepEqual(rows.map((row) => row.review.id).sort(), [
    'g-done',
    'g-open',
  ]);
  assert.deepEqual(defaultGlobalSelection(rows), ['g-done']);
  assert.deepEqual(globalOrigin('submission-S1-insights-J1'), {
    submissionId: 'S1',
    jobId: 'J1',
  });
  const t1 = review('t1');
  const submissions = [
    {
      id: 'S1',
      reviews: [
        { reviewId: 't1', version: t1.version, updatedAt: t1.updatedAt },
      ],
    },
  ];
  const doneRow = rows.find((row) => row.review.id === 'g-done')!;
  assert.deepEqual(globalCurrent(doneRow, submissions, [t1], ['t1']), {
    known: true,
    current: true,
    changed: 0,
  });
  // Edited since, or a different set of trajectories: not current.
  assert.equal(
    globalCurrent(doneRow, submissions, [{ ...t1, updatedAt: 'later' }], ['t1'])
      .current,
    false,
  );
  assert.equal(
    globalCurrent(doneRow, submissions, [t1], ['t1', 't2']).current,
    false,
  );
  assert.equal(globalCurrent(doneRow, [], [t1], ['t1']).known, false);
});
