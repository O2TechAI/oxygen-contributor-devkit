import assert from 'node:assert/strict';
import test from 'node:test';
import {
  agentEditNote,
  agentQuestionNote,
  agentSchema,
  applyCards,
  applyPrivacy,
  buildPrompt,
  removeInsights,
  editSupported,
  parseAgentOutput,
  type AgentContext,
} from './agent-prompt.ts';
import type { Insight } from './review-types.ts';

const insight = (id: string, title: string): Insight => ({
  id,
  title,
  type: 'agent',
  description: 'Does a thing.',
  workflow: '1. Do it.',
  example: 'It happened.',
  originalText: '',
  text: '',
  evidence: ['L002'],
  status: 'accepted',
  presentKeys: [],
});

const context: AgentContext = {
  protocolVersion: 9,
  focusId: 'I001',
  summaryLines: [
    { id: 'L001', text: '# Heading', kind: 'heading' },
    { id: 'L002', text: 'The reviewer asked for a preview.', kind: 'content' },
    { id: 'L003', text: 'Titles stayed intact.', kind: 'content' },
  ],
  insights: [insight('I001', 'First'), insight('I002', 'Second')],
};

const card = (overrides: Record<string, unknown> = {}) => ({
  id: 'I001',
  title: 'First, clearer',
  type: 'user-agent',
  description: 'Does it better.',
  workflow: '1. Do it well.',
  example: 'It happened again.',
  evidence: ['L002', 'L003'],
  ...overrides,
});

void test('prompt lists only content lines as citable and names the scope', () => {
  const prompt = buildPrompt({
    mode: 'edit',
    scope: 'card',
    message: 'Shorten the example.',
    context,
  });
  assert.match(prompt, /L002: The reviewer asked for a preview\./);
  assert.doesNotMatch(prompt, /L001: # Heading/);
  assert.match(prompt, /card I001 only/);
  assert.match(prompt, /Shorten the example\./);
});

void test('only protocol v9 supports editing and ask mode needs just an answer', () => {
  assert.equal(editSupported(9), true);
  assert.equal(editSupported(8), false);
  assert.deepEqual(agentSchema('ask').required, ['answer']);
  assert.deepEqual(agentSchema('edit').required, [
    'answer',
    'cards',
    'removeCards',
    'privacy',
    'summaryLines',
    'projectName',
  ]);
});

void test('ask output returns the answer and no cards', () => {
  assert.deepEqual(
    parseAgentOutput('ask', { answer: ' Because L002. ' }, 'review', context),
    { answer: 'Because L002.', cards: [] },
  );
  assert.throws(() =>
    parseAgentOutput('ask', { answer: '' }, 'review', context),
  );
});

void test('edit output rejects unknown cards, bad evidence and out-of-scope changes', () => {
  const run = (cards: unknown[], scope: 'card' | 'review' = 'review') =>
    parseAgentOutput('edit', { answer: 'Done.', cards }, scope, context);
  assert.equal(run([card()]).cards.length, 1);
  assert.throws(() => run([card({ id: 'I009' })]), /unknown card/);
  assert.throws(() => run([card({ evidence: ['L001'] })]), /not a citable/);
  assert.throws(() => run([card({ evidence: [] })]), /without evidence/);
  assert.throws(() => run([card({ type: 'other' })]), /unsupported type/);
  assert.throws(
    () => run([card({ title: 'Two\nlines' })]),
    /single short line/,
  );
  assert.throws(() => run([card(), card()]), /twice/);
  assert.throws(
    () => run([card({ id: 'I002' })], 'card'),
    /outside the selected/,
  );
  assert.throws(
    () => run([card({ id: null })], 'card'),
    /outside the selected/,
  );
});

void test('applying cards resets changed cards to pending and appends new ones in order', () => {
  const parsed = parseAgentOutput(
    'edit',
    {
      answer: 'Done.',
      cards: [card(), card({ id: null, title: 'Brand new' })],
    },
    'review',
    context,
  );
  const result = applyCards(context.insights, parsed.cards);
  assert.deepEqual(result.changed, ['I001']);
  assert.deepEqual(result.added, ['I003']);
  assert.equal(result.insights[0].status, 'pending');
  assert.equal(result.insights[0].evidence.join(), 'L002,L003');
  assert.equal(result.insights[1].status, 'accepted');
  assert.equal(result.insights[2].id, 'I003');
  assert.equal(result.insights[2].authorship, 'reviewer');
  assert.equal(result.insights[2].presentKeys?.length, 6);
});

void test('a card identical to the saved one is left alone', () => {
  const same = card({
    title: 'First',
    type: 'agent',
    description: 'Does a thing.',
    workflow: '1. Do it.',
    example: 'It happened.',
    evidence: ['L002'],
  });
  const result = applyCards(context.insights, [same as never]);
  assert.deepEqual(result.changed, []);
  assert.equal(result.insights[0].status, 'accepted');
});

void test('the agent edit note keeps the whole request and the explanation', () => {
  const request = `Make the workflow steps plainer. ${'Keep the evidence. '.repeat(40)}`;
  assert.ok(request.length > 200);
  const note = agentEditNote(
    `  ${request}  `,
    'I rewrote steps 2 and 3.\nThe evidence is unchanged.',
  );
  assert.equal(
    note,
    `Agent edit requested: ${request.trim()}\n\n` +
      "Agent's explanation: I rewrote steps 2 and 3.\nThe evidence is unchanged.",
  );
});

void test('the agent edit note leaves out an empty explanation', () => {
  assert.equal(
    agentEditNote('Shorten I002.', '   '),
    'Agent edit requested: Shorten I002.',
  );
});

void test('questions and declined edit requests keep the whole request and the answer', () => {
  assert.equal(
    agentQuestionNote(
      '  Why is I002 pending?  ',
      ' It was edited by the agent. ',
    ),
    "Agent question: Why is I002 pending?\n\nAgent's answer: It was edited by the agent.",
  );
  assert.equal(
    agentQuestionNote('Merge I001 and I002.', '', true),
    'Agent edit requested (no cards changed): Merge I001 and I002.',
  );
});

void test('a privacy request covers the whole review, headings and the project name', () => {
  const prompt = buildPrompt({
    mode: 'edit',
    scope: 'card',
    message: 'Anonymize the reviewer.',
    context: { ...context, projectName: 'acme-secret' },
  });
  assert.match(prompt, /Project name: acme-secret/);
  assert.match(prompt, /L001 \(not citable\): # Heading/);
  assert.match(prompt, /privacy request is the exception/);
  assert.match(prompt, /does not change a card's type/);

  const output = {
    answer: 'Removed the name.',
    cards: [card({ id: 'I002' })],
    privacy: true,
    summaryLines: [{ id: 'L001', text: '# [name] heading' }],
    projectName: 'project',
  };
  // Card scope does not limit a privacy request.
  const parsed = parseAgentOutput('edit', output, 'card', context);
  assert.deepEqual(parsed.privacy, {
    summaryLines: [{ id: 'L001', text: '# [name] heading' }],
    projectName: 'project',
  });
  assert.throws(
    () =>
      parseAgentOutput(
        'edit',
        { ...output, cards: [card({ id: null })] },
        'review',
        context,
      ),
    /cannot add cards/,
  );
  assert.throws(
    () =>
      parseAgentOutput(
        'edit',
        { ...output, summaryLines: [{ id: 'L999', text: 'x' }] },
        'review',
        context,
      ),
    /unknown Summary line/,
  );
  assert.throws(
    () =>
      parseAgentOutput(
        'edit',
        { ...output, summaryLines: [{ id: 'L002', text: 'a\nb' }] },
        'review',
        context,
      ),
    /line break/,
  );
  // Without privacy, the extra fields are ignored and the scope applies.
  assert.equal(
    parseAgentOutput(
      'edit',
      { ...output, privacy: false, cards: [card()] },
      'card',
      context,
    ).privacy,
    undefined,
  );

  const lines = context.summaryLines.map((line) => ({
    ...line,
    originalText: line.text,
  }));
  const cleaned = applyPrivacy(
    { summaryLines: lines, insights: context.insights },
    parsed.privacy!,
    parsed.cards,
  );
  assert.deepEqual(cleaned.changedLines, ['L001']);
  assert.deepEqual(cleaned.changedCards, ['I002']);
  assert.equal(cleaned.summaryLines[0].text, '# [name] heading');
  assert.equal(cleaned.insights[1].status, 'pending');
});

void test('cards are deleted by id, not by emptying them, within the selected scope', () => {
  const output = (removeCards: unknown, privacy = false) => ({
    answer: 'Deleted.',
    cards: [],
    removeCards,
    privacy,
    summaryLines: [],
    projectName: null,
  });
  assert.deepEqual(
    parseAgentOutput('edit', output(['I001']), 'card', context).removeCards,
    ['I001'],
  );
  assert.throws(
    () => parseAgentOutput('edit', output(['I002']), 'card', context),
    /outside the selected/,
  );
  assert.throws(
    () => parseAgentOutput('edit', output(['I009']), 'review', context),
    /unknown card I009/,
  );
  assert.throws(
    () =>
      parseAgentOutput(
        'edit',
        { ...output(['I001']), cards: [card()] },
        'review',
        context,
      ),
    /changed and deleted/,
  );
  // A privacy request may delete any card.
  const sensitive = parseAgentOutput(
    'edit',
    output(['I002'], true),
    'card',
    context,
  );
  assert.deepEqual(sensitive.removeCards, ['I002']);
  const lines = context.summaryLines.map((line) => ({
    ...line,
    originalText: line.text,
  }));
  const cleaned = applyPrivacy(
    { summaryLines: lines, insights: context.insights },
    sensitive.privacy!,
    sensitive.cards,
    sensitive.removeCards,
  );
  assert.deepEqual(cleaned.removedCards, ['I002']);
  assert.deepEqual(
    cleaned.insights.map((insight) => insight.id),
    ['I001'],
  );
  // The rest are renumbered and keep where they came from.
  const three = [...context.insights, insight('I003', 'Third')];
  assert.deepEqual(
    removeInsights(three, ['I002']).map((item) => [item.id, item.sourceId]),
    [
      ['I001', 'I001'],
      ['I002', 'I003'],
    ],
  );
});
