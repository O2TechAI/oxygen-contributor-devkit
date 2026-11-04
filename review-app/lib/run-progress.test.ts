import assert from 'node:assert/strict';
import test from 'node:test';

import type { TrajectoryState } from './oxygen-api.ts';
import {
  averageSeconds,
  describeError,
  formatBytes,
  formatDuration,
  runCounts,
  runFraction,
  stepState,
  timeAgo,
} from './run-progress.ts';

function item(patch: Partial<TrajectoryState>): TrajectoryState {
  return {
    index: 1,
    source: 'claude',
    sessionId: 's',
    startedAt: '2026-01-01T00:00:00.000Z',
    title: 'Fix the export',
    bytes: 100,
    status: 'queued',
    stage: null,
    stagesDone: [],
    stageSeconds: {},
    stageStartedAt: null,
    startedRunAt: null,
    finishedAt: null,
    error: null,
    ...patch,
  };
}

void test('durations read naturally', () => {
  assert.equal(formatDuration(4), '4s');
  assert.equal(formatDuration(65), '1m 05s');
  assert.equal(formatDuration(3725), '1h 02m');
  assert.equal(formatDuration(-3), '0s');
});

void test('sizes are rounded to a readable unit', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2 KB');
  assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MB');
});

void test('relative times', () => {
  const now = Date.parse('2026-03-10T12:00:00Z');
  assert.equal(timeAgo('2026-03-10T11:59:40Z', now), 'just now');
  assert.equal(timeAgo('2026-03-10T11:00:00Z', now), '1 hour ago');
  assert.equal(timeAgo('2026-03-07T12:00:00Z', now), '3 days ago');
  assert.equal(timeAgo('2026-01-01T12:00:00Z', now), '2 months ago');
  assert.equal(timeAgo('not a date', now), '');
  assert.equal(timeAgo(null, now), '');
});

void test('counts and fraction follow every trajectory and stage', () => {
  const list = [
    item({
      status: 'done',
      stagesDone: ['summary', 'insight', 'humanize', 'redaction'],
    }),
    item({ status: 'running', stage: 'insight', stagesDone: ['summary'] }),
    item({ status: 'failed', stagesDone: [] }),
    item({ status: 'queued' }),
  ];
  assert.deepEqual(runCounts(list), {
    total: 4,
    done: 1,
    failed: 1,
    running: 1,
    waiting: 1,
  });
  assert.equal(runFraction(list), 5 / 16);
  assert.equal(runFraction([]), 0);
});

void test('average time counts only finished trajectories', () => {
  assert.equal(averageSeconds([item({ status: 'running' })]), null);
  const done = (seconds: number) =>
    item({
      status: 'done',
      stageSeconds: { summary: seconds, insight: seconds },
    });
  assert.equal(averageSeconds([done(10), done(20), item({})]), 30);
});

void test('each step is done, active, failed or waiting', () => {
  const running = item({
    status: 'running',
    stage: 'insight',
    stagesDone: ['summary'],
  });
  assert.equal(stepState(running, 'summary'), 'done');
  assert.equal(stepState(running, 'insight'), 'active');
  assert.equal(stepState(running, 'humanize'), 'waiting');
  const failed = item({
    status: 'failed',
    stage: 'humanize',
    stagesDone: ['summary', 'insight'],
  });
  assert.equal(stepState(failed, 'humanize'), 'failed');
});

void test('known error codes become sentences and unknown ones pass through', () => {
  assert.equal(describeError(null), '');
  assert.match(describeError('worker_not_complete'), /did not finish/);
  assert.match(
    describeError('worker_exited_1: not logged in'),
    /stopped with an error/,
  );
  assert.equal(describeError('something else'), 'something else');
});
