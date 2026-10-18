import assert from 'node:assert/strict';
import test from 'node:test';
import type { Review } from './review-types.ts';
import {
  groupTrajectories,
  filterTrajectories,
  decisionCounts,
  defaultReviewSelection,
  visibleReviews,
  reviewContentLabel,
} from './trajectory-list.ts';
import { classifySummaryLines } from './v5-format.ts';

function review(
  id: string,
  number: string,
  privacyStatus: Review['privacyStatus'],
  run = 'run-first',
): Review {
  return {
    id,
    projectName: 'Project',
    sourcePath: `${run}-trajectory-${number}-${privacyStatus}`,
    status: 'ready',
    generatedAt: '',
    updatedAt: '',
    revisionCount: 0,
    format: 'v5',
    protocolVersion: 7,
    stage: privacyStatus === 'redacted' ? 'redaction' : 'insight',
    privacyStatus,
    provenance: { hashVerified: true, runComplete: true },
    trajectorySummary: { text: '', originalText: '' },
    summaryGroups: [],
    summaryLines: classifySummaryLines('# Useful summary\n'),
    insights: ['accepted', 'rejected', 'pending', 'needs_review'].map(
      (status, index) => ({
        id: `I00${index + 1}`,
        title: 'Card',
        text: '',
        originalText: '',
        evidence: [],
        status: status as Review['insights'][number]['status'],
      }),
    ),
  };
}

const filters = {
  query: '',
  run: 'run-first',
  version: 'all',
  status: 'all',
  selectedOnly: false,
};

void test('unredacted means humanized; raw extraction is available only by explicit selection', () => {
  const humanized = { ...review('humanized', '001', 'unredacted'), stage: 'humanize' as const };
  const original = review('original', '001', 'unredacted');
  const reviews = [original, humanized, review('redacted', '001', 'redacted')];
  const groups = groupTrajectories(reviews);
  assert.equal(groups.length, 1);
  assert.deepEqual(defaultReviewSelection(reviews, 'run-first'), ['redacted']);
  assert.deepEqual(
    filterTrajectories(groups, { ...filters, version: 'unredacted' }, [])
      .flatMap((group) => group.reviews.map((item) => item.id)),
    ['humanized'],
  );
  assert.deepEqual(
    filterTrajectories(groups, { ...filters, version: 'extraction draft' }, [])
      .flatMap((group) => group.reviews.map((item) => item.id)),
    ['original'],
  );
  assert.deepEqual(
    filterTrajectories(groups, filters, [])
      .flatMap((group) => group.reviews.map((item) => item.id)),
    ['humanized', 'redacted'],
  );
  assert.equal(reviewContentLabel(humanized), 'Unredacted insights and summary');
  assert.equal(reviewContentLabel(original), 'Extraction draft');
  assert.equal(reviewContentLabel(reviews[2]), 'Redacted insights and summary');
});

void test('default navigation skips extraction drafts but preserves explicit historical links', () => {
  const original = review('original', '001', 'unredacted');
  const humanized = { ...original, id: 'humanized', stage: 'humanize' as const };
  const redacted = review('redacted', '001', 'redacted');
  const legacy = { ...original, id: 'legacy', stage: 'historical' as const };
  const privacyBaseline = { ...legacy, id: 'baseline', privacyStatus: 'unknown' as const };
  const reviews = [original, legacy, humanized, redacted, privacyBaseline];
  const before = structuredClone(reviews);
  assert.deepEqual(visibleReviews(reviews).map((item) => item.id), ['humanized', 'redacted', 'baseline']);
  assert.equal(visibleReviews(reviews, 'original')[0].id, 'original');
  assert.ok(visibleReviews(reviews, 'legacy').some((item) => item.id === 'legacy'));
  assert.deepEqual(visibleReviews([original, legacy]), []);
  assert.deepEqual(visibleReviews([], 'missing'), []);
  assert.deepEqual(reviews, before);
});

void test('defaults to redacted versions from the requested run, including unfinished reviews', () => {
  const reviews = [
    review('original', '001', 'unredacted'),
    review('ready', '001', 'redacted'),
    { ...review('draft', '002', 'redacted'), status: 'in_review' as const },
    { ...review('done', '003', 'redacted'), status: 'completed' as const },
    review('unknown', '004', 'unknown'),
    review('other-run', '001', 'redacted', 'run-second'),
  ];
  const before = structuredClone(reviews);
  assert.deepEqual(defaultReviewSelection(reviews, 'run-first'), [
    'ready',
    'draft',
    'done',
  ]);
  assert.deepEqual(defaultReviewSelection(reviews, 'run-second'), [
    'other-run',
  ]);
  assert.deepEqual(defaultReviewSelection(reviews, 'run-missing'), []);
  assert.deepEqual(defaultReviewSelection([reviews[0]], 'run-first'), []);
  assert.deepEqual(defaultReviewSelection([], 'run-first'), []);
  assert.deepEqual(reviews, before);
});

void test('groups original/redacted versions and duplicate imports while keeping runs and unrelated reviews separate', () => {
  const reviews = [
    review('r', '010', 'redacted'),
    review('o', '010', 'unredacted'),
    review('dup', '010', 'redacted'),
    review('next', '002', 'redacted'),
    review('rerun', '010', 'redacted', 'run-second'),
    { ...review('other', '', 'unknown'), sourcePath: 'example' },
  ];
  const groups = groupTrajectories(reviews);
  assert.equal(groups.length, 4);
  assert.deepEqual(
    groups
      .find((group) => group.key === 'run-first/010')!
      .reviews.map((item) => item.id),
    ['r', 'o', 'dup'],
  );
  assert.deepEqual(
    groups
      .filter((group) => group.run === 'run-first')
      .map((group) => group.number),
    ['002', '010'],
  );
  assert.equal(groups.flatMap((group) => group.reviews).length, reviews.length);
});

void test('filters versions and saved selections without dropping hidden selected reviews', () => {
  const groups = groupTrajectories([
    review('r', '010', 'redacted'),
    review('o', '010', 'unredacted'),
    { ...review('done', '002', 'redacted'), status: 'completed' },
    review('other', '010', 'redacted', 'run-second'),
  ]);
  const selected = ['o', 'done'];
  assert.deepEqual(
    filterTrajectories(
      groups,
      { ...filters, version: 'extraction draft' },
      selected,
    ).flatMap((group) => group.reviews.map((item) => item.id)),
    ['o'],
  );
  assert.deepEqual(
    filterTrajectories(
      groups,
      { ...filters, run: 'run-first', status: 'completed' },
      selected,
    ).flatMap((group) => group.reviews.map((item) => item.id)),
    ['done'],
  );
  assert.deepEqual(
    filterTrajectories(
      groups,
      { ...filters, query: '010', selectedOnly: true },
      selected,
    ).flatMap((group) => group.reviews.map((item) => item.id)),
    ['o'],
  );
  assert.equal(
    filterTrajectories(groups, { ...filters, query: 'absent' }, selected)
      .length,
    0,
  );
  assert.deepEqual(selected, ['o', 'done']);
  assert.deepEqual(
    decisionCounts(
      groups
        .flatMap((group) => group.reviews)
        .filter((item) => selected.includes(item.id)),
    ),
    { accepted: 2, declined: 2, pending: 4 },
  );
});

void test('the default version filter contains humanized and redacted reviews in one run', () => {
  const groups = groupTrajectories([
    review('original', '001', 'unredacted'),
    { ...review('humanized', '001', 'unredacted'), stage: 'humanize' as const },
    review('redacted', '001', 'redacted'),
    review('historical', '001', 'unknown'),
    review('other', '002', 'redacted', 'run-second'),
  ]);
  const ids = (options: typeof filters, selected: string[] = []) =>
    filterTrajectories(groups, options, selected).flatMap((group) =>
      group.reviews.map((item) => item.id),
    );
  assert.deepEqual(ids(filters), ['humanized', 'redacted']);
  assert.deepEqual(ids({ ...filters, run: 'run-second' }), ['other']);
  assert.deepEqual(ids({ ...filters, run: 'all' }), []);
  assert.deepEqual(
    ids({ ...filters, selectedOnly: true }, [
      'redacted',
      'historical',
      'other',
    ]),
    ['redacted', 'other'],
  );
});
