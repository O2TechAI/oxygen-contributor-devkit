import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';
import { historyFiles } from './history-export.ts';
import { openLocalDatabase } from './local-database.ts';
import type { Review, ReviewSavePayload } from './review-types.ts';
import { labelSummary, sha256 } from './v5-format.ts';

function assertNoOriginals(value: unknown) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.notEqual(key, 'originalText');
    assertNoOriginals(child);
  }
}

void test('history markdown quotes requests and fences diffs safely', () => {
  const state = {
    trajectorySummary: { text: '' },
    summaryGroups: [],
    summaryLines: [],
    status: 'ready' as const,
  };
  const card = {
    id: 'I001',
    text: '',
    evidence: ['L001'],
    status: 'pending' as const,
    title: 'Check CI time zones',
  };
  const files = historyFiles({
    review: {
      id: 'review-1',
      projectName: 'Demo',
      sourcePath: 'run-1-trajectory-001-original',
      privacyEpoch: 0,
      version: 1,
      protocolVersion: 9,
      stage: 'insight',
      privacyStatus: 'unredacted',
    } as Review,
    snapshots: [
      {
        version: 0,
        kind: 'initial',
        createdAt: 't0',
        note: '',
        state: { ...state, insights: [card] },
      },
      {
        version: 1,
        kind: 'edit',
        requestId: 'request-1',
        createdAt: 't1',
        note: 'Make I001 plainer.\nUse ``` fences.',
        state: {
          ...state,
          insights: [{ ...card, title: 'Use ```UTC``` in CI' }],
        },
      },
    ],
  });
  const record = JSON.parse(files['history.json']);
  assert.equal(record.format, 'oxygen-review-history/v1');
  assert.equal(record.snapshots.length, 2);
  assert.equal(record.latestVersion, 1);
  const markdown = files['history.md'];
  assert.match(markdown, /## Version 1 · edit · t1/);
  assert.match(markdown, /Request ID: request-1/);
  assert.match(markdown, /^> Make I001 plainer\.$/m);
  assert.match(markdown, /^-Check CI time zones$/m);
  assert.match(markdown, /^````diff$/m);
  assert.match(markdown, /^\+Use ```UTC``` in CI$/m);
});

void test('exports include full history only when requested', async (t) => {
  const local = openLocalDatabase(
    ':memory:',
    new URL('../drizzle/', import.meta.url),
  );
  const env = {
    DB: local,
    OXYGEN_REVIEW_USERNAME: undefined as string | undefined,
    OXYGEN_REVIEW_PASSWORD: undefined as string | undefined,
  };
  Object.defineProperty(globalThis, '__oxygenHistoryExportTestEnv', {
    value: env,
    configurable: true,
  });
  register(
    `data:text/javascript,${encodeURIComponent(`
    const base = ${JSON.stringify(new URL('../', import.meta.url).href)};
    const moduleUrl = (source) => 'data:text/javascript,' + encodeURIComponent(source);
    export function resolve(specifier, context, nextResolve) {
      if (specifier === 'cloudflare:workers') return { url: moduleUrl('export const env = globalThis.__oxygenHistoryExportTestEnv;'), shortCircuit: true };
      if (specifier === '@/lib/sample-data') return { url: moduleUrl('export const sampleReviews = [];'), shortCircuit: true };
      if (specifier.startsWith('@/')) return nextResolve(new URL(specifier.slice(2) + '.ts', base).href, context);
      return nextResolve(specifier, context);
    }
  `)}`,
    import.meta.url,
  );
  t.after(() => {
    local.close();
    Reflect.deleteProperty(globalThis, '__oxygenHistoryExportTestEnv');
  });
  const api = await import('../db/reviews.ts');
  const bulkRoute = await import('../app/api/reviews/export/route.ts');
  const singleRoute =
    await import('../app/api/reviews/[reviewId]/export/route.ts');
  const summary = '# Findings\n\nThe CI failure came from the time zone.\n';
  const cards =
    '# I001\n\nTitle: Check CI time zones\nType: user-agent\nDescription: Tests fail only in CI.\nWorkflow: Compare time zones first.\nExample: CI ran in UTC.\nEvidence: L003\n\n' +
    '# I002\n\nTitle: Retry flaky tests\nType: agent\nDescription: Retries hide failures.\nWorkflow: Retry once.\nExample: A retry passed.\nEvidence: L003\n';
  let review = await api.createReview({
    projectName: 'History export',
    sourcePath: 'run-1-trajectory-001-original',
    format: 'v5',
    protocolVersion: 9,
    stage: 'insight',
    summaryMarkdown: summary,
    summaryLabeledMarkdown: labelSummary(summary),
    insightMarkdown: cards,
    manifestJson: JSON.stringify({
      complete: true,
      configuration: { protocol_version: 9 },
      stages: {
        insight: {
          status: 'complete',
          outputs: {
            sha256: {
              'summary.md': await sha256(summary),
              'summary_labeled.md': await sha256(labelSummary(summary)),
              'insight.md': await sha256(cards),
            },
          },
        },
      },
    }),
  });
  const save = async (requestId: string, note: string) => {
    const payload: ReviewSavePayload = {
      ...review,
      expectedVersion: review.version,
      requestId,
      note,
    };
    review = (await api.saveReviewRevision(review.id, payload)).review;
  };
  review.insights[0].workflow = '1. Compare the CI and local time zones.';
  await save('assisted-1', 'Make I001 a numbered step and remove I002.');
  review.insights = review.insights
    .slice(0, 1)
    .map((card) => ({ ...card, status: 'accepted' as const }));
  await save('browser-1', 'Deleted I002; Accepted I001');

  await t.test('default exports stay latest-only', async () => {
    const collection = JSON.parse((await api.exportReviews([review.id])).body);
    assert.equal(collection.historyIncluded, undefined);
    assert.equal(collection.reviews[0].historyVersions, undefined);
    assert.equal(collection.reviews[0].files['history.json'], undefined);
    const single = await singleRoute.GET(
      new Request(`http://localhost/api/reviews/${review.id}/export`),
      { params: Promise.resolve({ reviewId: review.id }) },
    );
    assert.equal(
      JSON.parse(await single.text()).files['history.json'],
      undefined,
    );
  });

  await t.test(
    'opt-in history keeps every version, request, and deletion',
    async () => {
      const exported = await api.exportReviews([review.id], {
        includeHistory: true,
      });
      assert.match(exported.filename, /^oxygen-reviews-with-history-/);
      const collection = JSON.parse(exported.body);
      assert.equal(collection.historyIncluded, true);
      const bundle = collection.reviews[0];
      assert.equal(bundle.historyVersions, 3);
      const history = JSON.parse(bundle.files['history.json']);
      assertNoOriginals(history);
      assert.deepEqual(
        history.snapshots.map((snapshot: { kind: string }) => snapshot.kind),
        ['initial', 'edit', 'edit'],
      );
      assert.equal(
        history.snapshots[1].note,
        'Make I001 a numbered step and remove I002.',
      );
      assert.equal(history.snapshots[1].requestId, 'assisted-1');
      assert.equal(history.snapshots[0].state.insights.length, 2);
      assert.equal(history.snapshots[2].state.insights.length, 1);
      assert.doesNotMatch(bundle.files['insight.md'], /Retry flaky tests/);
      assert.match(bundle.files['history.md'], /-Title:\n-Retry flaky tests/);
      assert.match(bundle.files['history.md'], /\+1\. Compare the CI/);
    },
  );

  await t.test('routes accept the option and reject bad values', async () => {
    const post = (body: unknown) =>
      bulkRoute.POST(
        new Request('http://localhost/api/reviews/export', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
    assert.equal(
      (await post({ reviewIds: [review.id], includeHistory: 'yes' })).status,
      400,
    );
    const zip = await post({
      reviewIds: [review.id],
      format: 'zip',
      includeHistory: true,
    });
    assert.equal(zip.status, 200);
    const text = new TextDecoder().decode(await zip.arrayBuffer());
    assert.match(text, /\/history\.json/);
    assert.match(text, /\/history\.md/);
    const single = await singleRoute.GET(
      new Request(`http://localhost/api/reviews/${review.id}/export?history=1`),
      { params: Promise.resolve({ reviewId: review.id }) },
    );
    assert.match(
      single.headers.get('content-disposition') ?? '',
      /review-bundle-with-history\.json/,
    );
    const bundle = JSON.parse(await single.text());
    assert.equal(bundle.historyIncluded, true);
    assert.equal(JSON.parse(bundle.files['history.json']).snapshots.length, 3);
  });
});
