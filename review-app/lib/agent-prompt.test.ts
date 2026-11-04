import assert from 'node:assert/strict';
import test from 'node:test';
import {
  agentSchema,
  applyCards,
  buildPrompt,
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
  assert.deepEqual(agentSchema('edit').required, ['answer', 'cards']);
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
