import assert from 'node:assert/strict';
import test from 'node:test';
import type { Review } from './review-types.ts';
import {
  buildTrajectoryIndex,
  counterpart,
  defaultReview,
  formatWhen,
  locate,
  nextSession,
  sessionStatus,
  unfinishedAfter,
  type IndexRun,
} from './trajectory-index.ts';
import { classifySummaryLines } from './v5-format.ts';

function review(
  id: string,
  {
    run = 'run-a',
    number = '001',
    privacyStatus = 'redacted',
    status = 'ready',
    decisions = ['pending'],
    heading = '会话概览',
    updatedAt = '2026-11-01T00:00:00.000Z',
    ...rest
  }: Partial<Review> & {
    run?: string;
    number?: string;
    decisions?: string[];
    heading?: string;
  } = {},
): Review {
  return {
    id,
    projectName: 'Project',
    sourcePath: `${run}-trajectory-${number}-${privacyStatus === 'redacted' ? 'redacted' : 'humanized'}`,
    status,
    generatedAt: '',
    updatedAt,
    revisionCount: 1,
    version: 1,
    format: 'v5',
    protocolVersion: 9,
    stage: privacyStatus === 'redacted' ? 'redaction' : 'humanize',
    privacyStatus,
    provenance: { hashVerified: false, runComplete: true },
    trajectorySummary: { text: '', originalText: '' },
    summaryGroups: [],
    summaryLines: classifySummaryLines(`# ${heading}\n`),
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

const runs: IndexRun[] = [
  {
    id: 'a',
    host: 'codex',
    model: 'gpt-6.1-terra',
    createdAt: '2026-11-04T10:00:00.000Z',
    trajectories: [
      {
        index: 1,
        source: 'codex',
        sessionId: 'S2',
        startedAt: '2026-09-12T00:08:00.000Z',
        name: 'Review pipeline',
      },
    ],
  },
  {
    id: 'b',
    host: 'codex',
    model: 'gpt-6.1-terra',
    createdAt: '2026-11-05T10:00:00.000Z',
    trajectories: [
      {
        index: 1,
        source: 'codex',
        sessionId: 'S2',
        startedAt: '2026-09-12T00:08:00.000Z',
        name: 'Review pipeline',
      },
      {
        index: 2,
        source: 'claude',
        sessionId: 'S1',
        startedAt: '2026-08-24T01:52:00.000Z',
        title: 'Hi',
      },
      {
        index: 3,
        source: 'codex',
        sessionId: 'S3',
        startedAt: '2026-10-20T19:50:00.000Z',
        title: 'Fix it',
      },
    ],
  },
];

void test('generations of one session across runs form one trajectory, oldest session first', () => {
  const index = buildTrajectoryIndex(
    [
      review('a1-r', { run: 'run-a' }),
      review('a1-u', { run: 'run-a', privacyStatus: 'unredacted' }),
      review('b1-r', { run: 'run-b' }),
      review('b2-r', {
        run: 'run-b',
        number: '002',
        heading: '对原有流程的审查',
      }),
      review('b3-u', {
        run: 'run-b',
        number: '003',
        privacyStatus: 'unredacted',
      }),
      review('draft', {
        run: 'run-b',
        number: '003',
        privacyStatus: 'unredacted',
        stage: 'insight',
      }),
      { ...review('global', { run: 'x' }), reviewLevel: 'global' },
      { ...review('imported'), sourcePath: 'catalog-example' },
      { ...review('sample'), sourcePath: 'example/v9-skill-candidates' },
    ],
    runs,
  );
  assert.deepEqual(
    index.sessions.map((session) => [
      session.key,
      session.generations.map((g) => g.run),
    ]),
    [
      ['session:claude:S1', ['run-b']],
      ['session:codex:S2', ['run-b', 'run-a']],
      ['session:codex:S3', ['run-b']],
    ],
  );
  // The agent's own title first, then the Summary heading, then the first request.
  assert.deepEqual(
    index.sessions.map((session) => session.name),
    ['对原有流程的审查', 'Review pipeline', 'Fix it'],
  );
  assert.equal(
    index.sessions[1].label,
    `${formatWhen('2026-09-12T00:08:00.000Z')} · Review pipeline`,
  );
  assert.deepEqual(
    index.global.map((item) => item.id),
    ['global'],
  );
  assert.deepEqual(
    index.other.map((item) => item.id),
    ['imported'],
  );
  const found = locate(index, 'a1-u');
  assert.ok(found?.kind === 'session');
  assert.equal(found.session.key, 'session:codex:S2');
  assert.equal(found.version, 'unredacted');
  assert.equal(counterpart(found.generation, found.version)?.id, 'a1-r');
});

void test('without the local service, verified inputs still join copies and runs give the order', () => {
  const provenance = {
    hashVerified: true,
    runComplete: true,
    inputSha256: 'A'.repeat(64),
  };
  const index = buildTrajectoryIndex([
    review('old', { run: 'run-20261101T000000Z-aa', provenance }),
    review('new', {
      run: 'run-20261102T000000Z-bb',
      provenance: { ...provenance, inputSha256: 'a'.repeat(64) },
    }),
    review('alone', {
      run: 'run-20261103T000000Z-cc',
      heading: 'Specific topic',
    }),
  ]);
  assert.equal(index.sessions.length, 2);
  assert.deepEqual(
    index.sessions[0].generations.map((g) => g.run),
    ['run-20261102T000000Z-bb', 'run-20261101T000000Z-aa'],
  );
  assert.equal(index.sessions[1].label, 'Specific topic');
  assert.equal(index.sessions[0].name, 'Untitled session');
});

void test('the next trajectory is the next unfinished session, wrapping around', () => {
  const index = buildTrajectoryIndex(
    [
      review('s1', {
        run: 'run-b',
        number: '002',
        status: 'completed',
        decisions: ['accepted'],
      }),
      review('s2-old', { run: 'run-a', decisions: ['accepted'] }),
      review('s2-new', { run: 'run-b' }),
      review('s3', {
        run: 'run-b',
        number: '003',
        status: 'completed',
        decisions: ['rejected'],
      }),
    ],
    runs,
  );
  const [s1, s2, s3] = index.sessions;
  assert.deepEqual([s1, s2, s3].map(sessionStatus), [
    'completed',
    'in_progress',
    'completed',
  ]);
  assert.equal(nextSession(index, s3.key)?.key, s2.key);
  assert.equal(nextSession(index, s2.key), null);
  assert.deepEqual(
    unfinishedAfter(index, s1.key).map((s) => s.key),
    [s2.key],
  );
  // The page opens the first unfinished trajectory's newest redacted review.
  assert.equal(defaultReview(index)?.id, 's2-new');
});

void test('an unredacted completion also labels the trajectory', () => {
  const index = buildTrajectoryIndex(
    [
      review('r', { run: 'run-b', number: '003' }),
      review('u', {
        run: 'run-b',
        number: '003',
        privacyStatus: 'unredacted',
        status: 'completed',
      }),
    ],
    runs,
  );
  assert.equal(sessionStatus(index.sessions[0]), 'completed');
  assert.equal(defaultReview(index)?.id, 'r');
});

void test('a session id outranks a shared input hash; the hash only places generations without one', () => {
  const provenance = {
    hashVerified: true,
    runComplete: true,
    inputSha256: 'b'.repeat(64),
  };
  const index = buildTrajectoryIndex(
    [
      // Two different sessions whose reviews happen to share an input hash.
      review('s2', { run: 'run-b', provenance }),
      review('s3', { run: 'run-b', number: '003', provenance }),
      // A generation from a run the service no longer lists.
      review('lost', { run: 'run-20261001T000000Z-zz', provenance }),
    ],
    runs,
  );
  assert.deepEqual(
    index.sessions.map((session) => [session.key, session.generations.length]),
    [
      ['session:codex:S2', 2],
      ['session:codex:S3', 1],
    ],
  );
});
