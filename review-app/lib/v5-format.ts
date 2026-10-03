import {
  insightKeys,
  isSkillCandidateProtocol,
  insightKeysForProtocol,
  hasWorkflowField,
  skillInsightTypes,
  type Insight,
  type InsightKey,
  type InsightStatus,
  type SummaryLine,
  normalizeInsightType,
} from './review-types.ts';

const recognizedFields: ReadonlyMap<string, string> = new Map([
  ['title', 'title'],
  ['type', 'type'],
  ['applies when', 'appliesWhen'],
  ['scope', 'scope'],
  ['takeaway', 'takeaway'],
  ['why', 'why'],
  ['evidence', 'evidence'],
] as const);

function physicalLines(markdown: string) {
  return markdown.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function splitEnding(value: string): {
  text: string;
  ending: SummaryLine['ending'];
} {
  if (value.endsWith('\r\n')) {
    return { text: value.slice(0, -2), ending: '\r\n' };
  }
  if (value.endsWith('\n')) return { text: value.slice(0, -1), ending: '\n' };
  return { text: value, ending: '' };
}

export function labelSummary(markdown: string) {
  return physicalLines(markdown)
    .map((line, index) => `L${String(index + 1).padStart(3, '0')} ${line}`)
    .join('');
}

export function classifySummaryLines(markdown: string): SummaryLine[] {
  let fence: { marker: '`' | '~'; length: number } | null = null;
  return physicalLines(markdown).map((rawLine, index) => {
    const { text, ending } = splitEnding(rawLine);
    const marker = text.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    let kind: SummaryLine['kind'] = 'content';
    if (fence) {
      if (
        marker &&
        marker[1][0] === fence.marker &&
        marker[1].length >= fence.length &&
        !marker[2].trim()
      ) {
        kind = 'layout';
        fence = null;
      }
    } else if (marker) {
      kind = 'layout';
      fence = {
        marker: marker[1][0] as '`' | '~',
        length: marker[1].length,
      };
    } else if (/^ {0,3}#{1,6}(?:\s|$)/.test(text)) {
      kind = 'heading';
    } else if (
      !text.trim() ||
      /^\s*(?:[-*_]\s*){3,}$/.test(text) ||
      /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/.test(text)
    ) {
      kind = 'layout';
    }
    const id = `L${String(index + 1).padStart(3, '0')}`;
    return {
      id,
      sourceId: id,
      originalText: text,
      text,
      ending,
      kind,
    };
  });
}

export function summaryMarkdown(lines: SummaryLine[]) {
  return lines.map((line) => line.text + (line.ending ?? '\n')).join('');
}

export function labeledSummaryMarkdown(lines: SummaryLine[]) {
  return lines
    .map((line) => `${line.id} ${line.text}${line.ending ?? '\n'}`)
    .join('');
}

function fallbackTitle(id: string, body: string) {
  const firstLine = body
    .split('\n')
    .find((line) => line.trim())
    ?.replace(/[*_`#]/g, '')
    .trim();
  if (!firstLine) return `Insight ${id}`;
  return firstLine.length > 72 ? `${firstLine.slice(0, 69)}…` : firstLine;
}

export function detectedInsightKeys(insight: Insight): InsightKey[] {
  if (insight.presentKeys) return insight.presentKeys;
  return insightKeys.filter((key) => {
    if (key === 'title') return Boolean(insight.title);
    if (key === 'type') return Boolean(insight.type);
    if (key === 'scope') return Boolean(insight.scope);
    if (key === 'takeaway') return Boolean(insight.takeaway);
    if (key === 'description') return Boolean(insight.description);
    if (key === 'workflow') return Boolean(insight.workflow);
    if (key === 'example') return Boolean(insight.example);
    return insight.evidence.length > 0;
  });
}

export function parseV5Insights(
  markdown: string,
  summaryLines: SummaryLine[],
  protocolVersion = 7,
  options: { allowEmptyEvidence?: boolean } = {},
): Insight[] {
  if (isSkillCandidateProtocol(protocolVersion)) {
    return parseSkillCandidates(
      markdown,
      summaryLines,
      options.allowEmptyEvidence ?? false,
      protocolVersion,
    );
  }
  if (!markdown.trim()) return [];
  const chunks = markdown.replace(/\r\n/g, '\n').split(/^# (I\d{3,})[ \t]*$/m);
  if (chunks[0].trim() || chunks.length % 2 !== 1) {
    throw new Error('Invalid Insight card format.');
  }
  const evidenceIds = new Set(
    summaryLines
      .filter((line) => line.kind === 'content')
      .map((line) => line.id),
  );
  const cards: Insight[] = [];
  for (let index = 1; index < chunks.length; index += 2) {
    const id = chunks[index];
    if (id !== `I${String(cards.length + 1).padStart(3, '0')}`) {
      throw new Error('Insight IDs must be sequential.');
    }
    const source = chunks[index + 1].trim();
    const values: Record<string, string> = {};
    const foundFields = new Set<string>();
    const bodyLines: string[] = [];
    const sourceLines = source.split('\n');
    for (let lineIndex = 0; lineIndex < sourceLines.length; lineIndex++) {
      const line = sourceLines[lineIndex];
      const match = line.match(/^\s*([A-Za-z][A-Za-z ]*?)\s*:\s*(.*?)\s*$/);
      const field = match
        ? recognizedFields.get(match[1].trim().toLowerCase())
        : undefined;
      if (!field || !match || foundFields.has(field)) {
        bodyLines.push(line);
        continue;
      }
      if (field === 'takeaway' && !match[2].trim()) {
        // An empty Takeaway header explicitly opens a Markdown block. Legacy
        // inline fields and ordinary card body text keep their existing meaning.
        const paragraphs: string[] = [];
        let end = lineIndex + 1;
        for (; end < sourceLines.length; end++) {
          // Why is retained for older seven-field cards edited in the app.
          if (/^\s*(?:Evidence|Why)\s*:/i.test(sourceLines[end])) break;
          if (/^[A-Za-z][A-Za-z ]*:/.test(sourceLines[end])) {
            throw new Error(`${id} has an unexpected field inside Takeaway.`);
          }
          paragraphs.push(sourceLines[end]);
        }
        values.takeaway = paragraphs.join('\n').trim();
        if (end === sourceLines.length || !values.takeaway) {
          throw new Error(
            `${id} requires a nonempty Takeaway block followed by Evidence.`,
          );
        }
        lineIndex = end - 1;
      } else {
        values[field] = match[2].trim();
      }
      foundFields.add(field);
    }
    const body = bodyLines.join('\n').trim();
    const evidence = values.evidence
      ? values.evidence
          .split(',')
          .map((value) => value.trim().toUpperCase())
          .filter(Boolean)
      : [];
    if (
      new Set(evidence).size !== evidence.length ||
      evidence.some((reference) => !evidenceIds.has(reference))
    ) {
      throw new Error(`${id} has invalid Evidence references.`);
    }
    const presentKeys = insightKeys.filter((key) => foundFields.has(key));
    cards.push({
      id,
      sourceId: id,
      title: values.title || fallbackTitle(id, body),
      presentKeys,
      type: normalizeInsightType(values.type),
      appliesWhen: values.appliesWhen,
      scope: values.scope,
      takeaway: values.takeaway,
      why: values.why,
      evidence,
      text: body,
      originalText: source,
      status: evidence.length ? 'pending' : 'needs_review',
    });
  }
  return cards;
}

export function skillMarkdownLines(
  markdown: string,
): { line: string; structural: boolean }[] {
  let fence: { character: string; length: number } | undefined;
  const result: { line: string; structural: boolean }[] = [];
  for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
    if (fence) {
      result.push({ line, structural: false });
      const closing = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
      if (
        closing &&
        closing[1][0] === fence.character &&
        closing[1].length >= fence.length
      )
        fence = undefined;
      continue;
    }
    const opening = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (opening && !(opening[1][0] === '`' && opening[2].includes('`'))) {
      fence = { character: opening[1][0], length: opening[1].length };
      result.push({ line, structural: false });
    } else result.push({ line, structural: true });
  }
  if (fence) throw new Error('Unclosed Markdown code fence.');
  return result;
}

// Protocols v8/v9 use explicit schemas; historical parsing remains unchanged.
function parseSkillCandidates(
  markdown: string,
  summaryLines: SummaryLine[],
  allowEmptyEvidence: boolean,
  protocolVersion: number,
): Insight[] {
  if (!markdown.trim()) return [];
  const blocks: {
    id: string;
    lines: { line: string; structural: boolean }[];
  }[] = [];
  for (const entry of skillMarkdownLines(markdown)) {
    const heading = entry.structural
      ? entry.line.match(/^# (I\d{3,})[ \t]*$/)
      : null;
    if (heading) blocks.push({ id: heading[1], lines: [] });
    else if (blocks.length) blocks[blocks.length - 1].lines.push(entry);
    else if (entry.line.trim()) throw new Error('Invalid Insight card format.');
  }
  const keys = insightKeysForProtocol(protocolVersion);
  const fields = keys.map((key) => key[0].toUpperCase() + key.slice(1));
  const blockFields = new Set(['Description', 'Workflow', 'Example']);
  const contentIds = new Set(
    summaryLines
      .filter((line) => line.kind === 'content')
      .map((line) => line.id),
  );
  const cards: Insight[] = [];
  for (const block of blocks) {
    const id = block.id;
    if (id !== `I${String(cards.length + 1).padStart(3, '0')}`)
      throw new Error('Insight IDs must be sequential.');
    const source = block.lines
      .map(({ line }) => line)
      .join('\n')
      .trim();
    const values = new Map<string, string[]>();
    let current = '';
    for (const { line, structural } of block.lines) {
      const header = structural
        ? line.match(/^([A-Za-z]+|Applies when):[ \t]*(.*)$/)
        : null;
      if (header) {
        if (header[1] !== fields[values.size])
          throw new Error(
            `${id} requires ${fields.join(', ')} in order, once each.`,
          );
        current = header[1];
        values.set(current, [header[2]]);
      } else if (line.trim()) {
        if (!blockFields.has(current))
          throw new Error(`${id} has unexpected card content.`);
        values.get(current)!.push(line);
      } else if (blockFields.has(current)) values.get(current)!.push(line);
    }
    const value = (field: string) => values.get(field)?.join('\n').trim() ?? '';
    if (
      values.size !== fields.length ||
      fields.some(
        (field) =>
          !value(field) && !(field === 'Evidence' && allowEmptyEvidence),
      )
    ) {
      throw new Error(`${id} requires nonempty ${fields.join(', ')} fields.`);
    }
    const type = value('Type');
    if (!skillInsightTypes.some((item) => item === type))
      throw new Error('Type must be user-agent or agent.');
    const evidence = value('Evidence')
      ? value('Evidence')
          .split(',')
          .map((ref) => ref.trim())
      : [];
    if (
      new Set(evidence).size !== evidence.length ||
      evidence.some((ref) => !contentIds.has(ref))
    )
      throw new Error(`${id} has invalid Evidence references.`);
    cards.push({
      id,
      sourceId: id,
      title: value('Title'),
      type,
      description: value('Description'),
      ...(hasWorkflowField(protocolVersion)
        ? { workflow: value('Workflow') }
        : {}),
      example: value('Example'),
      presentKeys: [...keys],
      evidence,
      text: '',
      originalText: source,
      status: evidence.length ? 'pending' : 'needs_review',
    });
  }
  return cards;
}

export function serializeInsights(
  insights: Insight[],
  protocolVersion = 7,
  selection: 'accepted' | 'all' = 'accepted',
) {
  const kept =
    selection === 'all'
      ? insights
      : insights.filter((insight) => insight.status === 'accepted');
  const exportId = (insight: Insight, index: number) =>
    selection === 'all' ? insight.id : `I${String(index + 1).padStart(3, '0')}`;
  if (isSkillCandidateProtocol(protocolVersion)) {
    return (
      kept
        .map((insight, index) =>
          [
            `# ${exportId(insight, index)}`,
            '',
            `Title: ${insight.title}`,
            `Type: ${insight.type}`,
            'Description:',
            '',
            insight.description ?? '',
            '',
            ...(hasWorkflowField(protocolVersion)
              ? ['Workflow:', '', insight.workflow ?? '', '']
              : []),
            'Example:',
            '',
            insight.example ?? '',
            '',
            `Evidence: ${insight.evidence.join(', ')}`,
          ].join('\n'),
        )
        .join('\n\n') + (kept.length ? '\n' : '')
    );
  }
  return (
    kept
      .map((insight, index) => {
        const keys = new Set(detectedInsightKeys(insight));
        const fields = [`# ${exportId(insight, index)}`, ''];
        if (keys.has('title')) fields.push(`Title: ${insight.title}`);
        if (keys.has('type') && insight.type) {
          fields.push(`Type: ${insight.type}`);
        }
        if (insight.appliesWhen) {
          fields.push(`Applies when: ${insight.appliesWhen}`);
        }
        if (keys.has('scope') && insight.scope) {
          fields.push(`Scope: ${insight.scope}`);
        }
        if (keys.has('takeaway') && insight.takeaway) {
          const takeaway = insight.takeaway;
          const block =
            /[\r\n]/.test(takeaway) || /^\*\*[^*\n]+\*\*/.test(takeaway);
          fields.push(
            block ? `Takeaway:\n\n${takeaway}\n` : `Takeaway: ${takeaway}`,
          );
        }
        if (insight.why) fields.push(`Why: ${insight.why}`);
        if (keys.has('evidence') || insight.authorship === 'reviewer') {
          fields.push(`Evidence: ${insight.evidence.join(', ')}`);
        }
        if (insight.text.trim()) fields.push('', insight.text.trim());
        return fields.join('\n');
      })
      .join('\n\n') + (kept.length ? '\n' : '')
  );
}

export function relabelSummaryLines(lines: SummaryLine[]) {
  const idMap = new Map<string, string>();
  const relabeled = lines.map((line, index) => {
    const id = `L${String(index + 1).padStart(3, '0')}`;
    idMap.set(line.id, id);
    return { ...line, id };
  });
  return { lines: relabeled, idMap };
}

export function remapInsightEvidence(
  insights: Insight[],
  idMap: Map<string, string>,
  invalidatedIds: Set<string>,
) {
  return insights.map((insight) => {
    const lostEvidence = insight.evidence.some((id) => invalidatedIds.has(id));
    const evidence = insight.evidence.flatMap((id) => {
      const next = idMap.get(id);
      return next ? [next] : [];
    });
    const status: InsightStatus =
      lostEvidence && insight.status !== 'rejected'
        ? 'needs_review'
        : insight.status;
    return { ...insight, evidence, status };
  });
}

export async function sha256(value: string) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}
