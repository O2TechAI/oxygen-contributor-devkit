import type {
  SummaryGroup,
  SummaryLine,
  TrajectorySummary,
} from './review-types';

export type ParsedSummary = {
  trajectorySummary: TrajectorySummary;
  summaryGroups: SummaryGroup[];
  summaryLines: SummaryLine[];
};

const lineIdPattern = /^L\d{3,}$/;

function collectSection(markdown: string, heading: RegExp) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => heading.test(line.trim()));
  if (start < 0) return '';
  const content: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^#{1,2}\s+/.test(lines[index].trim())) break;
    if (lines[index].trim()) content.push(lines[index].trim());
  }
  return content.join(' ').trim();
}

function expandLineReferences(value: string, orderedIds: string[]) {
  const positions = new Map(orderedIds.map((id, index) => [id, index]));
  const expanded: string[] = [];
  for (const token of value.split(',')) {
    const range = token
      .trim()
      .toUpperCase()
      .match(/^(L\d{3,})\s*[-–]\s*(L\d{3,})$/);
    if (range) {
      const start = positions.get(range[1]);
      const end = positions.get(range[2]);
      if (start !== undefined && end !== undefined && start <= end) {
        expanded.push(...orderedIds.slice(start, end + 1));
      }
      continue;
    }
    const id = token.trim().toUpperCase();
    if (lineIdPattern.test(id) && positions.has(id)) expanded.push(id);
  }
  return expanded.filter((id, index, ids) => ids.indexOf(id) === index);
}

export function parseSummary(markdown: string): ParsedSummary {
  const summaryLines: SummaryLine[] = [];
  for (const rawLine of markdown.split(/\r?\n/)) {
    const match = rawLine.trim().match(/^(L\d{3,})\s+(.+)$/);
    if (!match) continue;
    summaryLines.push({
      id: match[1],
      originalText: match[2],
      text: match[2],
    });
  }

  const orderedIds = summaryLines.map((line) => line.id);
  const trajectoryText = collectSection(
    markdown,
    /^#\s+Trajectory summary\s*$/i,
  );
  const trajectorySummary = {
    originalText: trajectoryText,
    text: trajectoryText,
  };

  const sections = markdown
    .split(/^##\s+(?=G\d{3,}\s*$)/gm)
    .filter((section) => /^G\d{3,}/.test(section.trim()));
  const summaryGroups = sections.flatMap((section): SummaryGroup[] => {
    const lines = section.trim().split(/\r?\n/);
    const id = lines.shift()?.trim() ?? '';
    const nextHeading = lines.findIndex((line) => /^#\s+/.test(line.trim()));
    const groupBody = nextHeading >= 0 ? lines.slice(0, nextHeading) : lines;
    const references = groupBody.find((line) => /^Lines:\s*/i.test(line));
    const lineIds = expandLineReferences(
      references?.replace(/^Lines:\s*/i, '') ?? '',
      orderedIds,
    );
    const text = groupBody
      .filter((line) => line !== references && line.trim())
      .map((line) => line.trim())
      .join(' ');
    if (!/^G\d{3,}$/.test(id) || !text || !lineIds.length) return [];
    return [{ id, originalText: text, text, lineIds }];
  });

  return { trajectorySummary, summaryGroups, summaryLines };
}

export function validateSummaryGroups(
  groups: SummaryGroup[],
  lines: SummaryLine[],
) {
  const orderedIds = lines.map((line) => line.id);
  const groupIds = new Set(groups.map((group) => group.id));
  if (
    new Set(orderedIds).size !== orderedIds.length ||
    groupIds.size !== groups.length ||
    groups.some((group) => !group.lineIds.length)
  )
    return false;
  const flattened = groups.flatMap((group) => group.lineIds);
  if (flattened.length !== orderedIds.length) return false;
  return flattened.every((id, index) => id === orderedIds[index]);
}
