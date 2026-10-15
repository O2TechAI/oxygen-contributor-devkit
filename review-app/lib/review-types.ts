export const insightTypes = [
  'user explicit',
  'user implicit',
  'agent encountered',
] as const;

export const skillInsightTypes = ['user-agent', 'agent'] as const;
export const skillInsightKeys = [
  'title',
  'type',
  'description',
  'example',
  'evidence',
] as const;
export const workflowInsightKeys = [
  'title',
  'type',
  'description',
  'workflow',
  'example',
  'evidence',
] as const;
export const legacyInsightKeys = [
  'title',
  'type',
  'scope',
  'takeaway',
  'evidence',
] as const;

export function isSkillCandidateProtocol(version: number) {
  return version === 8 || version === 9;
}

export function hasWorkflowField(version: number) {
  return version === 9;
}

export function insightTypesForProtocol(version: number): readonly string[] {
  return isSkillCandidateProtocol(version) ? skillInsightTypes : insightTypes;
}

export function insightKeysForProtocol(version: number): readonly InsightKey[] {
  return hasWorkflowField(version)
    ? workflowInsightKeys
    : isSkillCandidateProtocol(version)
      ? skillInsightKeys
      : legacyInsightKeys;
}

export const insightKeys = [
  'title',
  'type',
  'scope',
  'takeaway',
  'description',
  'workflow',
  'example',
  'evidence',
] as const;

export type InsightType = string;
export type InsightKey = (typeof insightKeys)[number];
export type InsightStatus =
  | 'pending'
  | 'accepted'
  | 'rejected'
  | 'needs_review';

export type SummaryLine = {
  id: string;
  sourceId?: string;
  originalText: string;
  text: string;
  ending?: '' | '\n' | '\r\n';
  kind?: 'heading' | 'content' | 'layout';
};

export type TrajectorySummary = {
  originalText: string;
  text: string;
};

export type SummaryGroup = {
  id: string;
  originalText: string;
  text: string;
  lineIds: string[];
};

export type Insight = {
  authorship?: 'reviewer';
  id: string;
  sourceId?: string;
  title: string;
  presentKeys?: InsightKey[];
  originalText: string;
  text: string;
  type?: InsightType;
  appliesWhen?: string;
  scope?: string;
  takeaway?: string;
  description?: string;
  workflow?: string;
  example?: string;
  why?: string;
  evidence: string[];
  status: InsightStatus;
};

const insightTypeAliases: Record<string, (typeof insightTypes)[number]> = {
  'explicit user preference or constraint': 'user explicit',
  'inferred user preference': 'user implicit',
  'reusable task or technical lesson': 'agent encountered',
};

export function normalizeInsightType(value?: string) {
  if (!value?.trim()) return undefined;
  const normalized = value.trim().toLowerCase();
  return insightTypeAliases[normalized] ?? normalized;
}

export type ReviewProvenance = {
  manifestSha256?: string;
  inputSha256?: string;
  artifactHashes?: Record<string, string>;
  model?: string;
  reasoningEffort?: string;
  hashVerified: boolean;
  runComplete: boolean;
};

export type Review = {
  id: string;
  projectName: string;
  sourcePath: string;
  status: 'ready' | 'in_review' | 'completed';
  generatedAt: string;
  updatedAt: string;
  revisionCount: number;
  /** Saved revision version; optional only for historical in-memory fixtures. */
  version?: number;
  /** Increases when history is sanitized. Do not reuse cached older history. */
  privacyEpoch?: number;
  format: 'legacy' | 'v5';
  protocolVersion: number;
  stage: 'historical' | 'insight' | 'redaction';
  privacyStatus: 'unknown' | 'unredacted' | 'redacted';
  provenance: ReviewProvenance;
  trajectorySummary: TrajectorySummary;
  summaryGroups: SummaryGroup[];
  summaryLines: SummaryLine[];
  insights: Insight[];
};

export type ReviewSavePayload = {
  expectedVersion?: number;
  requestId?: string;
  trajectorySummary: TrajectorySummary;
  summaryGroups: SummaryGroup[];
  summaryLines: SummaryLine[];
  insights: Insight[];
  note: string;
  status: Review['status'];
};

export type ReviewCreatePayload = {
  projectName: string;
  sourcePath: string;
  format?: 'legacy' | 'v5';
  protocolVersion?: number;
  stage?: 'insight' | 'redaction';
  summaryMarkdown: string;
  summaryLabeledMarkdown?: string;
  insightMarkdown: string;
  manifestJson?: string;
};

export type ReviewHierarchy = Pick<
  Review,
  'trajectorySummary' | 'summaryGroups'
> &
  Partial<
    Pick<
      Review,
      'format' | 'protocolVersion' | 'stage' | 'privacyStatus' | 'provenance'
    >
  >;

/** Exact saved content, without embedded originals or export-time decisions. */
export type ReviewState = {
  trajectorySummary: Omit<TrajectorySummary, 'originalText'>;
  summaryGroups: Omit<SummaryGroup, 'originalText'>[];
  summaryLines: Omit<SummaryLine, 'originalText'>[];
  insights: Omit<Insight, 'originalText'>[];
  status: Review['status'];
};

export type ReviewHistorySnapshot = {
  version: number;
  requestId?: string;
  kind: 'initial' | 'edit' | 'privacy';
  createdAt: string;
  note: string;
  state: ReviewState;
};

export type ReviewHistory = {
  review: Review;
  snapshots: ReviewHistorySnapshot[];
};

export type ReviewWriteResult = {
  review: Review;
  savedVersion: number;
  requestId: string;
  replayed?: boolean;
};

export type ReviewPrivacyPayload = {
  /** Only the sanitized current baseline is retained. */
  state: ReviewState;
  projectName: string;
  expectedVersion: number;
  /** Opaque UUID, never derived from private request text. */
  requestId: string;
  approvedInsightIds?: string[];
};

export type ReviewPrivacyResult = ReviewWriteResult & {
  archiveName: string;
  url: string;
};
