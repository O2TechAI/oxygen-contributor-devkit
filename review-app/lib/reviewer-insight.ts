import {
  insightTypesForProtocol,
  insightKeysForProtocol,
  hasWorkflowField,
  isSkillCandidateProtocol,
  type Insight,
  type SummaryLine,
} from './review-types.ts';
import {
  parseV5Insights,
  serializeInsights,
  skillMarkdownLines,
} from './v5-format.ts';

export const insightDraftExample = `Title: A useful behavior or decision
Type: user explicit
Scope: When this applies and its limits.
Takeaway:

**What to do:** Explain how future work should change, with enough context and reasoning to apply it.

**Limits or checks:** Preserve qualifications, uncertainty, and relevant checks.

Evidence:`;

export const skillInsightDraftExample = `Title: Recoverable Batch Processing
Type: agent
Description:

Recover from partial failures in batch jobs without repeating completed work. Use when imports, document transformations, or evaluation jobs need explicit item accounting and selective retries.

Example:

### Recorded walkthrough

Describe the starting problem and inputs. Explain the consequential decisions and actions, why they mattered, and the reported or observed outcome. Include the details needed to understand the overall flow.

### Adapting the approach

Suggest what carries over to another project, what must change, and how someone could use the method. Clearly distinguish these suggestions from recorded events.

Evidence:`;

export const workflowInsightDraftExample = `Title: Recoverable Batch Processing
Type: agent
Description:

Recover incomplete batch jobs while preserving valid completed work. Use when independently verifiable items are processed through unreliable services.

Workflow:

Explain the inferred reusable actions, decisions, and essential constraints. Generalize incidental project details; choose paragraphs or steps to suit the method.

Example:

Show how the method was applied in a recorded situation. Abstract the setting into understandable tasks, roles, and constraints; explain the consequential choices and results. Keep discovery history only when it clarifies the application. Preserve recorded actions and outcome status without adding proposed steps or inventing success.

Evidence:`;

export function reviewerInsightExample(protocolVersion: number) {
  return hasWorkflowField(protocolVersion)
    ? workflowInsightDraftExample
    : isSkillCandidateProtocol(protocolVersion)
      ? skillInsightDraftExample
      : insightDraftExample;
}

export function reviewerInsightPromptPath(protocolVersion: number) {
  return hasWorkflowField(protocolVersion)
    ? '/reviewer-insight-prompt.md'
    : isSkillCandidateProtocol(protocolVersion)
      ? '/reviewer-insight-prompt-v8.md'
      : '/reviewer-insight-prompt-v7.md';
}

type RequiredInsightField =
  | 'title'
  | 'type'
  | 'description'
  | 'workflow'
  | 'example'
  | 'scope'
  | 'takeaway';

export function parseReviewerInsight(
  id: string,
  markdown: string,
  summaryLines: SummaryLine[],
  protocolVersion = 7,
): Insight {
  let source = markdown.replace(/\r\n/g, '\n').trim();
  // Chatbots commonly wrap the whole answer in a Markdown fence.
  const fence = source.match(
    /^(`{3,}|~{3,})(?:markdown|md)?[ \t]*\n([\s\S]*)\n\1$/i,
  );
  if (fence) source = fence[2].trim();
  if (!source) throw new Error('Paste an insight before adding it.');
  const candidate = isSkillCandidateProtocol(protocolVersion);
  if (candidate) {
    const entries = skillMarkdownLines(source);
    const headings = entries.filter(
      ({ line, structural }) => structural && /^# I\d{3,}[ \t]*$/.test(line),
    );
    if (headings.length > 1) throw new Error('Paste one insight at a time.');
    source = entries
      .map(({ line, structural }) =>
        structural && /^# I\d{3,}[ \t]*$/.test(line) ? '# I001' : line,
      )
      .join('\n');
    if (!headings.length) source = `# I001\n\n${source}`;
    if (
      !entries.some(
        ({ line, structural }) => structural && line.startsWith('Evidence:'),
      )
    )
      source += '\n\nEvidence:';
  } else {
    const headers = source.match(/^# I\d{3,}[ \t]*$/gm) ?? [];
    if (headers.length > 1) throw new Error('Paste one insight at a time.');
    if (headers.length) source = source.replace(/^# I\d{3,}[ \t]*$/m, '# I001');
    else source = `# I001\n\n${source}`;
    if (!/^Evidence\s*:/im.test(source)) source += '\n\nEvidence:';
    if (!source.match(/^Title:[ \t]*(.*)$/im)?.[1].trim())
      throw new Error('Include a nonempty Title field.');
  }
  const card = parseV5Insights(source, summaryLines, protocolVersion, {
    allowEmptyEvidence: true,
  })[0];
  const insightTypes = insightTypesForProtocol(protocolVersion);
  for (const field of (candidate
    ? insightKeysForProtocol(protocolVersion).filter(
        (field) => field !== 'evidence',
      )
    : ['title', 'type', 'scope', 'takeaway']) as RequiredInsightField[]) {
    if (!card?.presentKeys?.includes(field) || !card[field]?.trim())
      throw new Error(
        `Include a nonempty ${field[0].toUpperCase() + field.slice(1)} field.`,
      );
  }
  if (!insightTypes.includes(card.type as (typeof insightTypes)[number]))
    throw new Error(`Type must be ${insightTypes.join(', ')}.`);
  if (card.text.trim() || card.appliesWhen || card.why)
    throw new Error(
      candidate
        ? `Use only ${insightKeysForProtocol(protocolVersion)
            .filter((field) => field !== 'evidence')
            .map((field) => field[0].toUpperCase() + field.slice(1))
            .join(', ')}, and optional Evidence.`
        : 'Use only Title, Type, Scope, Takeaway, and optional Evidence. Put developed paragraphs inside Takeaway.',
    );
  return {
    ...card,
    id,
    sourceId: undefined,
    authorship: 'reviewer',
    originalText: '',
    status: 'pending',
  };
}

export function reviewerInsightDraft(
  insight: Insight,
  protocolVersion = 7,
): string {
  return serializeInsights(
    [{ ...insight, status: 'accepted' }],
    protocolVersion,
  )
    .replace(/^# I\d{3,}\n\n/, '')
    .trim();
}
