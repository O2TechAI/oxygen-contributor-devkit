import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  diffLines,
  reviewDiff,
  reviewDiffText,
  type DiffState,
} from './review-diff.ts';

function state(): DiffState {
  return {
    status: 'in_review',
    trajectorySummary: { text: '' },
    summaryGroups: [],
    summaryLines: [{ id: 'L001', text: 'A recorded check.' }],
    insights: [
      {
        id: 'I001',
        title: 'Check before proceeding',
        type: 'agent',
        description: 'Use this when a batch may fail.',
        workflow: 'Check the result.\nContinue only after it passes.',
        example: 'The first batch passed.',
        text: '',
        evidence: ['L001'],
        status: 'accepted',
      },
    ],
  };
}

void test('diff keeps line numbers and reconstruction for line edits', () => {
  const before = 'one\ntwo\nthree\nfour';
  const after = 'one\nnew\nthree\nfour\nfive';
  const lines = diffLines(before, after);
  assert.equal(
    lines
      .filter((line) => line.kind !== 'added')
      .map((line) => line.text)
      .join('\n'),
    before,
  );
  assert.equal(
    lines
      .filter((line) => line.kind !== 'removed')
      .map((line) => line.text)
      .join('\n'),
    after,
  );
  assert.deepEqual(
    lines.filter((line) => line.kind === 'removed'),
    [{ kind: 'removed', text: 'two', oldLine: 2 }],
  );
  assert.deepEqual(
    lines.filter((line) => line.kind === 'added').map((line) => line.newLine),
    [2, 5],
  );
});

void test('card changes retain field headings and actual decisions', () => {
  const before = state();
  const after = structuredClone(before);
  after.insights[0].workflow =
    'Check the result.\nStop and ask for review if it fails.';
  after.insights[0].status = 'pending';
  const diff = reviewDiff(before, after);
  const text = diff
    .flatMap((hunk) => [
      hunk.heading,
      ...hunk.lines.map((line) => `${line.kind}: ${line.text}`),
    ])
    .join('\n');
  assert.match(text, /Workflow:/);
  assert.match(text, /removed: Decision: accepted/);
  assert.match(text, /added: Decision: pending/);
  assert.match(text, /added: Stop and ask/);
});

void test('additions, removals, reordering and reviewer authorship remain visible', () => {
  const before = state();
  const second = {
    ...before.insights[0],
    id: 'I002',
    title: 'Second method',
    authorship: 'reviewer' as const,
  };
  const after = structuredClone(before);
  after.insights.unshift(second);
  assert.match(reviewDiffText(after), /# Insight order\nI002, I001/);
  const added = reviewDiff(before, after)
    .flatMap((hunk) => hunk.lines)
    .filter((line) => line.kind === 'added')
    .map((line) => line.text)
    .join('\n');
  assert.match(added, /Title:\nSecond method/);
  assert.match(added, /Authorship: Reviewer addition/);
  const removed = reviewDiff(after, before)
    .flatMap((hunk) => hunk.lines)
    .filter((line) => line.kind === 'removed')
    .map((line) => line.text)
    .join('\n');
  assert.match(removed, /Second method/);
  const reordered = structuredClone(after);
  reordered.insights.reverse();
  assert.ok(reviewDiff(after, reordered).length > 0);
});

void test('summary changes appear and comment-only snapshots have no diff', () => {
  const before = state();
  assert.deepEqual(reviewDiff(before, structuredClone(before)), []);
  const after = structuredClone(before);
  after.summaryLines[0].text = 'A corrected observation.';
  assert.ok(
    reviewDiff(before, after)
      .flatMap((hunk) => hunk.lines)
      .some(
        (line) =>
          line.kind === 'added' &&
          line.text === 'L001: A corrected observation.',
      ),
  );
});

void test('embedded originals are never rendered, even if an older response includes them', () => {
  const before = {
    ...state(),
    trajectorySummary: { text: '', originalText: 'PRIVATE ORIGINAL' },
    insights: state().insights.map((insight) => ({
      ...insight,
      originalText: 'PRIVATE ORIGINAL',
    })),
  };
  assert.doesNotMatch(reviewDiffText(before), /PRIVATE ORIGINAL/);
  assert.deepEqual(reviewDiff(before, state()), []);
});

void test('large changed blocks use a bounded diff and preserve all changed lines', () => {
  const before = Array.from({ length: 1500 }, (_, i) => `old ${i}`).join('\n');
  const after = Array.from({ length: 1500 }, (_, i) => `new ${i}`).join('\n');
  const lines = diffLines(before, after);
  assert.equal(lines.filter((line) => line.kind === 'removed').length, 1500);
  assert.equal(lines.filter((line) => line.kind === 'added').length, 1500);
});
