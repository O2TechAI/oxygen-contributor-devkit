import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifySummaryLines,
  labelSummary,
  parseV5Insights,
  relabelSummaryLines,
  remapInsightEvidence,
  serializeInsights,
} from './v5-format.ts';

const summary = '# Overview\r\n\r\nReadable context.\r\n\r\n# Detailed summary\r\n\r\n## Result\r\n\r\n- Work completed.\r\n';

const takeaway = '**Check the actual result:** Verify café metrics; keep `status: pending` explicit.\n\n**Keep the qualification:** The result is reported, and independent verification remains pending.';
const paragraphCard = `# I001\n\nTitle: Verify results\nType: agent encountered\nScope: This evaluation.\nTakeaway:\n\n${takeaway}\n\nEvidence: L003, L009\n`;

void test('preserves paragraph Takeaways through CRLF parsing and export', () => {
  for (const markdown of [paragraphCard, paragraphCard.replaceAll('\n', '\r\n')]) {
    const [card] = parseV5Insights(markdown, classifySummaryLines(summary));
    assert.equal(card.takeaway, takeaway);
    assert.equal(card.text, '');
    assert.equal(card.status, 'pending');
    assert.deepEqual(card.evidence, ['L003', 'L009']);
    card.status = 'accepted';
    assert.equal(serializeInsights([card]), paragraphCard);
    const [reimported] = parseV5Insights(serializeInsights([card]), classifySummaryLines(summary));
    assert.equal(reimported.takeaway, takeaway);
    assert.deepEqual(reimported.evidence, card.evidence);
  }
});

void test('keeps a single bold paragraph in block form and legacy body text outside it', () => {
  const single = paragraphCard.replace(takeaway, '**Verify results:** Read the evidence.');
  const [card] = parseV5Insights(single + '\nLegacy body text.\n', classifySummaryLines(summary));
  assert.equal(card.takeaway, '**Verify results:** Read the evidence.');
  assert.equal(card.text, 'Legacy body text.');
  card.status = 'accepted';
  assert.match(serializeInsights([card]), /Takeaway:\n\n\*\*Verify results:/);
});

void test('rejects empty or unterminated Takeaway blocks and embedded extra fields', () => {
  for (const markdown of [
    paragraphCard.replace(takeaway, ''),
    paragraphCard.replace('Evidence: L003, L009', ''),
    paragraphCard.replace(takeaway, takeaway + '\nTakeaway: Duplicate'),
    paragraphCard.replace(takeaway, takeaway + '\nContext: Extra'),
    paragraphCard.replace('L003, L009', 'L999'),
  ]) {
    assert.throws(() => parseV5Insights(markdown, classifySummaryLines(summary)));
  }
});

void test('labels every physical line and preserves line endings', () => {
  const labeled = labelSummary(summary);
  assert.match(labeled, /^L001 # Overview\r\nL002 \r\nL003 Readable context\./);
  assert.match(labeled, /L009 - Work completed\.\r\n$/);
  assert.equal(classifySummaryLines(summary).length, 9);
});

void test('parses and serializes protocol v5 Insight cards', () => {
  const cards = parseV5Insights(
    [
      '# I001',
      '',
      'Title: Preserve verified evidence',
      'Type: user explicit',
      'Applies when: Publishing a reviewed trajectory.',
      'Scope: This applies to protocol v5 review exports.',
      'Takeaway: Keep evidence addresses valid after every edit.',
      'Why: Review decisions depend on traceable supporting text.',
      'Evidence: L003, L009',
      '',
    ].join('\n'),
    classifySummaryLines(summary),
  );
  assert.equal(cards.length, 1);
  assert.equal(cards[0].type, 'user explicit');
  assert.deepEqual(cards[0].presentKeys, [
    'title',
    'type',
    'scope',
    'takeaway',
    'evidence',
  ]);
  assert.deepEqual(cards[0].evidence, ['L003', 'L009']);
  cards[0].status = 'accepted';
  assert.match(serializeInsights(cards), /Takeaway: Keep evidence addresses/);
  cards[0].takeaway = takeaway;
  const [editedLegacy] = parseV5Insights(serializeInsights(cards), classifySummaryLines(summary));
  assert.equal(editedLegacy.takeaway, takeaway);
  assert.equal(editedLegacy.why, cards[0].why);
  assert.equal(editedLegacy.appliesWhen, cards[0].appliesWhen);
});

void test('parses optional keys and preserves ordinary Insight text', () => {
  const [card] = parseV5Insights(
    [
      '# I001',
      '',
      'TYPE: Inferred user preference',
      'Evidence: L003',
      '',
      'Prefer a compact review surface.',
    ].join('\n'),
    classifySummaryLines(summary),
  );
  assert.equal(card.title, 'Prefer a compact review surface.');
  assert.equal(card.type, 'user implicit');
  assert.deepEqual(card.presentKeys, ['type', 'evidence']);
  assert.equal(card.text, 'Prefer a compact review surface.');
});

void test('retains cards without recognized keys for human review', () => {
  const [card] = parseV5Insights(
    '# I001\n\nThe agent encountered an unresolved provenance gap.\n',
    classifySummaryLines(summary),
  );
  assert.equal(
    card.title,
    'The agent encountered an unresolved provenance gap.',
  );
  assert.deepEqual(card.presentKeys, []);
  assert.equal(card.status, 'needs_review');
});

void test('detects an explicitly present key even when its value is empty', () => {
  const [card] = parseV5Insights(
    '# I001\n\nTitle:\nEvidence:\n\nNeeds a human decision.\n',
    classifySummaryLines(summary),
  );
  assert.deepEqual(card.presentKeys, ['title', 'evidence']);
  assert.equal(card.title, 'Needs a human decision.');
  assert.equal(card.status, 'needs_review');
});

void test('rejects heading-only evidence', () => {
  assert.throws(
    () =>
      parseV5Insights(
        [
          '# I001',
          'Title: Invalid evidence',
          'Type: Reusable task or technical lesson',
          'Applies when: Testing.',
          'Scope: This test.',
          'Takeaway: Do not cite headings.',
          'Why: Headings are navigation.',
          'Evidence: L001',
        ].join('\n'),
        classifySummaryLines(summary),
      ),
    /invalid Evidence/,
  );
});

void test('relabels surviving lines and invalidates cards that lose evidence', () => {
  const lines = classifySummaryLines('First\nSecond\nThird\n');
  const { lines: relabeled, idMap } = relabelSummaryLines([
    lines[0],
    lines[2],
  ]);
  const [card] = remapInsightEvidence(
    [
      {
        id: 'I001',
        sourceId: 'I001',
        title: 'Example',
        type: 'agent encountered',
        appliesWhen: 'Testing.',
        scope: 'This test.',
        takeaway: 'Keep mappings explicit.',
        why: 'Silent drift breaks provenance.',
        originalText: 'Original',
        text: 'Current',
        evidence: ['L002', 'L003'],
        status: 'accepted',
      },
    ],
    idMap,
    new Set(['L002']),
  );
  assert.deepEqual(
    relabeled.map((line) => line.id),
    ['L001', 'L002'],
  );
  assert.deepEqual(card.evidence, ['L002']);
  assert.equal(card.status, 'needs_review');
});
