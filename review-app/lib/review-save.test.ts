import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Autosave } from './autosave.ts';
import { ReviewRevisionClient, type PendingReviewSave } from './review-save.ts';
import type { Review } from './review-types.ts';

function review(id = 'test', version = 4): Review {
  return {
    id,
    version,
    revisionCount: version,
    projectName: 'Test',
    sourcePath: 'synthetic',
    status: 'in_review',
    generatedAt: '',
    updatedAt: '',
    format: 'v5',
    protocolVersion: 9,
    stage: 'redaction',
    privacyStatus: 'redacted',
    provenance: { hashVerified: true, runComplete: true },
    trajectorySummary: { text: '', originalText: '' },
    summaryGroups: [],
    summaryLines: [],
    insights: [],
  };
}

void test('fetch keeps the global receiver required by the browser implementation', async () => {
  const client = new ReviewRevisionClient(
    async function (this: typeof globalThis) {
      assert.equal(this, globalThis);
      return Response.json({
        review: review('test', 5),
        savedVersion: 5,
        requestId: 'browser-save',
      });
    },
  );
  const result = await client.save({
    review: review(),
    note: 'Edit',
    status: 'in_review',
    requestId: 'browser-save',
  });
  assert.equal(result.savedVersion, 5);
});

void test('serialized browser saves advance expected version for edits queued before the first response', async () => {
  const sent: { expectedVersion: number; requestId: string }[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const client = new ReviewRevisionClient(async (_url, options) => {
    assert.equal(typeof options?.body, 'string');
    const body = JSON.parse(options!.body as string) as {
      expectedVersion: number;
      requestId: string;
    };
    sent.push(body);
    if (sent.length === 1) await gate;
    return Response.json({
      review: review('test', body.expectedVersion + 1),
      savedVersion: body.expectedVersion + 1,
      requestId: body.requestId,
    });
  });
  const initial = review();
  client.loaded(initial);
  const queue = new Autosave<PendingReviewSave>(
    async (pending) => {
      await client.save(pending);
    },
    () => {},
    1000,
  );
  queue.enqueue({
    review: initial,
    note: 'First',
    status: 'in_review',
    requestId: 'request-1',
  });
  const saving = queue.flush();
  queue.enqueue({
    review: { ...initial },
    note: 'Second',
    status: 'in_review',
    requestId: 'request-2',
  });
  release();
  assert.equal(await saving, true);
  assert.deepEqual(
    sent.map(({ expectedVersion, requestId }) => ({
      expectedVersion,
      requestId,
    })),
    [
      { expectedVersion: 4, requestId: 'request-1' },
      { expectedVersion: 5, requestId: 'request-2' },
    ],
  );
  assert.equal(client.versionFor(initial), 6);
});

void test('a lost save response retries the same request without inventing a newer expected version', async () => {
  const sent: { expectedVersion: number; requestId: string }[] = [];
  const client = new ReviewRevisionClient(async (_url, options) => {
    assert.equal(typeof options?.body, 'string');
    const body = JSON.parse(options!.body as string) as {
      expectedVersion: number;
      requestId: string;
    };
    sent.push(body);
    if (sent.length === 1) throw new Error('Connection interrupted');
    return Response.json({
      review: review('test', 5),
      savedVersion: 5,
      requestId: body.requestId,
      replayed: true,
    });
  });
  const queue = new Autosave<PendingReviewSave>(
    async (pending) => {
      await client.save(pending);
    },
    () => {},
    1000,
  );
  queue.enqueue({
    review: review(),
    note: 'Edit',
    status: 'in_review',
    requestId: 'same-request',
  });
  assert.equal(await queue.flush(), false);
  assert.equal(await queue.flush(), true);
  assert.deepEqual(
    sent.map(({ expectedVersion, requestId }) => ({
      expectedVersion,
      requestId,
    })),
    [
      { expectedVersion: 4, requestId: 'same-request' },
      { expectedVersion: 4, requestId: 'same-request' },
    ],
  );
});

void test('conflict after another session or privacy cleanup never updates the client version or overwrites the server', async () => {
  let calls = 0;
  const client = new ReviewRevisionClient(async () => {
    calls++;
    return Response.json(
      { error: 'Stale version', currentVersion: 9 },
      { status: 409 },
    );
  });
  const draft = review();
  client.loaded(draft);
  const queue = new Autosave<PendingReviewSave>(
    async (pending) => {
      await client.save(pending);
    },
    () => {},
    1000,
  );
  queue.enqueue({
    review: draft,
    note: 'Edit',
    status: 'in_review',
    requestId: 'stale-request',
  });
  assert.equal(await queue.flush(), false);
  assert.equal(await queue.flush(), false);
  assert.equal(queue.hasPending, true);
  assert.equal(calls, 1);
  assert.equal(client.versionFor(draft), 4);
  client.loaded(review('test', 9));
  queue.discardAfterReconciliation();
  assert.equal(client.versionFor(draft), 9);
});

void test('a removed pre-reset review blocks further autosave retries', async () => {
  let calls = 0;
  const client = new ReviewRevisionClient(async () => {
    calls++;
    return Response.json({ error: 'Review not found.' }, { status: 404 });
  });
  const queue = new Autosave<PendingReviewSave>(
    async (pending) => {
      await client.save(pending);
    },
    () => {},
    1000,
  );
  queue.enqueue({
    review: review(),
    note: 'Old draft',
    status: 'in_review',
    requestId: 'old-draft',
  });
  assert.equal(await queue.flush(), false);
  assert.equal(await queue.flush(), false);
  assert.equal(queue.isConflicted, true);
  assert.equal(calls, 1);
});
