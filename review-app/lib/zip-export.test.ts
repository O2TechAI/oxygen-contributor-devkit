import assert from 'node:assert/strict';
import test from 'node:test';
import { collectionFiles, collectionZip } from './zip-export.ts';

const collection = {
  format: 'oxygen-human-review-collection/v1',
  exportedAt: '2026-11-05T00:00:00.000Z',
  reviewCount: 1,
  reviews: [
    {
      reviewId: 'r1',
      sourcePath: 'run-abc-trajectory-002-redacted',
      privacyStatus: 'redacted' as const,
      files: { 'summary.md': '# S\n', 'review.json': '{}' },
    },
  ],
};

void test('the collection layout puts each review in its run and trajectory folder', () => {
  const files = collectionFiles(collection);
  const folder = 'run-abc/trajectory-002/redacted-1-r1';
  assert.deepEqual(Object.keys(files).sort(), [
    'manifest.json',
    `${folder}/review.json`,
    `${folder}/summary.md`,
  ]);
  const manifest = JSON.parse(files['manifest.json']);
  assert.equal(manifest.reviews[0].directory, folder);
  assert.deepEqual(manifest.reviews[0].files, ['summary.md', 'review.json']);
  assert.ok(collectionZip(collection).byteLength > 0);
});
