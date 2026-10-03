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
import type { Review, Insight } from './review-types.ts';

const lines = classifySummaryLines(
  '# Findings\n\nThe user requested independent verification.\n\nThe agent reported success; verification remained pending.\n',
);
const workflow = `### Method

1. Find an independent check.
2. Record remaining uncertainty.

| Claim | Check |
|---|---|
| Success | Independent evidence |

> Preserve the distinction between reports and observations.

\`\`\`markdown
# I999
Description: literal
Workflow: literal
Example: literal
Evidence: L999
\`\`\``;
const card = `# I001

Title: Independent Result Verification
Type: user-agent
Description:

Verify reported results when the evidence is incomplete.

Workflow:

${workflow}

Example:

The user requested verification. The agent reported success, but independent verification remained pending.

Evidence: L003, L005
`;

function review(): Review {
  return {
    id: 'workflow-test',
    projectName: 'test',
    sourcePath: 'test',
    status: 'in_review',
    generatedAt: '',
    updatedAt: '',
    revisionCount: 0,
    format: 'v5',
    protocolVersion: 9,
    stage: 'redaction',
    privacyStatus: 'redacted',
    provenance: { hashVerified: true, runComplete: true },
    trajectorySummary: { text: '', originalText: '' },
    summaryGroups: [],
    summaryLines: lines,
    insights: parseV5Insights(card, lines, 9),
  };
}

void test('v9 preserves six fields, both origins, rich Workflow and fenced delimiters through Markdown round trips', () => {
  for (const type of ['user-agent', 'agent']) {
    const source = card.replace('Type: user-agent', `Type: ${type}`);
    const parsed = parseV5Insights(source.replace(/\n/g, '\r\n'), lines, 9);
    assert.equal(parsed[0].workflow, workflow);
    assert.equal(parsed[0].type, type);
    assert.deepEqual(parsed[0].presentKeys, [
      'title',
      'type',
      'description',
      'workflow',
      'example',
      'evidence',
    ]);
    assert.equal(
      serializeInsights(
        parsed.map((item) => ({ ...item, status: 'accepted' })),
        9,
      ),
      source,
    );
  }
  assert.deepEqual(parseV5Insights('', [], 9), []);
  assert.equal(serializeInsights([], 9), '');
});

void test('v9 rejects malformed fields, invalid citations, and unclosed Workflow fences', () => {
  for (const bad of [
    card.replace(`Workflow:\n\n${workflow}\n\n`, ''),
    card.replace(workflow, ''),
    card.replace(workflow, 'Workflow: duplicate'),
    card.replace('Workflow:', 'Example:'),
    card.replace('Workflow:', 'Scope:'),
    card.replace('Type: user-agent', 'Type: user implicit'),
    card.replace('L003, L005', 'L001'),
    card.replace('L003, L005', 'L999'),
    card.replace('L003, L005', 'L003, L003'),
    card.replace('L003, L005', ''),
    card.replace(workflow, '```text\nUnclosed'),
  ])
    assert.throws(() => parseV5Insights(bad, lines, 9), Error, bad);
  assert.throws(() => parseV5Insights(card, lines, 8));
  assert.throws(() =>
    parseV5Insights(card.replace(`Workflow:\n\n${workflow}\n\n`, ''), lines, 9),
  );
});

void test('v9 additions and editing retain Workflow with optional reviewer evidence', () => {
  const r = review();
  const added = parseReviewerInsight(
    'I001',
    card.replace('Evidence: L003, L005', ''),
    lines,
    9,
  );
  const edited = parseReviewerInsight(
    'I001',
    reviewerInsightDraft(added, 9).replace(
      'Find an independent check.',
      'Find an independent café check.',
    ),
    lines,
    9,
  );
  assert.match(edited.workflow!, /café/);
  assert.equal(edited.example, added.example);
  assert.deepEqual(edited.evidence, []);
  const payload = {
    ...r,
    insights: [{ ...edited, status: 'accepted' as const }],
    note: '',
    status: 'completed' as const,
  };
  assert.equal(isValidPayload(payload), true);
  assert.equal(isValidV5Review(r, payload), true);
  for (const patch of [
    { workflow: '' },
    { workflow: undefined },
    { workflow: 3 },
    { workflow: 'Workflow: duplicate' },
    { workflow: '# I002\nTitle: injected' },
    { workflow: '```text\nUnclosed' },
    { presentKeys: ['title'] },
  ])
    assert.equal(
      isValidV5Review(r, {
        ...payload,
        insights: [{ ...edited, ...patch } as Insight],
      }),
      false,
    );
  assert.equal(isValidV5Review({ ...r, protocolVersion: 8 }, payload), false);
  assert.match(reviewerInsightExample(9), /Workflow:/);
  assert.doesNotMatch(reviewerInsightExample(8), /^Workflow:/m);
  assert.equal(reviewerInsightPromptPath(9), '/reviewer-insight-prompt.md');
  assert.equal(reviewerInsightPromptPath(8), '/reviewer-insight-prompt-v8.md');
});

void test('Workflow renders headings, steps, quotes, tables and code with readable overflow', () => {
  const html = renderToStaticMarkup(
    createElement(InsightProse, { markdown: workflow }),
  );
  for (const tag of ['h3', 'ol', 'blockquote', 'table', 'pre', 'code'])
    assert.match(html, new RegExp(`<${tag}(?:>| )`));
  assert.match(html, /Workflow: literal/);
  assert.match(html, /overflow-x-auto/);
});
