import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { register } from 'node:module';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test from 'node:test';

import type { ReviewCreatePayload } from './review-types.ts';
import {
  parseReviewerInsight,
  reviewerInsightDraft,
} from './reviewer-insight.ts';
import { isValidPayload, isValidV5Review } from './review-validation.ts';
import { labelSummary, sha256 } from './v5-format.ts';
import { exportLabelingSummary } from './export-labeling.ts';

function assertLatestOnly(value: unknown) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(
      ![
        'original',
        'originalText',
        'originalMarkdown',
        'revisions',
        'historyIncluded',
        'includeHistory',
      ].includes(key),
      `Unexpected historical field: ${key}`,
    );
    assertLatestOnly(child);
  }
}

void test('imports, edits, saves, exports and reimports paragraph Takeaways without changing decisions or evidence', async (t) => {
  // Exercise the production persistence functions against isolated SQLite using
  // the real migrations. This adapter supplies only the D1 methods they use.
  const sqlite = new DatabaseSync(':memory:');
  const migrations = new URL('../drizzle/', import.meta.url);
  for (const name of readdirSync(migrations)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    sqlite.exec(readFileSync(new URL(name, migrations), 'utf8'));
  }
  const db = {
    prepare(sql: string) {
      let values: SQLInputValue[] = [];
      return {
        bind(...args: SQLInputValue[]) {
          values = args;
          return this;
        },
        run() {
          return sqlite.prepare(sql).run(...values);
        },
        all() {
          return { results: sqlite.prepare(sql).all(...values) };
        },
        first() {
          return sqlite.prepare(sql).get(...values) ?? null;
        },
      };
    },
    batch(statements: { run: () => unknown }[]) {
      return statements.map((statement) => statement.run());
    },
  };
  Object.defineProperty(globalThis, '__oxygenReviewTestDB', {
    value: db,
    configurable: true,
  });
  const moduleUrl = (source: string) =>
    `data:text/javascript,${encodeURIComponent(source)}`;
  // register() is available at the package's Node 22.13 minimum. The loader is
  // local to this test process; registerHooks() would require Node 22.15.
  register(
    moduleUrl(`
    const base = ${JSON.stringify(new URL('../', import.meta.url).href)};
    const moduleUrl = (source) => 'data:text/javascript,' + encodeURIComponent(source);
    export function resolve(specifier, context, nextResolve) {
      if (specifier === 'cloudflare:workers') {
        return { url: moduleUrl('export const env = { DB: globalThis.__oxygenReviewTestDB };'), shortCircuit: true };
      }
      if (specifier === '@/lib/sample-data') {
        return { url: moduleUrl('export const sampleReviews = []; export default [];'), shortCircuit: true };
      }
      if (specifier.startsWith('@/')) {
        return nextResolve(new URL(specifier.slice(2) + '.ts', base).href, context);
      }
      return nextResolve(specifier, context);
    }
  `),
    import.meta.url,
  );
  t.after(() => {
    Reflect.deleteProperty(globalThis, '__oxygenReviewTestDB');
    sqlite.close();
  });
  const {
    createReview,
    saveRevision,
    listReviews,
    exportReview,
    exportReviews,
  } = await import('../db/reviews.ts');
  const summary = '# Findings\n\nIndependent verification remains pending.\n';
  const original =
    '**Verify the report:** Read the available evidence before relying on the result.\n\n**Retain the qualification:** This check is proposed, not completed.';
  const cards = [1, 2, 3]
    .map(
      (n) =>
        `# I00${n}\n\nTitle: Verify a reported result\nType: agent encountered\nScope: This evaluation.\nTakeaway:\n\n${original}\n\nEvidence: L003\n`,
    )
    .join('\n');
  async function payload(
    insights: string,
    source: string,
  ): Promise<ReviewCreatePayload> {
    return {
      projectName: 'Synthetic test',
      sourcePath: source,
      format: 'v5',
      protocolVersion: 7,
      stage: 'redaction',
      summaryMarkdown: summary,
      summaryLabeledMarkdown: labelSummary(summary),
      insightMarkdown: insights,
      manifestJson: JSON.stringify({
        complete: true,
        configuration: { protocol_version: 7 },
        stages: {
          redaction: {
            status: 'complete',
            outputs: {
              sha256: {
                'summary_redacted.md': await sha256(summary),
                'summary_redacted_labeled.md': await sha256(
                  labelSummary(summary),
                ),
                'insight_redacted.md': await sha256(insights),
              },
            },
          },
        },
      }),
    };
  }
  const review = await createReview(await payload(cards, 'synthetic-original'));
  assert.equal(review.insights[0].takeaway, original);
  assert.equal(review.insights[0].text, '');
  const edited =
    original +
    '\n\n**Preserve the metric:** Keep café measurements and `status: pending` visible.';
  review.insights[0].takeaway = edited;
  review.insights[0].status = 'accepted';
  const declinedEdit =
    original + '\n\nThe reviewer declined this proposed method.';
  review.insights[1].takeaway = declinedEdit;
  review.insights[1].status = 'rejected';
  review.summaryLines[2].text =
    'Independent verification is still pending after review.';
  assert.equal(
    isValidV5Review(review, {
      ...review,
      insights: review.insights.slice(0, 2),
      note: 'Delete a card.',
      status: 'in_review',
    }),
    true,
    'Trash can delete a card independently of the decline decision.',
  );
  await saveRevision(review.id, {
    ...review,
    note: 'Synthetic Markdown edit.',
    status: 'in_review',
  });
  const saved = (await listReviews()).find((item) => item.id === review.id)!;
  assert.equal(saved.insights[0].takeaway, edited);
  assert.match(saved.insights[0].originalText, /\*\*Retain the qualification:/);
  assert.doesNotMatch(saved.insights[0].originalText, /Preserve the metric/);
  assert.deepEqual(
    saved.insights.map((card) => card.status),
    ['accepted', 'rejected', 'pending'],
  );
  assert.deepEqual(
    saved.insights.map((card) => card.evidence),
    [['L003'], ['L003'], ['L003']],
  );
  assert.equal(saved.revisionCount, 1);
  const exported = JSON.parse((await exportReview(review.id)).body);
  const decisions = JSON.parse(exported.files['approval.json']).decisions;
  assert.deepEqual(
    decisions.map((decision: { status: string }) => decision.status),
    ['accepted', 'rejected', 'accepted'],
  );
  assert.equal(decisions[2].savedStatus, 'pending');
  assert.equal(decisions[2].defaultAccepted, true);
  assert.equal(decisions[0].defaultAccepted, false);
  assert.match(exported.files['summary.md'], /still pending after review/);
  assert.deepEqual(Object.keys(exported.files).sort(), [
    'approval.json',
    'insight.md',
    'insight_declined.md',
    'insight_reviewed.md',
    'review.json',
    'summary.md',
    'summary_labeled.md',
  ]);
  assert.match(exported.files['insight_reviewed.md'], /reviewer declined/);
  assert.match(exported.files['insight_reviewed.md'], /^# I003$/m);
  assert.match(exported.files['insight_declined.md'], /^# I002$/m);
  assert.doesNotMatch(exported.files['insight_declined.md'], /^# I001$/m);
  assert.match(exported.files['insight_declined.md'], /reviewer declined/);
  assert.doesNotMatch(exported.files['insight.md'], /reviewer declined/);
  const archive = JSON.parse(exported.files['review.json']);
  assert.equal(archive.current.insights[1].status, 'rejected');
  assert.equal(archive.current.insights[1].takeaway, declinedEdit);
  assertLatestOnly(archive);
  assert.equal(
    JSON.parse(exported.files['approval.json']).revisions,
    undefined,
  );
  assert.deepEqual(
    archive.current.insights.map((card: { id: string }) => card.id),
    ['I001', 'I002', 'I003'],
  );
  const reimported = await createReview(
    await payload(exported.files['insight.md'], 'synthetic-reimport'),
  );
  assert.equal(reimported.insights.length, 2);
  assert.equal(reimported.insights[0].takeaway, edited);
  assert.deepEqual(reimported.insights[0].evidence, ['L003']);
  // Imports start a new review, while the original saved decisions stay intact.
  assert.equal(reimported.insights[0].status, 'pending');

  // The same persistence path supports a reviewer addition without evidence.
  const manual = parseReviewerInsight(
    'I004',
    'Title: Keep a separate audit copy\nType: user explicit\nScope: This project.\nTakeaway:\n\n**Preserve the source:** Keep an audit copy because I need to compare later corrections.\n\n**Bound the claim:** This is my workflow requirement, not a proven general rule.',
    saved.summaryLines,
  );
  saved.insights = [
    ...saved.insights.map((card) => ({ ...card, status: 'accepted' as const })),
    { ...manual, status: 'accepted' },
  ];
  const manualPayload = {
    ...saved,
    note: 'Added my uncited insight.',
    status: 'completed' as const,
  };
  assert.equal(isValidPayload(manualPayload), true);
  assert.equal(isValidV5Review(saved, manualPayload), true);
  await saveRevision(saved.id, manualPayload);
  const withManual = (await listReviews()).find(
    (item) => item.id === saved.id,
  )!;
  assert.equal(withManual.status, 'completed');
  assert.equal(withManual.insights[3].authorship, 'reviewer');
  assert.deepEqual(withManual.insights[3].evidence, []);
  assert.equal(withManual.insights[3].originalText, '');
  const manualExport = JSON.parse((await exportReview(saved.id)).body);
  assert.match(
    manualExport.files['insight.md'],
    /Title: Keep a separate audit copy/,
  );
  assert.match(manualExport.files['insight.md'], /\n\n\*\*Bound the claim:/);
  assert.equal(
    JSON.parse(manualExport.files['approval.json']).decisions[3].authorship,
    'reviewer',
  );
  assert.equal(
    JSON.parse(manualExport.files['approval.json']).decisions[3].sourceId,
    null,
  );
  const editedManual = parseReviewerInsight(
    'I004',
    reviewerInsightDraft(withManual.insights[3]).replace(
      'This project.',
      'This project during the audit.',
    ),
    withManual.summaryLines,
  );
  withManual.insights[3] = editedManual;
  await saveRevision(saved.id, {
    ...withManual,
    note: 'Clarified manual scope.',
    status: 'in_review',
  });
  const editedSaved = (await listReviews()).find(
    (item) => item.id === saved.id,
  )!;
  assert.equal(editedSaved.insights[3].scope, 'This project during the audit.');
  assert.equal(editedSaved.insights[3].status, 'pending');
  assert.equal(editedSaved.insights[3].takeaway, manual.takeaway);

  // Combined exports default pending cards to accepted without changing saved
  // decisions or per-trajectory provenance.
  const collection = JSON.parse(
    (await exportReviews([saved.id, reimported.id])).body,
  );
  assert.equal(collection.format, 'oxygen-human-review-collection/v1');
  assert.equal(collection.reviewCount, 2);
  assert.deepEqual(
    collection.reviews.map((item: { reviewId: string }) => item.reviewId),
    [saved.id, reimported.id],
  );
  assert.equal(collection.reviews[0].revisionCount, editedSaved.revisionCount);
  assert.deepEqual(
    collection.reviews[0].files,
    JSON.parse((await exportReview(saved.id)).body).files,
  );
  assert.match(
    collection.reviews[0].files['insight.md'],
    /Preserve the metric/,
  );
  assert.match(
    collection.reviews[1].files['insight.md'],
    /Preserve the metric/,
  );
  assert.deepEqual(
    JSON.parse(collection.reviews[1].files['approval.json']).decisions.map(
      (card: { status: string; savedStatus: string }) => [
        card.status,
        card.savedStatus,
      ],
    ),
    [
      ['accepted', 'pending'],
      ['accepted', 'pending'],
    ],
  );
  assert.equal(collection.reviews[1].acceptedInsightCount, 2);
  assert.equal(collection.reviews[1].defaultAcceptedInsightCount, 2);
  assert.equal(collection.reviews[1].labelingComplete, false);
  assert.equal(collection.reviews[1].insightCount, 2);
  assert.equal(collection.reviews[1].declinedInsightCount, 0);
  assert.match(
    collection.reviews[1].files['insight_reviewed.md'],
    /Preserve the metric/,
  );
  assert.deepEqual(
    JSON.parse(collection.reviews[1].files['review.json']).current.insights.map(
      (card: { status: string }) => card.status,
    ),
    ['accepted', 'accepted'],
  );
  await assert.rejects(exportReviews([]), /distinct reviews/);
  await assert.rejects(exportReviews([saved.id, saved.id]), /distinct reviews/);
  await assert.rejects(
    exportReviews([saved.id, 'missing-review']),
    /Review not found/,
  );
  assert.equal(
    (await listReviews()).find((item) => item.id === saved.id)!.revisionCount,
    editedSaved.revisionCount,
  );
  await t.test(
    'bulk downloads export only current content even when an old client requests history',
    async () => {
      const { POST } = await import('../app/api/reviews/export/route.ts');
      const request = (body: unknown) =>
        new Request('http://localhost/api/reviews/export', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      const response = await POST(
        request({
          reviewIds: [saved.id],
          format: 'json',
          includeHistory: true,
        }),
      );
      assert.equal(response.status, 200);
      const collection = (await response.json()) as {
        includeHistory?: boolean;
        reviews: Array<{ files: Record<string, string> }>;
      };
      const archive = JSON.parse(collection.reviews[0].files['review.json']);
      assert.equal(collection.includeHistory, undefined);
      assertLatestOnly(archive);
      assert.deepEqual(
        archive.current.insights.map((card: { status: string }) => card.status),
        ['accepted', 'accepted', 'accepted', 'accepted'],
      );
      const zip = await POST(
        request({ reviewIds: [saved.id, reimported.id], format: 'zip' }),
      );
      assert.equal(zip.status, 200);
      assert.equal(zip.headers.get('content-type'), 'application/zip');
      assert.match(zip.headers.get('content-disposition')!, /\.zip"$/);
      const bytes = new Uint8Array(await zip.arrayBuffer());
      assert.deepEqual([...bytes.slice(0, 4)], [80, 75, 3, 4]);
      assert.match(new TextDecoder().decode(bytes), /manifest\.json/);
      assert.equal(
        (await POST(request({ reviewIds: [saved.id], format: 'exe' }))).status,
        400,
      );
      assert.equal((await POST(request({ reviewIds: [] }))).status, 400);
      assert.equal(
        (await POST(request({ reviewIds: ['missing'] }))).status,
        404,
      );
      const preserved = JSON.parse((await exportReview(saved.id)).body);
      assertLatestOnly(JSON.parse(preserved.files['review.json']));
      assert.equal(
        (await listReviews()).find((review) => review.id === saved.id)!
          .revisionCount,
        editedSaved.revisionCount,
      );
    },
  );
  for (const version of [8, 9])
    await t.test(
      `v${version} skills coexist with historical reviews through edit, save, export and reimport`,
      async () => {
        const historicalBefore = (await exportReview(saved.id)).body;
        let skill =
          '# I001\n\nTitle: Verification Planning\nType: user-agent\nDescription:\n\nPlan independent result verification.\n\nUse when reported results need an evidence check.\n\nExample:\n\nThe team requested verification; the agent reported a result.\n\nIndependent verification remained pending.\n\nEvidence: L003\n';
        if (version === 9)
          skill = skill.replace(
            'Example:',
            'Workflow:\n\nSelect independent evidence and preserve uncertainty.\n\nExample:',
          );
        async function v8Payload(markdown: string, source: string) {
          const result = await payload(markdown, source);
          result.protocolVersion = version;
          const manifest = JSON.parse(result.manifestJson!);
          manifest.configuration.protocol_version = version;
          result.manifestJson = JSON.stringify(manifest);
          return result;
        }
        const v8 = await createReview(
          await v8Payload(
            skill +
              '\n' +
              skill
                .replace('# I001', '# I002')
                .replace('Type: user-agent', 'Type: agent'),
            `synthetic-v${version}`,
          ),
        );
        if (version === 9)
          v8.insights[0].workflow +=
            '\n\n1. Check the artifact.\n2. Record remaining uncertainty.\n\n```text\nWorkflow: literal\n# I777\n```';
        v8.insights[0].description += '\n\nKeep audit inputs traceable.';
        v8.insights[0].example += [
          '',
          '',
          version === 9
            ? '### Recorded application'
            : '### Adapting the approach',
          '',
          version === 9
            ? '1. Compared the reported result with the available artifact. Independent confirmation remained pending.'
            : '1. This check could be used for another import.',
          '',
          '| Input | Check |',
          '|---|---|',
          '| Result | Validity |',
          '',
          '```text',
          '# I999',
          'Evidence: literal example',
          '```',
        ].join('\n');
        v8.insights[0].status = 'accepted';
        v8.insights[1].description += '\n\nReviewer declined this capability.';
        v8.insights[1].status = 'rejected';
        const revision = {
          ...v8,
          note: 'Edited candidate description and example.',
          status: 'completed' as const,
        };
        assert.equal(isValidPayload(revision), true);
        assert.equal(isValidV5Review(v8, revision), true);
        await saveRevision(v8.id, revision);
        const current = (await listReviews()).find((r) => r.id === v8.id)!;
        assert.equal(
          current.insights[0].description,
          v8.insights[0].description,
        );
        assert.equal(current.insights[0].example, v8.insights[0].example);
        assert.equal(current.insights[0].workflow, v8.insights[0].workflow);
        assert.deepEqual(
          current.insights.map((c) => c.status),
          ['accepted', 'rejected'],
        );
        const exportedV8 = JSON.parse((await exportReview(v8.id)).body);
        assert.equal(
          JSON.parse(exportedV8.files['approval.json']).protocolVersion,
          version,
        );
        assert.match(exportedV8.files['insight.md'], /Description:/);
        assert.doesNotMatch(exportedV8.files['insight.md'], /Scope:|Takeaway:/);
        assert.doesNotMatch(
          exportedV8.files['insight.md'],
          /Reviewer declined/,
        );
        assert.match(
          exportedV8.files['insight_declined.md'],
          /Reviewer declined/,
        );
        assert.match(exportedV8.files['insight_reviewed.md'], /^# I002$/m);
        const v8Archive = JSON.parse(exportedV8.files['review.json']);
        assert.equal(v8Archive.current.insights[1].status, 'rejected');
        assert.equal(
          v8Archive.current.insights[1].description,
          current.insights[1].description,
        );
        assertLatestOnly(v8Archive);
        const copy = await createReview(
          await v8Payload(
            exportedV8.files['insight.md'],
            `synthetic-v${version}-reimport`,
          ),
        );
        assert.equal(copy.insights.length, 1);
        assert.equal(
          copy.insights[0].description,
          current.insights[0].description,
        );
        assert.equal(copy.insights[0].example, current.insights[0].example);
        assert.equal(copy.insights[0].workflow, current.insights[0].workflow);
        const added = parseReviewerInsight(
          'I003',
          skill.replace('Evidence: L003', 'Evidence:'),
          current.summaryLines,
          version,
        );
        current.insights.push({ ...added, status: 'accepted' });
        const withAddition = { ...current, note: 'Added uncited candidate.' };
        assert.equal(isValidPayload(withAddition), true);
        assert.equal(isValidV5Review(current, withAddition), true);
        await saveRevision(v8.id, withAddition);
        const addedExport = JSON.parse((await exportReview(v8.id)).body);
        const decision = JSON.parse(addedExport.files['approval.json'])
          .decisions[2];
        assert.equal(decision.authorship, 'reviewer');
        assert.equal(decision.exportId, 'I002');
        assert.match(addedExport.files['insight.md'], /Evidence: \n$/);
        assert.equal((await exportReview(saved.id)).body, historicalBefore);
        const mixed = JSON.parse((await exportReviews([saved.id, v8.id])).body);
        assert.equal(mixed.reviewCount, 2);
        assert.match(mixed.reviews[0].files['insight.md'], /Takeaway:/);
        assert.match(mixed.reviews[1].files['insight.md'], /Description:/);
        assert.equal(mixed.reviews[1].declinedInsightCount, 1);
        assert.match(
          mixed.reviews[1].files['insight_declined.md'],
          /Reviewer declined/,
        );
        assertLatestOnly(JSON.parse(mixed.reviews[1].files['review.json']));
      },
    );

  await t.test(
    'trash deletes a saved card while cross retains a declined decision',
    async () => {
      const review = await createReview(
        await payload(cards, 'synthetic-trash'),
      );
      review.insights[0].status = 'accepted';
      review.insights[1].status = 'accepted';
      review.insights[1].takeaway = 'Delete this unique card text.';
      review.insights[2].status = 'rejected';
      review.insights[2].takeaway = 'Keep this declined card text.';
      await saveRevision(review.id, {
        ...review,
        note: 'Decided cards before deletion.',
        status: 'in_review',
      });
      const deletion = {
        ...review,
        insights: review.insights
          .filter((card) => card.id !== 'I002')
          .map((card, index) => ({
            ...card,
            id: `I${String(index + 1).padStart(3, '0')}`,
          })),
        note: 'Removed I002',
        status: 'completed' as const,
      };
      assert.equal(isValidPayload(deletion), true);
      assert.equal(isValidV5Review(review, deletion), true);
      await saveRevision(review.id, deletion);
      const saved = (await listReviews()).find(
        (item) => item.id === review.id,
      )!;
      assert.deepEqual(
        saved.insights.map((card) => [card.id, card.sourceId, card.status]),
        [
          ['I001', 'I001', 'accepted'],
          ['I002', 'I003', 'rejected'],
        ],
      );
      const bundle = JSON.parse((await exportReview(review.id)).body);
      const decisions = JSON.parse(bundle.files['approval.json']).decisions;
      assert.deepEqual(
        decisions.map((card: { sourceId: string; status: string }) => [
          card.sourceId,
          card.status,
        ]),
        [
          ['I001', 'accepted'],
          ['I003', 'rejected'],
        ],
      );
      assert.doesNotMatch(
        bundle.files['insight_reviewed.md'],
        /Delete this unique/,
      );
      assert.match(bundle.files['insight_declined.md'], /Keep this declined/);
      assert.doesNotMatch(JSON.stringify(bundle), /Delete this unique/);
      const archive = JSON.parse(bundle.files['review.json']);
      assertLatestOnly(archive);
      const stored = sqlite
        .prepare('SELECT original_insights_json FROM reviews WHERE id = ?')
        .get(review.id)!;
      assert.equal(JSON.parse(String(stored.original_insights_json)).length, 3);
      const previous = sqlite
        .prepare(
          'SELECT insights_json FROM review_revisions WHERE review_id = ? AND revision_number = 1',
        )
        .get(review.id)!;
      assert.match(String(previous.insights_json), /Delete this unique/);
      const combined = JSON.parse((await exportReviews([review.id])).body);
      assert.equal(combined.reviews[0].insightCount, 2);
      assert.deepEqual(combined.reviews[0].files, bundle.files);
    },
  );

  await t.test(
    'deleted reviewer additions stay out of export when surviving cards are renumbered',
    async () => {
      const review = await createReview(
        await payload(cards, 'synthetic-reviewer-trash'),
      );
      const added = (id: string, sourceId: string, title: string) => ({
        ...parseReviewerInsight(
          id,
          `Title: ${title}\nType: user explicit\nScope: This project.\nTakeaway: Retain this reviewer guidance.`,
          review.summaryLines,
        ),
        sourceId,
        status: 'rejected' as const,
      });
      review.insights.push(
        added('I004', 'reviewer-deleted', 'Deleted reviewer addition'),
        added('I005', 'reviewer-retained', 'Retained reviewer addition'),
      );
      await saveRevision(review.id, {
        ...review,
        note: 'Added reviewer cards.',
        status: 'in_review',
      });
      review.insights = review.insights
        .filter((card) => card.sourceId !== 'reviewer-deleted')
        .map((card, index) => ({
          ...card,
          id: `I${String(index + 1).padStart(3, '0')}`,
        }));
      review.insights.push(
        added('I005', 'reviewer-new', 'New reviewer addition'),
      );
      await saveRevision(review.id, {
        ...review,
        note: 'Removed a card and added another.',
        status: 'in_review',
      });
      const bundle = JSON.parse((await exportReview(review.id)).body);
      assert.doesNotMatch(JSON.stringify(bundle), /Deleted reviewer addition/);
      assert.match(
        bundle.files['insight_declined.md'],
        /Retained reviewer addition/,
      );
      assert.match(
        bundle.files['insight_declined.md'],
        /New reviewer addition/,
      );
      const archive = JSON.parse(bundle.files['review.json']);
      assertLatestOnly(archive);
      assert.deepEqual(
        archive.current.insights.map(
          (card: { sourceId: string }) => card.sourceId,
        ),
        ['I001', 'I002', 'I003', 'reviewer-retained', 'reviewer-new'],
      );
    },
  );

  await t.test(
    'legacy exports keep current declined text without originals or revisions',
    async () => {
      const legacy = await createReview({
        projectName: 'Legacy review',
        sourcePath: 'synthetic-legacy',
        summaryMarkdown:
          '# Trajectory summary\nOriginal overview.\n\n# Summary groups\n\n## G001\nLines: L001\nOriginal group.\n\n# Summary lines\nL001 Original evidence.\n',
        insightMarkdown: '# I001\nOriginal proposed insight.\nEvidence: L001\n',
      });
      const pendingLegacy = await exportReview(legacy.id);
      assert.match(pendingLegacy.body, /Status: accepted/);
      assert.match(pendingLegacy.body, /"defaultAccepted": true/);
      assert.equal(
        (await listReviews()).find((item) => item.id === legacy.id)!.insights[0]
          .status,
        'pending',
      );
      legacy.insights[0].text = 'Edited declined insight.';
      legacy.insights[0].status = 'rejected';
      const revision = {
        ...legacy,
        note: 'Declined after editing.',
        status: 'in_review' as const,
      };
      assert.equal(isValidPayload(revision), true);
      assert.equal(isValidV5Review(legacy, revision), true);
      await saveRevision(legacy.id, revision);
      const exportedLegacy = await exportReview(legacy.id);
      assert.match(exportedLegacy.body, /Status: rejected/);
      assert.match(exportedLegacy.body, /Edited declined insight/);
      const archiveText = exportedLegacy.body
        .split('```json\n')[1]
        .split('\n```')[0];
      const snapshot = JSON.parse(archiveText);
      assertLatestOnly(snapshot);
      assert.equal(
        snapshot.current.insights[0].text,
        'Edited declined insight.',
      );
      assert.equal(snapshot.current.insights[0].status, 'rejected');
      assert.equal(
        isValidV5Review(legacy, { ...revision, insights: [] }),
        true,
      );
      const combined = JSON.parse((await exportReviews([legacy.id])).body);
      assert.equal(combined.reviews[0].declinedInsightCount, 1);
      assert.equal(combined.reviews[0].files['review.md'], exportedLegacy.body);
      assert.doesNotMatch(
        exportedLegacy.body,
        /Declined after editing|Review changes|Original and edited review archive/,
      );
      await saveRevision(legacy.id, {
        ...revision,
        insights: [],
        note: 'Removed I001',
      });
      const deletedExport = await exportReview(legacy.id);
      assert.doesNotMatch(
        deletedExport.body,
        /Edited declined insight|Original proposed insight/,
      );
    },
  );

  await t.test(
    'exports latest edits without old text, revision notes, or trashed cards',
    async () => {
      const review = await createReview(
        await payload(cards, 'synthetic-latest-only'),
      );
      review.insights[0].status = 'accepted';
      review.insights[0].takeaway = 'INTERMEDIATE_ACCEPT_ONLY';
      review.insights[1].status = 'rejected';
      review.insights[1].takeaway = 'INTERMEDIATE_DECLINE_ONLY';
      review.insights[2].takeaway = 'TRASH_ONLY';
      await saveRevision(review.id, {
        ...review,
        status: 'in_review',
        note: 'HISTORY_NOTE_ONLY',
      });
      review.insights[0].takeaway = 'LATEST_ACCEPT';
      review.insights[1].takeaway = 'LATEST_DECLINE';
      review.insights.pop();
      review.summaryLines[2].text = 'Latest reviewed summary.';
      const latest = await saveRevision(review.id, {
        ...review,
        status: 'completed',
        note: 'Final saved edit.',
      });
      const exported = await exportReview(review.id);
      for (const body of [
        exported.body,
        (await exportReviews([review.id])).body,
      ]) {
        assert.doesNotMatch(
          body,
          /INTERMEDIATE_ACCEPT_ONLY|INTERMEDIATE_DECLINE_ONLY|TRASH_ONLY|HISTORY_NOTE_ONLY|Independent verification remains pending\./,
        );
        assert.match(body, /LATEST_ACCEPT/);
        assert.match(body, /LATEST_DECLINE/);
        assert.match(body, /Latest reviewed summary/);
      }
      const files = JSON.parse(exported.body).files;
      const snapshot = JSON.parse(files['review.json']);
      assert.equal(snapshot.exportScope, 'latest');
      assertLatestOnly(snapshot);
      assertLatestOnly(JSON.parse(files['approval.json']));
      assert.deepEqual(
        snapshot.current.insights.map(
          (card: { status: string }) => card.status,
        ),
        ['accepted', 'rejected'],
      );
      assert.equal(snapshot.current.insights.length, 2);
      assert.deepEqual(
        (await listReviews()).find((review) => review.id === latest.id),
        latest,
      );
      assert.match(
        String(
          sqlite
            .prepare(
              'SELECT insights_json FROM review_revisions WHERE review_id = ? AND revision_number = 1',
            )
            .get(review.id)!.insights_json,
        ),
        /TRASH_ONLY/,
      );
    },
  );

  await t.test(
    'pending export defaults preserve labels and warn for incomplete labeling only',
    async () => {
      const review = await createReview(
        await payload(cards, 'synthetic-export-default'),
      );
      review.insights[0].status = 'needs_review';
      review.insights[1].status = 'pending';
      review.insights[2].status = 'rejected';
      const before = await saveRevision(review.id, {
        ...review,
        status: 'in_review',
        note: 'Evidence needs review.',
      });
      assert.deepEqual(exportLabelingSummary([before]), {
        accepted: 1,
        declined: 1,
        pending: 1,
        needsReview: 1,
        incompleteReviews: 1,
      });
      const bundle = JSON.parse((await exportReview(review.id)).body);
      const approval = JSON.parse(bundle.files['approval.json']);
      assert.deepEqual(
        approval.decisions.map(
          (card: {
            reviewId: string;
            status: string;
            savedStatus: string;
            defaultAccepted: boolean;
          }) => [
            card.reviewId,
            card.status,
            card.savedStatus,
            card.defaultAccepted,
          ],
        ),
        [
          ['I002', 'accepted', 'pending', true],
          ['I003', 'rejected', 'rejected', false],
        ],
      );
      assert.equal(approval.decisions[0].exportId, 'I001');
      const archive = JSON.parse(bundle.files['review.json']);
      assert.deepEqual(archive.exportLabeling, exportLabelingSummary([before]));
      assertLatestOnly(archive);
      assert.equal(archive.current.insights[0].status, 'accepted');
      assert.equal(archive.current.insights[0].savedStatus, 'pending');
      const batch = JSON.parse((await exportReviews([review.id])).body);
      assert.equal(batch.reviews[0].acceptedInsightCount, 1);
      assert.equal(batch.reviews[0].declinedInsightCount, 1);
      assert.equal(batch.reviews[0].defaultAcceptedInsightCount, 1);
      assert.equal(batch.reviews[0].labelingComplete, false);
      assert.deepEqual(
        (await listReviews()).find((item) => item.id === review.id),
        before,
      );
      const labeled = {
        ...before,
        insights: before.insights.map((card) => ({
          ...card,
          status: 'accepted' as const,
        })),
      };
      assert.equal(exportLabelingSummary([labeled]).incompleteReviews, 0);
      assert.equal(
        exportLabelingSummary([labeled, before]).incompleteReviews,
        1,
      );
      assert.equal(exportLabelingSummary([]).incompleteReviews, 0);
    },
  );

  await t.test(
    'exports an original unredacted review without requiring completion',
    async () => {
      const input = await payload(cards, 'synthetic-unredacted');
      input.stage = 'insight';
      input.manifestJson = JSON.stringify({
        complete: false,
        configuration: { protocol_version: 7 },
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
      });
      const unredacted = await createReview(input);
      unredacted.insights[0].status = 'accepted';
      unredacted.insights[1].status = 'rejected';
      // Delete an uncited blank summary line and remap the surviving evidence.
      unredacted.summaryLines.splice(1, 1);
      unredacted.summaryLines[1].id = 'L002';
      for (const insight of unredacted.insights) insight.evidence = ['L002'];
      const revision = {
        ...unredacted,
        note: 'Decided two cards and edited summary.',
        status: 'in_review' as const,
      };
      assert.equal(isValidPayload(revision), true);
      assert.equal(isValidV5Review(unredacted, revision), true);
      await saveRevision(unredacted.id, revision);
      const bundle = JSON.parse((await exportReview(unredacted.id)).body);
      const snapshot = JSON.parse(bundle.files['review.json']);
      assert.equal(snapshot.privacyStatus, 'unredacted');
      assert.equal(snapshot.status, 'in_review');
      assertLatestOnly(snapshot);
      assert.equal(snapshot.current.summaryLines.length, 2);
      assert.equal(bundle.files['original/summary.md'], undefined);
      assert.match(bundle.files['insight_declined.md'], /Evidence: L002/);
      assert.deepEqual(
        snapshot.current.insights.map(
          (card: { status: string }) => card.status,
        ),
        ['accepted', 'rejected', 'accepted'],
      );
    },
  );
});
