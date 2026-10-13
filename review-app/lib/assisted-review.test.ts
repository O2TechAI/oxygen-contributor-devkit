import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { register } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openLocalDatabase } from './local-database.ts';
import type {
  Review,
  ReviewPrivacyPayload,
  ReviewSavePayload,
  ReviewWriteResult,
} from './review-types.ts';
import { labelSummary, sha256 } from './v5-format.ts';

function assertNoOriginals(value: unknown) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.notEqual(key, 'originalText');
    assertNoOriginals(child);
  }
}

void test('assisted review saves and sanitizes isolated history atomically', async (t) => {
  const local = openLocalDatabase(
    ':memory:',
    new URL('../drizzle/', import.meta.url),
  );
  let beforeBatch: (() => void) | undefined;
  const db = {
    ...local,
    batch(statements: Parameters<typeof local.batch>[0]) {
      const callback = beforeBatch;
      beforeBatch = undefined;
      callback?.();
      return local.batch(statements);
    },
  };
  const env = {
    DB: db,
    OXYGEN_REVIEW_USERNAME: undefined as string | undefined,
    OXYGEN_REVIEW_PASSWORD: undefined as string | undefined,
  };
  Object.defineProperty(globalThis, '__oxygenAssistedTestEnv', {
    value: env,
    configurable: true,
  });
  register(
    `data:text/javascript,${encodeURIComponent(`
    const base = ${JSON.stringify(new URL('../', import.meta.url).href)};
    const moduleUrl = (source) => 'data:text/javascript,' + encodeURIComponent(source);
    export function resolve(specifier, context, nextResolve) {
      if (specifier === 'cloudflare:workers') return { url: moduleUrl('export const env = globalThis.__oxygenAssistedTestEnv;'), shortCircuit: true };
      if (specifier === '@/lib/sample-data') return { url: moduleUrl('export const sampleReviews = [];'), shortCircuit: true };
      if (specifier.startsWith('@/')) return nextResolve(new URL(specifier.slice(2) + '.ts', base).href, context);
      return nextResolve(specifier, context);
    }
  `)}`,
    import.meta.url,
  );
  t.after(() => {
    local.close();
    Reflect.deleteProperty(globalThis, '__oxygenAssistedTestEnv');
  });
  const api = await import('../db/reviews.ts');
  const route =
    await import('../app/api/reviews/[reviewId]/revisions/route.ts');
  const privacyRoute =
    await import('../app/api/reviews/[reviewId]/privacy/route.ts');
  const summary =
    '# Findings\n\nPERSON_SECRET needs a recorded validation step.\n';
  const cards =
    '# I001\n\nTitle: Validate before publishing\nType: user-agent\nDescription: PERSON_SECRET requires a recorded validation step.\nWorkflow: Inspect the result before publishing.\nExample: This recorded attempt remains unresolved.\nEvidence: L003\n';
  const create = async (name: string) =>
    api.createReview({
      projectName: name,
      sourcePath: 'synthetic-assisted',
      format: 'v5',
      protocolVersion: 9,
      stage: 'redaction',
      summaryMarkdown: summary,
      summaryLabeledMarkdown: labelSummary(summary),
      insightMarkdown: cards,
      manifestJson: JSON.stringify({
        complete: true,
        configuration: { protocol_version: 9 },
        stages: {
          redaction: {
            status: 'complete',
            outputs: {
              sha256: {
                'summary_redacted.md': await sha256(summary),
                'summary_redacted_labeled.md': await sha256(
                  labelSummary(summary),
                ),
                'insight_redacted.md': await sha256(cards),
              },
            },
          },
        },
      }),
    });
  let review = await create('Assisted review');
  const neighbor = await create('Unaffected review');
  const context = { params: Promise.resolve({ reviewId: review.id }) };
  const request = (body: unknown) =>
    new Request('http://localhost/api/reviews/revisions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const payload = (
    state: Review,
    requestId: string,
    note: string,
  ): ReviewSavePayload => ({
    ...state,
    expectedVersion: state.version,
    requestId,
    note,
  });
  let edit: ReviewSavePayload;
  await t.test(
    'exact notes, approval, comment-only requests, and idempotent retry',
    async () => {
      review.insights[0].workflow += '\n\nRecord any unresolved checks.';
      review.insights[0].status = 'accepted';
      edit = payload(
        review,
        'request-edit',
        '  Please clarify PERSON_SECRET’s workflow.\n',
      );
      const response = await route.POST(request(edit), context);
      assert.equal(response.status, 200);
      const first = (await response.json()) as ReviewWriteResult;
      review = first.review;
      assert.equal(first.savedVersion, 1);
      assert.equal(review.insights[0].status, 'accepted');
      review = (
        await api.saveReviewRevision(
          review.id,
          payload(review, 'request-comment', 'I will review this tomorrow.'),
        )
      ).review;
      const history = await api.getReviewHistory(review.id);
      assertNoOriginals(history.snapshots);
      assert.equal(history.snapshots[1].note, edit.note);
      assert.deepEqual(history.snapshots[1].state, history.snapshots[2].state);
      const retry = await api.saveReviewRevision(review.id, edit);
      assert.equal(retry.replayed, true);
      assert.equal(retry.savedVersion, 1);
      assert.equal(retry.review.version, 1);
      assert.equal((await api.getReviewHistory(review.id)).snapshots.length, 3);
      await assert.rejects(
        () =>
          api.saveReviewRevision(review.id, {
            ...edit,
            note: 'Different request.',
          }),
        { status: 409 },
      );
    },
  );
  await t.test(
    'all HTTP clients need versions; simultaneous stale saves never overwrite',
    async () => {
      assert.equal(
        (
          await route.POST(
            request({ ...edit, expectedVersion: undefined }),
            context,
          )
        ).status,
        400,
      );
      assert.equal(
        (
          await route.POST(
            request({ ...edit, requestId: 'stale-browser' }),
            context,
          )
        ).status,
        409,
      );
      const results = await Promise.allSettled([
        api.saveReviewRevision(
          review.id,
          payload(review, 'racing-a', 'Browser edit.'),
        ),
        api.saveReviewRevision(
          review.id,
          payload(review, 'racing-b', 'Agent edit.'),
        ),
      ]);
      assert.equal(
        results.filter((result) => result.status === 'fulfilled').length,
        1,
      );
      assert.equal(
        results.find((result) => result.status === 'rejected')?.reason.status,
        409,
      );
      review = (await api.getReviewHistory(review.id)).review;
      assert.equal(review.version, 3);
    },
  );
  const cleanState = (item: Review) =>
    JSON.parse(
      JSON.stringify({
        trajectorySummary: item.trajectorySummary,
        summaryGroups: item.summaryGroups,
        summaryLines: item.summaryLines,
        insights: item.insights,
        status: item.status,
      }).replaceAll('PERSON_SECRET', 'the reviewer'),
    );
  const resetPayload = (item: Review): ReviewPrivacyPayload => ({
    expectedVersion: item.version!,
    requestId: crypto.randomUUID(),
    projectName: 'Reviewed baseline',
    state: cleanState(item),
  });
  let privacyInput = resetPayload(review);
  const oldId = review.id;
  const oldContext = context;
  await t.test(
    'invalid or historical privacy payloads leave saved state unchanged',
    async () => {
      const before = await api.getReviewHistory(review.id);
      const invalid = resetPayload(review);
      invalid.state.insights[0].evidence = ['L999'];
      assert.equal(
        (await privacyRoute.POST(request(invalid), context)).status,
        400,
      );
      assert.equal(
        (
          await privacyRoute.POST(
            request({
              expectedVersion: review.version,
              requestId: crypto.randomUUID(),
              snapshots: before.snapshots,
            }),
            context,
          )
        ).status,
        400,
      );
      assert.equal(
        (
          await privacyRoute.POST(
            request({ ...invalid, projectName: '' }),
            context,
          )
        ).status,
        400,
      );
      assert.deepEqual(await api.getReviewHistory(review.id), before);
    },
  );
  await t.test(
    'privacy replaces all originals, history and source receipts with one new baseline',
    async () => {
      privacyInput = resetPayload(review);
      const result = await api.sanitizeReviewHistory(review.id, privacyInput);
      review = result.review;
      assert.notEqual(review.id, oldId);
      assert.match(review.id, /^review-[0-9a-f-]{36}$/);
      assert.equal(review.version, 0);
      assert.equal(review.revisionCount, 0);
      assert.equal(review.privacyEpoch, 0);
      assert.equal(review.insights[0].status, 'pending');
      assert.deepEqual(review.provenance, {
        hashVerified: false,
        runComplete: false,
      });
      assert.equal(review.sourcePath, `review:${review.id}`);
      const history = await api.getReviewHistory(review.id);
      assert.equal(history.snapshots.length, 1);
      assert.equal(history.snapshots[0].kind, 'initial');
      assert.equal(history.snapshots[0].note, '');
      assertNoOriginals(history.snapshots);
      assert.doesNotMatch(
        JSON.stringify(history),
        /PERSON_SECRET|sourceId|manifestSha256|inputSha256/,
      );
      assert.equal(
        local
          .prepare('SELECT id FROM reviews WHERE id = ?')
          .bind(oldId)
          .first(),
        null,
      );
      assert.equal(
        local
          .prepare('SELECT * FROM review_revisions WHERE review_id = ?')
          .bind(oldId)
          .all().results.length,
        0,
      );
      const operation = local
        .prepare(
          'SELECT * FROM review_privacy_operations WHERE operation_id = ?',
        )
        .bind(privacyInput.requestId)
        .first();
      assert.deepEqual(Object.keys(operation!).sort(), [
        'operation_id',
        'request_hash',
        'review_id',
      ]);
      assert.doesNotMatch(JSON.stringify(operation), new RegExp(oldId));
      assert.deepEqual(
        (await api.getReviewHistory(neighbor.id)).review,
        neighbor,
      );
      const exported = await api.exportReview(review.id);
      assert.doesNotMatch(
        JSON.stringify(exported),
        /PERSON_SECRET|manifestSha256|inputSha256/,
      );
      assert.match(JSON.stringify(exported), /hashVerified/);
      assert.equal(result.archiveName, review.id);
      assert.equal(result.url, `/?review=${review.id}&changes=0`);
    },
  );
  await t.test(
    'old tabs and old requests cannot restore discarded reviews',
    async () => {
      await assert.rejects(() => api.getReviewHistory(oldId), { status: 404 });
      assert.equal(
        (
          await route.POST(
            request({ ...edit, requestId: 'old-browser' }),
            oldContext,
          )
        ).status,
        404,
      );
      await assert.rejects(() => api.saveReviewRevision(oldId, edit), {
        status: 404,
      });
      const repeated = await api.sanitizeReviewHistory(oldId, privacyInput);
      assert.equal(repeated.replayed, true);
      assert.equal(repeated.review.id, review.id);
      await assert.rejects(
        () =>
          api.sanitizeReviewHistory(oldId, {
            ...privacyInput,
            projectName: 'Different',
          }),
        { status: 409 },
      );
    },
  );
  await t.test(
    'post-reset revisions begin at one and old recovery cannot revive a later reset',
    async () => {
      review.insights[0].workflow += '\n\nKeep this later improvement.';
      review = (
        await api.saveReviewRevision(
          review.id,
          payload(review, 'after-reset', 'Clarify the clean baseline.'),
        )
      ).review;
      assert.equal(review.version, 1);
      const recovered = await api.getPrivacyResetResult(privacyInput.requestId);
      assert.equal(recovered.savedVersion, 0);
      assert.doesNotMatch(
        recovered.review.insights[0].workflow!,
        /later improvement/,
      );
      const priorId = review.id;
      const newer = await api.sanitizeReviewHistory(
        review.id,
        resetPayload(review),
      );
      review = newer.review;
      assert.equal(review.version, 0);
      await assert.rejects(
        () => api.getPrivacyResetResult(privacyInput.requestId),
        { status: 404 },
      );
      await assert.rejects(() => api.getReviewHistory(priorId), {
        status: 404,
      });
      await assert.rejects(
        () => api.sanitizeReviewHistory(oldId, privacyInput),
        { status: 404 },
      );
    },
  );
  await t.test(
    'labels-only resets preserve approvals; changed support invalidates only affected cards',
    async () => {
      let supported = await create('PRIVATE_LABEL project');
      supported.summaryLines.push({
        id: 'L004',
        text: 'Independent support.',
        originalText: '',
        kind: 'content',
        ending: '\n',
      });
      supported.insights[0].status = 'accepted';
      supported.insights.push({
        ...supported.insights[0],
        id: 'I002',
        sourceId: 'I002',
        description: 'Independent method.',
        evidence: ['L004'],
      });
      supported.status = 'completed';
      supported = (
        await api.saveReviewRevision(
          supported.id,
          payload(supported, 'approved-support', 'Approved both.'),
        )
      ).review;
      const labels = resetPayload(supported);
      labels.state = JSON.parse(
        JSON.stringify({
          trajectorySummary: supported.trajectorySummary,
          summaryGroups: supported.summaryGroups,
          summaryLines: supported.summaryLines,
          insights: supported.insights,
          status: supported.status,
        }),
      );
      supported = (await api.sanitizeReviewHistory(supported.id, labels))
        .review;
      assert.equal(supported.status, 'completed');
      assert.deepEqual(
        supported.insights.map((c) => c.status),
        ['accepted', 'accepted'],
      );
      const replacement = resetPayload(supported);
      replacement.state = structuredClone(labels.state);
      replacement.state.summaryLines[2].text =
        'The reviewer needs a recorded validation step.';
      supported = (await api.sanitizeReviewHistory(supported.id, replacement))
        .review;
      assert.equal(supported.status, 'in_review');
      assert.deepEqual(
        supported.insights.map((c) => c.status),
        ['pending', 'accepted'],
      );
      const explicit = resetPayload(supported);
      explicit.state.insights[0].workflow += ' Record the outcome.';
      explicit.approvedInsightIds = ['I001'];
      supported = (await api.sanitizeReviewHistory(supported.id, explicit))
        .review;
      assert.equal(supported.insights[0].status, 'accepted');
    },
  );
  await t.test(
    'version guard covers concurrent changes after validation without partial replacement',
    async () => {
      const input = resetPayload(review);
      const count = local
        .prepare('SELECT COUNT(*) AS n FROM reviews')
        .first()!.n;
      beforeBatch = () => {
        local
          .prepare('UPDATE reviews SET version = version + 1 WHERE id = ?')
          .bind(review.id)
          .run();
      };
      await assert.rejects(() => api.sanitizeReviewHistory(review.id, input), {
        status: 409,
      });
      assert.equal(
        local.prepare('SELECT COUNT(*) AS n FROM reviews').first()!.n,
        count,
      );
      await assert.rejects(() => api.getPrivacyResetResult(input.requestId), {
        status: 404,
      });
      review = (await api.getReviewHistory(review.id)).review;
    },
  );
  await t.test(
    'a database failure rolls back the replacement and history deletion together',
    async () => {
      const before = await api.getReviewHistory(review.id);
      const count = local
        .prepare('SELECT COUNT(*) AS n FROM reviews')
        .first()!.n;
      local
        .prepare(
          "CREATE TRIGGER block_reset BEFORE DELETE ON reviews BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END",
        )
        .run();
      const input = resetPayload(review);
      try {
        await assert.rejects(() => api.sanitizeReviewHistory(review.id, input));
      } finally {
        local.prepare('DROP TRIGGER block_reset').run();
      }
      assert.deepEqual(await api.getReviewHistory(review.id), before);
      assert.equal(
        local.prepare('SELECT COUNT(*) AS n FROM reviews').first()!.n,
        count,
      );
      await assert.rejects(() => api.getPrivacyResetResult(input.requestId), {
        status: 404,
      });
    },
  );
  await t.test(
    'history, reset and recovery enforce authentication and no-store',
    async () => {
      const currentContext = {
        params: Promise.resolve({ reviewId: review.id }),
      };
      const recoveryRoute =
        await import('../app/api/reviews/privacy-operations/[operationId]/route.ts');
      const response = await route.GET(
        new Request('http://localhost/api/reviews/revisions'),
        currentContext,
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      env.OXYGEN_REVIEW_USERNAME = 'reviewer';
      env.OXYGEN_REVIEW_PASSWORD = 'synthetic-pass';
      assert.equal(
        (
          await route.GET(
            new Request('http://localhost/api/reviews/revisions'),
            currentContext,
          )
        ).status,
        401,
      );
      assert.equal(
        (await route.POST(request(edit), currentContext)).status,
        401,
      );
      assert.equal(
        (await privacyRoute.POST(request(resetPayload(review)), currentContext))
          .status,
        401,
      );
      assert.equal(
        (
          await recoveryRoute.GET(new Request('http://localhost/recovery'), {
            params: Promise.resolve({ operationId: privacyInput.requestId }),
          })
        ).status,
        401,
      );
      env.OXYGEN_REVIEW_USERNAME = undefined;
      env.OXYGEN_REVIEW_PASSWORD = undefined;
    },
  );
});

void test('migration backfills historical versions without changing content', () => {
  const sqlite = new DatabaseSync(':memory:');
  try {
    const directory = new URL('../drizzle/', import.meta.url);
    for (const name of readdirSync(directory)
      .filter((name) => /^000[0-2].*\.sql$/.test(name))
      .sort())
      sqlite.exec(readFileSync(new URL(name, directory), 'utf8'));
    sqlite.exec(`INSERT INTO reviews(id,project_name,source_path,status,generated_at,original_summary_json,original_insights_json,current_summary_json,current_insights_json,created_at,updated_at)
      VALUES('old','Old review','synthetic','ready','date','[]','[]','[]','[]','date','date');
      INSERT INTO review_revisions(review_id,revision_number,summary_json,insights_json,note,status,created_at)
      VALUES('old',7,'[]','[]','Old note','in_review','date');`);
    sqlite.exec(
      readFileSync(new URL('0003_assisted_review.sql', directory), 'utf8'),
    );
    assert.equal(
      sqlite.prepare('SELECT version FROM reviews').get()!.version,
      7,
    );
    assert.equal(
      sqlite.prepare('SELECT note FROM review_revisions').get()!.note,
      'Old note',
    );
  } finally {
    sqlite.close();
  }
});
