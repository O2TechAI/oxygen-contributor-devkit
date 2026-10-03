import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { InsightProse } from '../components/insight-takeaway.ts';
import {
  classifySummaryLines,
  parseV5Insights,
  serializeInsights,
} from './v5-format.ts';
import {
  parseReviewerInsight,
  reviewerInsightDraft,
  reviewerInsightExample,
  reviewerInsightPromptPath,
} from './reviewer-insight.ts';
import { isValidPayload, isValidV5Review } from './review-validation.ts';
import type { Review } from './review-types.ts';

const lines = classifySummaryLines(
  '# Findings\n\nThe user corrected role routing.\n\nThe agent reported a rerun.\n',
);
const card = `# I001

Title: Evaluation Role Isolation
Type: user-agent
Description:

Configure **independent roles** in evaluations.

Use when target and auxiliary models can influence a comparison.

Example:

The user corrected role routing.

The agent reported a rerun; independent verification remains pending.

Evidence: L003, L005
`;

void test('v8 parses both origin types, multiline prose, Unicode, and CRLF, and round trips accepted cards', () => {
  for (const type of ['user-agent', 'agent']) {
    const source = card
      .replace('Type: user-agent', `Type: ${type}`)
      .replace('a rerun;', 'a café rerun;');
    const parsed = parseV5Insights(source.replace(/\n/g, '\r\n'), lines, 8);
    assert.equal(parsed[0].type, type);
    assert.match(parsed[0].description!, /\n\nUse when/);
    assert.match(parsed[0].example!, /\n\nThe agent/);
    assert.deepEqual(parsed[0].presentKeys, [
      'title',
      'type',
      'description',
      'example',
      'evidence',
    ]);
    assert.equal(parsed[0].scope, undefined);
    assert.equal(parsed[0].takeaway, undefined);
    assert.equal(
      serializeInsights(
        parsed.map((c) => ({ ...c, status: 'accepted' })),
        8,
      ),
      source,
    );
  }
  assert.deepEqual(parseV5Insights('', [], 8), []);
  assert.equal(serializeInsights([], 8), '');
});

void test('v8 accepts inline descriptions/examples without requiring bold lead-ins', () => {
  const source =
    '# I001\n\nTitle: Role Isolation\nType: agent\nDescription: Configure model roles.\nExample: The user corrected routing.\nEvidence: L003\n';
  const result = parseV5Insights(source, lines, 8)[0];
  assert.equal(result.description, 'Configure model roles.');
  assert.equal(result.example, 'The user corrected routing.');
});

void test('v8 rejects missing, duplicate, out-of-order, legacy, and extra fields', () => {
  for (const bad of [
    card.replace('Title: Evaluation Role Isolation\n', ''),
    card.replace('Type: user-agent', 'Type: user explicit'),
    card.replace('Description:', 'Scope:'),
    card.replace('Example:', 'Takeaway:'),
    card.replace('Description:', 'Example:'),
    card.replace(
      'Configure **independent roles** in evaluations.\n\nUse when target and auxiliary models can influence a comparison.',
      '',
    ),
    card.replace(
      'The user corrected role routing.\n\nThe agent reported a rerun; independent verification remains pending.',
      '',
    ),
    card.replace('Evidence:', 'Title: Duplicate\nEvidence:'),
    card.replace('Evidence:', 'Why: Extra\nEvidence:'),
    card + 'Unexpected trailing text.\n',
    card.replace('# I001', '# I002'),
  ])
    assert.throws(() => parseV5Insights(bad, lines, 8), Error, bad);
});

void test('v8 requires unique substantive evidence for generated cards', () => {
  for (const refs of ['', 'L001', 'L002', 'L999', 'L003, L003', 'L003-L005']) {
    assert.throws(() =>
      parseV5Insights(card.replace('L003, L005', refs), lines, 8),
    );
  }
});

function review(): Review {
  return {
    id: 'test',
    projectName: 'test',
    sourcePath: 'test',
    status: 'in_review',
    generatedAt: '',
    updatedAt: '',
    revisionCount: 0,
    format: 'v5',
    protocolVersion: 8,
    stage: 'redaction',
    privacyStatus: 'redacted',
    provenance: { hashVerified: true, runComplete: true },
    trajectorySummary: { text: '', originalText: '' },
    summaryGroups: [],
    summaryLines: lines,
    insights: parseV5Insights(card, lines, 8),
  };
}

void test('v8 reviewer additions allow absent evidence and preserve prose through editing and validation', () => {
  const r = review();
  const manual = parseReviewerInsight(
    'I001',
    card.replace('Evidence: L003, L005', ''),
    lines,
    8,
  );
  assert.equal(manual.authorship, 'reviewer');
  assert.deepEqual(manual.evidence, []);
  const edited = parseReviewerInsight(
    'I001',
    reviewerInsightDraft(manual, 8).replace(
      'independent roles',
      'separate roles',
    ),
    lines,
    8,
  );
  assert.match(edited.description!, /separate roles/);
  assert.equal(edited.example, manual.example);
  const payload = {
    ...r,
    insights: [{ ...edited, status: 'accepted' as const }],
    status: 'completed' as const,
    note: '',
  };
  assert.equal(isValidPayload(payload), true);
  assert.equal(isValidV5Review(r, payload), true);
  assert.match(serializeInsights(payload.insights, 8), /Evidence: \n$/);
  assert.equal(
    isValidV5Review(r, {
      ...payload,
      insights: [{ ...payload.insights[0], authorship: undefined }],
    }),
    false,
  );
  assert.equal(
    isValidV5Review({ ...r, privacyStatus: 'unredacted' }, payload),
    false,
  );
});

void test('v8 save validation enforces the recorded schema and retains invalidated evidence state', () => {
  const r = review();
  const payload = { ...r, note: '' };
  assert.equal(isValidV5Review(r, payload), true);
  for (const patch of [
    { description: '' },
    { example: '' },
    { example: '# I002\n\nTitle: An accidental card boundary' },
    { description: 'Description: A duplicate field' },
    { scope: 'local' },
    { type: 'user explicit' },
    { title: 'A\nB' },
    { presentKeys: ['title'] },
    { evidence: ['L003', 'L003'] },
    { text: 'extra' },
  ]) {
    assert.equal(
      isValidV5Review(r, {
        ...payload,
        insights: [{ ...r.insights[0], ...patch }] as Review['insights'],
      }),
      false,
    );
  }
  assert.equal(
    isValidV5Review(r, {
      ...payload,
      insights: [{ ...r.insights[0], evidence: [], status: 'needs_review' }],
    }),
    true,
  );
  assert.equal(isValidV5Review({ ...r, protocolVersion: 7 }, payload), false);
});

void test('historical schemas and drafting prompts retain their original categories and fields', () => {
  const historical =
    '# I001\n\nTitle: A local lesson\nType: user implicit\nScope: This project.\nTakeaway: A tentative preference.\nEvidence: L003\n';
  const parsed = parseV5Insights(historical, lines, 7);
  assert.equal(parsed[0].type, 'user implicit');
  assert.equal(
    serializeInsights([{ ...parsed[0], status: 'accepted' }], 7),
    historical,
  );
  assert.throws(() => parseV5Insights(historical, lines, 8));
  assert.match(reviewerInsightExample(8), /Description:/);
  assert.match(reviewerInsightExample(7), /Scope:/);
  assert.equal(reviewerInsightPromptPath(8), '/reviewer-insight-prompt-v8.md');
  assert.equal(reviewerInsightPromptPath(7), '/reviewer-insight-prompt-v7.md');
});

void test('candidate prose renders Markdown without requiring bold paragraph prefixes or raw HTML', () => {
  const html = renderToStaticMarkup(
    createElement(InsightProse, {
      markdown:
        'Configure `role` values.\n\nUse **separate** judges. <script>bad()</script>',
    }),
  );
  assert.match(html, /<code>role<\/code>/);
  assert.match(html, /<strong>separate<\/strong>/);
  assert.doesNotMatch(html, /<script>/);
});

const richExample = [
  '### Recorded walkthrough',
  '',
  '1. Validate each result.',
  '   - Preserve completed items.',
  '',
  '> Completion was reported, not independently verified.',
  '',
  '| Case | Decision |',
  '|---|---|',
  '| Missing item | Retry |',
  '',
  '````markdown',
  '# I999',
  'Title: Literal example',
  'Example: Literal field',
  'Evidence: L999',
  '```',
  '````',
  '',
  '### Adapting the approach',
  '',
  'This could support document imports.',
].join('\n');
const richCard = card.replace(
  'The user corrected role routing.\n\nThe agent reported a rerun; independent verification remains pending.',
  richExample,
);

void test('rich cards preserve Markdown and fenced delimiters through parse, edit, serialize, and reviewer additions', () => {
  for (const text of [richCard, richCard.replaceAll('````', '~~~~')]) {
    const parsed = parseV5Insights(
      text + '\n' + card.replace('# I001', '# I002'),
      lines,
      8,
    );
    assert.equal(parsed.length, 2);
    assert.deepEqual(parsed[0].evidence, ['L003', 'L005']);
    const saved = serializeInsights([{ ...parsed[0], status: 'accepted' }], 8);
    assert.equal(saved, text);
    assert.equal(
      parseV5Insights(saved, lines, 8)[0].example,
      parsed[0].example,
    );
    const added = parseReviewerInsight(
      'I007',
      text.replace('Evidence: L003, L005', ''),
      lines,
      8,
    );
    assert.deepEqual(added.evidence, []);
    assert.equal(added.example, parsed[0].example);
    assert.equal(
      parseReviewerInsight('I007', reviewerInsightDraft(added, 8), lines, 8)
        .example,
      added.example,
    );
    const r = review();
    const revision = { ...r, insights: [parsed[0]], note: '' };
    assert.equal(isValidPayload(revision), true);
    assert.equal(isValidV5Review(r, revision), true);
  }
});

void test('v8 rejects unclosed and mismatched fences in generated and reviewer cards', () => {
  for (const fence of ['```text\nunfinished', '~~~~\n```\n~~~', '````\n```']) {
    const bad = richCard.replace(richExample, fence);
    assert.throws(() => parseV5Insights(bad, lines, 8), /Unclosed/);
    assert.throws(
      () => parseReviewerInsight('I001', bad, lines, 8),
      /Unclosed/,
    );
  }
  const description = '```text\nDescription: literal\n# I555\n```';
  const text = card.replace(
    'Configure **independent roles** in evaluations.',
    description,
  );
  assert.match(parseV5Insights(text, lines, 8)[0].description!, /# I555/);
});

void test('rich candidate rendering preserves hierarchy, tables, lists, quotations and literal code safely', () => {
  const html = renderToStaticMarkup(
    createElement(InsightProse, {
      markdown:
        richExample +
        '\n\n[Reference](https://example.com)\n\n<script>bad()</script>\n\n![image](https://example.com/image)',
    }),
  );
  for (const tag of [
    'h3',
    'ol',
    'ul',
    'li',
    'blockquote',
    'table',
    'thead',
    'tbody',
    'tr',
    'th',
    'td',
    'pre',
    'code',
  ])
    assert.match(html, new RegExp('<' + tag + '(?:>| )'));
  assert.match(html, /# I999/);
  assert.match(html, /overflow-x-auto/);
  assert.doesNotMatch(html, /<script|<a\b|<img|<input|<button/);
});

void test('colon-bearing prose is preserved rather than mistaken for a field', () => {
  const source = richCard.replace(
    'This could support document imports.',
    'Test the boundaries with realistic examples: include partial failures.',
  );
  const parsed = parseV5Insights(source, lines, 8);
  assert.match(parsed[0].example!, /examples: include/);
  assert.equal(
    serializeInsights([{ ...parsed[0], status: 'accepted' }], 8),
    source,
  );
});
