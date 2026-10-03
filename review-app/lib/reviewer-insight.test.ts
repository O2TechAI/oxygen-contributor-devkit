import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseReviewerInsight,
  reviewerInsightDraft,
} from './reviewer-insight.ts';
import { classifySummaryLines } from './v5-format.ts';
import { isValidPayload, isValidV5Review } from './review-validation.ts';
import type { Review, ReviewSavePayload } from './review-types.ts';

const lines = classifySummaryLines(
  '# Context\n\nThe user asked to verify first.\n',
);
const draft =
  'Title: Verify before acting\nType: user explicit\nScope: This project; a temporary requirement.\nTakeaway:\n\n**Check first:** Verify the café result before relying on it; the user asked for this check.\n\n**Keep the limit:** The follow-up remains a proposal, not a measured outcome.';
const base: Review = {
  id: 'reviewer-test',
  projectName: 'Reviewer additions',
  sourcePath: 'test',
  status: 'ready',
  generatedAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  revisionCount: 0,
  format: 'v5',
  protocolVersion: 7,
  stage: 'redaction',
  privacyStatus: 'redacted',
  provenance: { hashVerified: false, runComplete: true },
  trajectorySummary: { originalText: '', text: '' },
  summaryGroups: [],
  summaryLines: lines,
  insights: [],
};
function payload(
  card = parseReviewerInsight('I001', draft, lines),
): ReviewSavePayload {
  return {
    trajectorySummary: { originalText: '', text: '' },
    summaryGroups: [],
    summaryLines: lines,
    insights: [{ ...card, status: 'accepted' }],
    status: 'completed',
    note: 'Reviewer addition.',
  };
}

void test('pastes a current-format card with optional header/fence and evidence, preserving paragraphs', () => {
  for (const input of [
    draft,
    `${draft}\n\nEvidence:`,
    `# I009\n\n${draft}`,
    `\`\`\`markdown\n${draft}\n\`\`\``,
  ]) {
    const card = parseReviewerInsight('I004', input, lines);
    assert.equal(card.id, 'I004');
    assert.equal(card.authorship, 'reviewer');
    assert.equal(card.sourceId, undefined);
    assert.equal(card.status, 'pending');
    assert.deepEqual(card.evidence, []);
    assert.match(card.takeaway!, /\n\n\*\*Keep the limit:/);
    const reread = parseReviewerInsight(
      'I004',
      reviewerInsightDraft(card),
      lines,
    );
    assert.equal(reread.takeaway, card.takeaway);
    assert.equal(reread.scope, card.scope);
  }
  assert.deepEqual(
    parseReviewerInsight('I001', `${draft}\n\nEvidence: L003`, lines).evidence,
    ['L003'],
  );
});

void test('rejects multiple cards, invalid references, empty required fields, and arbitrary text', () => {
  for (const input of [
    '',
    'My arbitrary note',
    draft.replace('Title: Verify before acting', 'Title:'),
    draft.replace('Type: user explicit', 'Type: invented'),
    draft.replace('Scope: This project; a temporary requirement.\n', ''),
    draft.replace(/Takeaway:[\s\S]*/, 'Takeaway:\n\nEvidence:'),
    `${draft}\n\nEvidence: L001`,
    `${draft}\n\nEvidence: L999`,
    `${draft}\n\nEvidence: L003, L003`,
    `# I001\n${draft}\n\nEvidence:\n\n# I002\n${draft}`,
  ]) {
    assert.throws(() => parseReviewerInsight('I001', input, lines));
  }
});

void test('accepts uncited reviewer cards through revision validation, while keeping generated evidence checks', () => {
  const value = payload();
  assert.equal(isValidPayload(value), true);
  assert.equal(isValidV5Review(base, value), true);
  assert.equal(
    isValidV5Review(base, {
      ...value,
      insights: [{ ...value.insights[0], authorship: undefined }],
    }),
    false,
  );
  assert.equal(
    isValidV5Review(base, {
      ...value,
      insights: [{ ...value.insights[0], evidence: ['L001'] }],
    }),
    false,
  );
  assert.equal(
    isValidV5Review(base, {
      ...value,
      insights: [{ ...value.insights[0], evidence: ['L999'] }],
    }),
    false,
  );
  assert.equal(
    isValidV5Review({ ...base, privacyStatus: 'unredacted' }, value),
    false,
  );
});
