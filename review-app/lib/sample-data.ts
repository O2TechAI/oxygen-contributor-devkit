import type { Insight, Review } from './review-types';
import { classifySummaryLines } from './v5-format';

// Fictional content for demonstrating Markdown, evidence links, and optional keys.
const richSummary = `# Overview

This synthetic example follows a review of a fictional library catalog export.

1. **Keep catalog titles intact when exporting a reading list.**
2. Limit catalog changes to the fields the reviewer approved.
3. Check the source of imported catalog records before relying on them.

The reviewer requested a preview before applying bulk changes.

> Retain the decision, its scope, and the evidence that supports it.

---

## Catalog export review

The proposed export preserves titles such as \`A Sample Story\`.

| Surface | Finding | Review status |
| --- | --- | --- |
| Reading list | Titles remain intact | Accepted |
| Catalog editing | Only approved fields should change | Needs decision |
| Import | Record sources still need verification | Pending |

### Next decision

- [x] Preview the reading list
- [ ] Verify imported record sources
`;

const summaryLines = classifySummaryLines(richSummary);

function lineId(fragment: string) {
  const line = summaryLines.find((item) => item.text.includes(fragment));
  if (!line) throw new Error(`Missing example Summary line: ${fragment}`);
  return line.id;
}

const insights: Insight[] = [
  {
    id: 'I001',
    sourceId: 'I001',
    title: 'Preserve titles in reading-list exports',
    presentKeys: ['title', 'type', 'scope', 'takeaway', 'evidence'],
    type: 'user explicit',
    scope: 'Reading-list exports in this fictional catalog review.',
    takeaway:
      'Check the exported list to confirm that each catalog title remains intact.',
    evidence: [lineId('Keep catalog titles'), lineId('preserves titles')],
    text: '',
    originalText: '',
    status: 'pending',
  },
  {
    id: 'I002',
    sourceId: 'I002',
    title: 'Limit edits to approved catalog fields',
    presentKeys: ['title', 'type', 'takeaway', 'evidence'],
    type: 'user implicit',
    takeaway:
      'Preview bulk changes and limit them to the catalog fields the reviewer approved.',
    evidence: [lineId('Limit catalog changes'), lineId('requested a preview')],
    text: 'This card intentionally has no Scope key.',
    originalText: '',
    status: 'pending',
  },
  {
    id: 'I003',
    sourceId: 'I003',
    title: 'Imported record sources remain unverified',
    presentKeys: ['type', 'scope', 'evidence'],
    type: 'agent encountered',
    scope: 'The fictional catalog import in this example.',
    evidence: [lineId('Check the source'), lineId('Record sources still')],
    text: 'Source verification is still pending. This card intentionally has no Title or Takeaway key.',
    originalText: '',
    status: 'pending',
  },
];

const generatedAt = '2026-01-01T00:00:00.000Z';

export const sampleReviews: Review[] = [
  {
    id: 'rich-summary-insight-keys-example',
    projectName: 'Example · Rich Summary + Insight Keys',
    sourcePath: 'example/rich-summary-insight-keys',
    status: 'ready',
    generatedAt,
    updatedAt: generatedAt,
    revisionCount: 0,
    format: 'v5',
    protocolVersion: 5,
    stage: 'redaction',
    privacyStatus: 'redacted',
    provenance: {
      model: 'Example fixture',
      reasoningEffort: 'n/a',
      hashVerified: false,
      runComplete: true,
    },
    trajectorySummary: { originalText: '', text: '' },
    summaryGroups: [],
    summaryLines,
    insights,
  },
];
