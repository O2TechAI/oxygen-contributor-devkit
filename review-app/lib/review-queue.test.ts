import assert from 'node:assert/strict';
import test from 'node:test';
import type { InsightStatus, Review } from './review-types.ts';
import {
  evidencePlainText,
  neighbour,
  nextUndecided,
  queueSummary,
} from './review-queue.ts';

function review(
  id: string,
  statuses: InsightStatus[],
  status: Review['status'] = 'in_review',
): Review {
  return {
    id,
    status,
    insights: statuses.map((insightStatus, index) => ({
      id: `I00${index + 1}`,
      title: 'Card',
      text: '',
      originalText: '',
      evidence: [],
      status: insightStatus,
    })),
  } as unknown as Review;
}

const at = (reviewId: string, insightId: string) => ({ reviewId, insightId });

void test('next undecided skips decided cards and continues into the next review', () => {
  const reviews = [
    review('a', ['pending', 'accepted']),
    review('b', ['rejected', 'needs_review']),
  ];
  assert.deepEqual(nextUndecided(reviews, at('a', 'I001')), at('b', 'I002'));
});

void test('next undecided wraps to earlier cards and ends with null when everything is decided', () => {
  const reviews = [
    review('a', ['pending', 'accepted']),
    review('b', ['accepted']),
  ];
  assert.deepEqual(nextUndecided(reviews, at('b', 'I001')), at('a', 'I001'));
  const done = [review('a', ['accepted', 'rejected'])];
  assert.equal(nextUndecided(done, at('a', 'I001')), null);
});

void test('next undecided never returns cards of completed reviews', () => {
  const reviews = [
    review('a', ['pending']),
    review('done', ['pending'], 'completed'),
  ];
  assert.deepEqual(nextUndecided(reviews, at('a', 'I001')), at('a', 'I001'));
});

void test('neighbour steps across reviews and stops at both ends', () => {
  const reviews = [
    review('a', ['pending']),
    review('b', ['pending', 'pending']),
  ];
  assert.deepEqual(neighbour(reviews, at('a', 'I001'), 1), at('b', 'I001'));
  assert.deepEqual(neighbour(reviews, at('b', 'I001'), -1), at('a', 'I001'));
  assert.equal(neighbour(reviews, at('a', 'I001'), -1), null);
  assert.equal(neighbour(reviews, at('b', 'I002'), 1), null);
});

void test('summary counts every card and those still undecided', () => {
  const reviews = [
    review('a', ['pending', 'accepted']),
    review('b', ['needs_review'], 'completed'),
  ];
  assert.deepEqual(queueSummary(reviews), {
    total: 3,
    undecided: 1,
    reviews: 2,
  });
});

void test('evidence lines read as plain text', () => {
  assert.equal(
    evidencePlainText('1. **Keep catalog titles intact.**'),
    'Keep catalog titles intact.',
  );
  assert.equal(
    evidencePlainText('- [x] Preview the reading list'),
    '☑ Preview the reading list',
  );
  assert.equal(evidencePlainText('- [ ] Verify sources'), '☐ Verify sources');
  assert.equal(
    evidencePlainText(
      '| Import | Record sources still need verification | Pending |',
    ),
    'Import · Record sources still need verification · Pending',
  );
  assert.equal(evidencePlainText('|---|---|'), '');
  assert.equal(evidencePlainText('## Findings'), 'Findings');
  assert.equal(
    evidencePlainText('Uses `A Sample Story`.'),
    'Uses A Sample Story.',
  );
});
