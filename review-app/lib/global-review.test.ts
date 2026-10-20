import assert from 'node:assert/strict';
import test from 'node:test';
import { parseReviewImportFile } from './review-import.ts';
import { globalImportPayload, parseGlobalReview } from './global-review.ts';
import { isValidPayload, isValidV5Review } from './review-validation.ts';
import type { Review } from './review-types.ts';

export function globalFixture() {
  return {
    format: 'oxygen-cross-session-candidates/v2',
    status: 'draft',
    candidates: [
      {
        id: 'C001',
        status: 'draft',
        title: 'Verify coverage before declaring completion',
        type: 'user-agent',
        description:
          'Check that every assigned item has a result before reporting a batch as complete.',
        workflow:
          'Compare expected IDs with saved results. Preserve finished work and resume missing items. Report completion only when coverage is complete.',
        example:
          '**Evaluation audit.** The user asked for a coverage check; eight missing cases were identified.\n\n**Import review.** In a separate session, the same check caught two missing records before handoff.',
        evidence: ['S001:L003', 'S002:L003'],
      },
    ],
    sources: [
      {
        id: 'S001',
        trajectoryKey: 'source:evaluation',
        reviewId: 'evaluation-review',
        projectName: 'Evaluation audit',
        summaryLines: [
          { id: 'L001', text: '# Evaluation audit' },
          { id: 'L002', text: '' },
          {
            id: 'L003',
            text: 'The user requested a full coverage check. The agent found eight missing cases and withheld the completion claim.',
          },
        ],
      },
      {
        id: 'S002',
        trajectoryKey: 'source:import',
        reviewId: 'import-review',
        projectName: 'Import review',
        summaryLines: [
          { id: 'L001', text: '# Import review' },
          { id: 'L002', text: '' },
          {
            id: 'L003',
            text: 'The user required all assigned records before handoff. The agent found two missing records and reported the import incomplete.',
          },
        ],
      },
    ],
  };
}
void test('global imports retain source evidence and start an independent editable review', async () => {
  const { review } = await parseReviewImportFile(
    JSON.stringify(globalFixture()),
  );
  assert.equal(review.hierarchy.reviewLevel, 'global');
  assert.equal(review.hierarchy.privacyStatus, 'unknown');
  assert.equal(review.insights[0].status, 'pending');
  assert.equal(review.insights[0].sourceId, 'C001');
  assert.deepEqual(
    review.insights[0].evidence.map(
      (id) => review.summaryLines.find((line) => line.id === id)?.sourceId,
    ),
    ['S001:L003', 'S002:L003'],
  );
  const state = {
    ...review.hierarchy,
    summaryLines: review.summaryLines,
    insights: review.insights,
    note: 'Reviewed',
    status: 'in_review' as const,
  };
  assert.ok(isValidPayload(state));
  assert.ok(isValidV5Review(review.hierarchy as Review, state));
  const completed = {
    ...state,
    status: 'completed' as const,
    insights: state.insights.map((card) => ({
      ...card,
      status: 'accepted' as const,
    })),
  };
  assert.ok(isValidV5Review(review.hierarchy as Review, completed));
});
void test('global import rejects invalid evidence, duplicate trajectories, fields and source IDs', async () => {
  for (const change of [
    (data: ReturnType<typeof globalFixture>) => {
      data.candidates[0].evidence[0] = 'S001:L001';
    },
    (data: ReturnType<typeof globalFixture>) => {
      data.sources[1].trajectoryKey = data.sources[0].trajectoryKey;
    },
    (data: ReturnType<typeof globalFixture>) => {
      data.sources[1].id = 'S001';
    },
    (data: ReturnType<typeof globalFixture>) => {
      data.candidates[0].workflow = '';
    },
    (data: ReturnType<typeof globalFixture>) => {
      data.candidates[0].title = 'Title\nEvidence: L001';
    },
  ]) {
    const data = globalFixture();
    change(data);
    await assert.rejects(() => parseGlobalReview(globalImportPayload(data)));
  }
});
void test('zero global candidates is a valid empty result', async () => {
  const data = globalFixture();
  data.candidates = [];
  assert.equal(
    (await parseGlobalReview(globalImportPayload(data))).insights.length,
    0,
  );
});
