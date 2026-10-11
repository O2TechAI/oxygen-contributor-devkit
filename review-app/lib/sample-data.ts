import type { Insight, Review } from './review-types';
import { classifySummaryLines } from './v5-format';

// Fictional content for demonstrating v9 skill candidates, Markdown, and evidence links.
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
    title: 'Export Fidelity Review',
    presentKeys: [
      'title',
      'type',
      'description',
      'workflow',
      'example',
      'evidence',
    ],
    type: 'user-agent',
    description:
      'Check that exported content preserves source values. Use when transforming records for another surface.',
    workflow:
      '1. Identify values that must remain intact.\n2. Compare an export preview with the source.\n3. Record what was checked and leave unchecked cases open.',
    example:
      'In this fictional catalog review, the reviewer required intact titles. The proposed export preserved titles such as `A Sample Story`, and the reading-list preview was marked complete.',
    evidence: [
      lineId('Keep catalog titles'),
      lineId('preserves titles'),
      lineId('[x] Preview'),
    ],
    text: '',
    originalText: '',
    status: 'pending',
  },
  {
    id: 'I002',
    sourceId: 'I002',
    title: 'Approved-Field Change Review',
    presentKeys: [
      'title',
      'type',
      'description',
      'workflow',
      'example',
      'evidence',
    ],
    type: 'user-agent',
    description:
      'Constrain bulk edits to approved fields. Use when changes could affect records beyond the requested scope.',
    workflow:
      '1. List the approved fields.\n2. Check a change preview against that list.\n3. Obtain the required decision before applying changes outside the approved scope.',
    example:
      'The fictional catalog reviewer requested a preview before bulk changes and limited edits to approved fields. Catalog editing still needed a decision; the summary does not establish that changes were applied.',
    evidence: [
      lineId('Limit catalog changes'),
      lineId('requested a preview'),
      lineId('Only approved fields'),
    ],
    text: '',
    originalText: '',
    status: 'pending',
  },
  {
    id: 'I003',
    sourceId: 'I003',
    title: 'Import Provenance Review',
    presentKeys: [
      'title',
      'type',
      'description',
      'workflow',
      'example',
      'evidence',
    ],
    type: 'user-agent',
    description:
      'Identify source checks needed before relying on imported records. Use when import provenance has not been verified.',
    workflow:
      '1. Identify the source of imported records.\n2. Check the available source evidence.\n3. Keep unresolved verification visible.',
    example:
      'The fictional catalog review called for checking imported record sources. Verification remained an unchecked next step. This workflow is a proposed method, not a completed verification.',
    evidence: [
      lineId('Check the source'),
      lineId('Record sources still'),
      lineId('[ ] Verify'),
    ],
    text: '',
    originalText: '',
    status: 'pending',
  },
];

const generatedAt = '2026-01-01T00:00:00.000Z';

export const sampleReviews: Review[] = [
  {
    id: 'v9-skill-candidates-example',
    projectName: 'Example · v9 Skill Candidates',
    sourcePath: 'example/v9-skill-candidates',
    status: 'ready',
    generatedAt,
    updatedAt: generatedAt,
    revisionCount: 0,
    format: 'v5',
    protocolVersion: 9,
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
