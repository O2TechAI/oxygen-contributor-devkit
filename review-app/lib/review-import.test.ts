import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isReviewCreatePayload,
  parseReviewImportFile,
  parseV5Review,
} from './review-import.ts';
import type { ReviewCreatePayload } from './review-types.ts';
import { labelSummary, sha256 } from './v5-format.ts';

async function fixture(
  version = 7,
  stage: 'insight' | 'redaction' = 'redaction',
  markdown?: string,
) {
  const summary =
    '# Findings\n\nThe user requested independent verification.\n';
  const insight =
    markdown ??
    [
      '# I001',
      'Title: Verify before relying on results',
      'Type: user explicit',
      'Scope: This request.',
      'Takeaway: Verify the result before relying on it because the user required an independent check.',
      'Evidence: L003',
      '',
    ].join('\n');
  const labeled = labelSummary(summary);
  const names =
    stage === 'redaction'
      ? [
          'summary_redacted.md',
          'summary_redacted_labeled.md',
          'insight_redacted.md',
        ]
      : ['summary.md', 'summary_labeled.md', 'insight.md'];
  const contents = [summary, labeled, insight];
  const manifest = {
    complete: stage === 'redaction',
    configuration: { protocol_version: version },
    stages: {
      [stage]: {
        status: 'complete',
        outputs: {
          sha256: Object.fromEntries(
            await Promise.all(
              names.map(async (name, index) => [
                name,
                await sha256(contents[index]),
              ]),
            ),
          ),
        },
      },
    },
  };
  const payload: ReviewCreatePayload = {
    projectName: 'Synthetic project',
    sourcePath: 'test-run',
    format: 'v5',
    protocolVersion: version,
    stage,
    summaryMarkdown: summary,
    summaryLabeledMarkdown: labeled,
    insightMarkdown: insight,
    manifestJson: JSON.stringify(manifest),
  };
  return { payload, manifest };
}

void test('imports compatible artifacts without a protocol whitelist and preserves their version', async () => {
  for (const version of [5, 6, 7, 12]) {
    for (const stage of ['insight', 'redaction'] as const) {
      const { payload } = await fixture(version, stage);
      const review = await parseV5Review(payload);
      assert.equal(review.hierarchy.protocolVersion, version);
      assert.equal(
        review.hierarchy.privacyStatus,
        stage === 'redaction' ? 'redacted' : 'unredacted',
      );
      assert.equal(review.hierarchy.provenance?.hashVerified, true);
      assert.deepEqual(review.insights[0].evidence, ['L003']);
    }
  }
});

void test('file imports preserve recorded v8/v9 schemas and rich application examples', async () => {
  for (const version of [8, 9]) {
    for (const stage of ['insight', 'redaction'] as const) {
      const card = [
        '# I001',
        '',
        'Title: Independent Result Verification',
        'Type: user-agent',
        'Description:',
        '',
        'Verify reported results when decisions depend on them.',
        '',
        ...(version === 9
          ? [
              'Workflow:',
              '',
              'Compare claims against independent artifacts.',
              '',
              '```text',
              '# I999',
              'Example: literal field',
              '```',
              '',
            ]
          : []),
        'Example:',
        '',
        'A reported result needed verification before reuse.',
        '',
        '| Material | Action |',
        '|---|---|',
        '| Reported result | Checked available evidence |',
        '',
        'Independent confirmation remained pending.',
        '',
        'Evidence: L003',
        '',
      ].join('\n');
      const { payload } = await fixture(version, stage, card);
      const file = JSON.stringify(payload);
      const imported = await parseReviewImportFile(file);
      assert.deepEqual(imported.payload, payload);
      assert.equal(imported.review.hierarchy.protocolVersion, version);
      assert.equal(imported.review.hierarchy.stage, stage);
      assert.match(
        imported.review.insights[0].example!,
        /\| Material \| Action \|/,
      );
      if (version === 9)
        assert.match(imported.review.insights[0].workflow!, /# I999/);
      else assert.equal(imported.review.insights[0].workflow, undefined);
    }
  }
  const { payload: historical } = await fixture();
  const historicalFile = await parseReviewImportFile(
    JSON.stringify(historical),
  );
  assert.equal(historicalFile.review.hierarchy.protocolVersion, 7);
  assert.ok(historicalFile.review.insights[0].takeaway);
  const { payload: empty } = await fixture(9, 'redaction', '');
  assert.deepEqual(
    (await parseReviewImportFile(JSON.stringify(empty))).review.insights,
    [],
  );
});

void test('file import rejects annotation bundles, malformed payloads and modified artifacts', async () => {
  await assert.rejects(parseReviewImportFile('{'), /valid review import JSON/);
  const { payload } = await fixture();
  for (const bad of [
    null,
    [],
    9,
    {},
    { format: 'oxygen-human-review-bundle/v1', files: {} },
    { ...payload, projectName: 4 },
    { ...payload, sourcePath: [] },
    { ...payload, manifestJson: null },
    { ...payload, format: 'v9' },
    { ...payload, stage: 'historical' },
  ]) {
    assert.equal(isReviewCreatePayload(bad), false);
    await assert.rejects(
      parseReviewImportFile(JSON.stringify(bad)),
      /prepared run import/,
    );
  }
  await assert.rejects(
    parseReviewImportFile(
      JSON.stringify({
        ...payload,
        insightMarkdown: payload.insightMarkdown + '\n',
      }),
    ),
    /manifest hash/,
  );
  await assert.rejects(
    parseReviewImportFile(
      JSON.stringify({
        ...payload,
        protocolVersion: 9,
      }),
    ),
    /protocol version does not match/,
  );
  // Existing API callers can still submit historical pairs.
  assert.equal(
    isReviewCreatePayload({
      projectName: 'Legacy',
      sourcePath: 'legacy',
      summaryMarkdown: '# Summary',
      insightMarkdown: '# I001',
    }),
    true,
  );
});

void test('rejects mismatched or missing manifest protocol versions', async () => {
  const { payload, manifest } = await fixture();
  for (const configuration of [{ protocol_version: 5 }, {}]) {
    await assert.rejects(
      parseV5Review({
        ...payload,
        manifestJson: JSON.stringify({ ...manifest, configuration }),
      }),
      /protocol version does not match/,
    );
  }
});

void test('rejects invalid protocol numbers', async () => {
  const { payload } = await fixture();
  for (const protocolVersion of [
    undefined,
    0,
    -1,
    7.5,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    await assert.rejects(
      parseV5Review({ ...payload, protocolVersion }),
      /protocolVersion/,
    );
  }
});

void test('still rejects incomplete stages and unfinished redaction', async () => {
  const { payload, manifest } = await fixture();
  await assert.rejects(
    parseV5Review({
      ...payload,
      manifestJson: JSON.stringify({ ...manifest, complete: false }),
    }),
    /privacy-redaction run is not complete/,
  );
  manifest.stages.redaction.status = 'issued';
  await assert.rejects(
    parseV5Review({
      ...payload,
      manifestJson: JSON.stringify(manifest),
    }),
    /redaction stage is not complete/,
  );
});

void test('rejects stale labels even when artifact hashes match', async () => {
  const { payload, manifest } = await fixture();
  payload.summaryLabeledMarkdown = labelSummary('An older summary.\n');
  manifest.stages.redaction.outputs.sha256['summary_redacted_labeled.md'] =
    await sha256(payload.summaryLabeledMarkdown);
  payload.manifestJson = JSON.stringify(manifest);
  await assert.rejects(
    parseV5Review(payload),
    /labeled Summary does not match/,
  );
});

void test('still rejects artifact hash changes', async () => {
  const { payload } = await fixture();
  payload.insightMarkdown += '\n';
  await assert.rejects(
    parseV5Review(payload),
    /manifest hash for insight_redacted.md/,
  );
});

void test('still rejects invalid evidence with matching hashes', async () => {
  const { payload, manifest } = await fixture();
  payload.insightMarkdown = payload.insightMarkdown.replace('L003', 'L999');
  manifest.stages.redaction.outputs.sha256['insight_redacted.md'] =
    await sha256(payload.insightMarkdown);
  payload.manifestJson = JSON.stringify(manifest);
  await assert.rejects(parseV5Review(payload), /invalid Evidence/);
});
