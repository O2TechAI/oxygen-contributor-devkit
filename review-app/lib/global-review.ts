import type {
  ReviewCreatePayload,
  ReviewHierarchy,
  SummaryLine,
} from './review-types.ts';
import {
  classifySummaryLines,
  parseV5Insights,
  serializeInsights,
  sha256,
} from './v5-format.ts';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid global review object.');
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error('Missing global review field.');
  return value;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Invalid global review list.');
  return value;
}
export function globalImportPayload(value: unknown): ReviewCreatePayload {
  const data = object(value);
  return {
    projectName: 'Global insights',
    sourcePath: 'cross-session-candidates',
    format: 'global',
    protocolVersion: 9,
    stage: 'insight',
    summaryMarkdown: '',
    insightMarkdown: '',
    globalCandidates: data,
  };
}

/** Adapt qualified evidence to stable local IDs; retain source identities for display/export. */
export async function parseGlobalReview(payload: ReviewCreatePayload) {
  const data = object(payload.globalCandidates);
  if (
    data.format !== 'oxygen-cross-session-candidates/v2' ||
    data.status !== 'draft'
  )
    throw new Error('Expected a draft cross-session candidates v2 artifact.');
  const sources = list(data.sources);
  if (sources.length < 2)
    throw new Error('Global review requires at least two trajectories.');
  const summaryLines: SummaryLine[] = [];
  const references = new Map<string, string>();
  const identities = new Map<string, string>();
  const globalSources: NonNullable<ReviewHierarchy['globalSources']> = [];
  for (const item of sources) {
    const source = object(item);
    const sid = text(source.id);
    if (!/^S\d{3,}$/.test(sid) || identities.has(sid))
      throw new Error('Invalid or duplicate source ID.');
    identities.set(sid, text(source.trajectoryKey));
    const projectName = text(source.projectName);
    if (/[\r\n]/.test(projectName))
      throw new Error('Source project name must be one line.');
    globalSources.push({
      id: sid,
      reviewId: text(source.reviewId),
      projectName,
    });
    const append = (line: SummaryLine) => {
      const id = `L${String(summaryLines.length + 1).padStart(3, '0')}`;
      summaryLines.push({ ...line, id });
      return id;
    };
    for (const line of classifySummaryLines(`## ${sid} · ${projectName}\n\n`))
      append({ ...line, sourceId: undefined });
    const originals = list(source.summaryLines).map(object);
    if (!originals.length) throw new Error('Source summary is empty.');
    const markdown = originals
      .map((line, index) => {
        if (
          line.id !== `L${String(index + 1).padStart(3, '0')}` ||
          typeof line.text !== 'string' ||
          /[\r\n]/.test(line.text)
        )
          throw new Error('Invalid source summary lines.');
        if (
          line.ending !== undefined &&
          !['', '\n', '\r\n'].includes(line.ending as string)
        )
          throw new Error('Invalid line ending.');
        return line.text + '\n';
      })
      .join('');
    for (const line of classifySummaryLines(markdown)) {
      const qualified = `${sid}:${line.id}`;
      const id = append({ ...line, sourceId: qualified });
      if (line.kind === 'content') references.set(qualified, id);
    }
    for (const line of classifySummaryLines('\n'))
      append({ ...line, sourceId: undefined });
  }
  const insights = list(data.candidates).map((item, index) => {
    const card = object(item);
    const id = `I${String(index + 1).padStart(3, '0')}`;
    if (
      card.id !== `C${String(index + 1).padStart(3, '0')}` ||
      card.status !== 'draft'
    )
      throw new Error('Invalid global candidate ID or status.');
    const evidence = list(card.evidence).map(text);
    if (
      new Set(evidence).size !== evidence.length ||
      evidence.some((ref) => !references.has(ref))
    )
      throw new Error('Invalid global evidence reference.');
    const supporting = new Set(
      evidence.map((ref) => identities.get(ref.split(':')[0])),
    );
    if (supporting.size < 2)
      throw new Error('Each global candidate needs two distinct trajectories.');
    const fields = [
      'title',
      'type',
      'description',
      'workflow',
      'example',
    ] as const;
    const values = Object.fromEntries(
      fields.map((key) => [key, text(card[key])]),
    );
    const markdown =
      `# ${id}\n\n` +
      fields
        .map(
          (key) =>
            `${key[0].toUpperCase()}${key.slice(1)}:${['title', 'type'].includes(key) ? ' ' : '\n'}${values[key]}`,
        )
        .join('\n\n') +
      `\n\nEvidence: ${evidence.map((ref) => references.get(ref)).join(', ')}\n`;
    const parsed = parseV5Insights(markdown, summaryLines, 9);
    if (
      parsed.length !== 1 ||
      fields.some((key) => parsed[0][key] !== values[key].trim())
    )
      throw new Error('Global card fields change structure.');
    return {
      ...parsed[0],
      sourceId: card.id as string,
      status: 'pending' as const,
    };
  });
  // Exercise the same serializer used by editing/export before accepting the import.
  parseV5Insights(
    serializeInsights(
      insights.map((card) => ({ ...card, status: 'accepted' })),
      9,
    ),
    summaryLines,
    9,
  );
  const hierarchy: ReviewHierarchy = {
    trajectorySummary: { text: '', originalText: '' },
    summaryGroups: [],
    format: 'v5',
    protocolVersion: 9,
    stage: 'insight',
    privacyStatus: 'unknown',
    reviewLevel: 'global',
    globalSources,
    provenance: {
      hashVerified: false,
      runComplete: true,
      artifactHashes: {
        'cross_session_insights.json': await sha256(JSON.stringify(data)),
      },
    },
  };
  return { summaryLines, insights, hierarchy };
}
