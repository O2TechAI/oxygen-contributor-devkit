import assert from 'node:assert/strict';
import test from 'node:test';
import type { Review } from './review-types.ts';
import { reviewLabels } from './review-label.ts';
import { classifySummaryLines } from './v5-format.ts';

void test('distinguishes same-project trajectories, stages, reruns, and duplicate imports', () => {
  const base = {
    projectName: 'example-project',
    summaryLines: classifySummaryLines('# Simulator audit\n'),
    privacyStatus: 'redacted',
  } as Review;
  const reviews = [
    {
      ...base,
      id: 'a',
      sourcePath: 'run-20260101T120000Z-trajectory-009-redacted',
    },
    {
      ...base,
      id: 'b',
      sourcePath: 'run-20260101T120000Z-trajectory-021-redacted',
    },
    {
      ...base,
      id: 'c',
      sourcePath: 'run-20260101T120000Z-trajectory-009-original',
      privacyStatus: 'unredacted' as const,
    },
    {
      ...base,
      id: 'd',
      sourcePath: 'run-20260102T120000Z-trajectory-009-redacted',
    },
    {
      ...base,
      id: 'e',
      sourcePath: 'run-20260101T120000Z-trajectory-009-redacted',
    },
  ];
  const labels = reviewLabels(reviews);
  assert.equal(new Set(labels.values()).size, reviews.length);
  assert.match(
    labels.get('a')!,
    /^Trajectory 009 · Simulator audit · Redacted/,
  );
  assert.match(labels.get('b')!, /^Trajectory 021/);
  assert.match(labels.get('c')!, /Original/);
  assert.match(labels.get('d')!, /20260102/);
  assert.equal(reviews[0].projectName, 'example-project');
});

void test('uses meaningful headings and avoids repeating existing trajectory labels', () => {
  const base = {
    projectName: 'Trajectory 021 · Earlier run · Redacted',
    summaryLines: classifySummaryLines(
      '# Overview\n\n## Summary workflow improvements\n',
    ),
    privacyStatus: 'redacted',
    sourcePath: 'run-20260101T120000Z-trajectory-021-redacted',
  } as Review;
  const labels = reviewLabels([
    { ...base, id: 'heading' },
    { ...base, id: 'fallback', summaryLines: [] },
    {
      ...base,
      id: 'project',
      projectName: 'example-project',
      summaryLines: [],
      sourcePath: 'run-20260101T120000Z',
    },
  ]);
  assert.match(
    labels.get('heading')!,
    /^Trajectory 021 · Summary workflow improvements · Redacted/,
  );
  assert.match(
    labels.get('fallback')!,
    /^Trajectory 021 · Earlier run · Redacted/,
  );
  assert.match(labels.get('project')!, /^example-project · Redacted/);
});
