import {
  insightKeys,
  isSkillCandidateProtocol,
  insightKeysForProtocol,
  hasWorkflowField,
  skillInsightTypes,
  type Insight,
  type Review,
  type ReviewSavePayload,
} from './review-types.ts';
import { validateSummaryGroups } from './summary-format.ts';
import {
  classifySummaryLines,
  summaryMarkdown,
  parseV5Insights,
  serializeInsights,
} from './v5-format.ts';

const lineId = /^L\d{3,}$/;
const insightId = /^I\d{3,}$/;
const groupId = /^G\d{3,}$/;
const insightStatuses = new Set([
  'pending',
  'accepted',
  'rejected',
  'needs_review',
]);

export function isValidPayload(value: unknown): value is ReviewSavePayload {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Partial<ReviewSavePayload>;
  const statuses = new Set(['ready', 'in_review', 'completed']);
  if (
    !payload.trajectorySummary ||
    typeof payload.trajectorySummary.text !== 'string' ||
    !Array.isArray(payload.summaryGroups) ||
    !Array.isArray(payload.summaryLines) ||
    !Array.isArray(payload.insights)
  )
    return false;
  if (
    typeof payload.note !== 'string' ||
    !payload.status ||
    !statuses.has(payload.status)
  )
    return false;

  const summaryIds = new Set(
    payload.summaryLines
      .filter(
        (line) => line && lineId.test(line.id) && typeof line.text === 'string',
      )
      .map((line) => line.id),
  );
  if (summaryIds.size !== payload.summaryLines.length) return false;
  const hasHierarchy = Boolean(
    payload.trajectorySummary.text || payload.summaryGroups.length,
  );
  if (
    hasHierarchy &&
    (!payload.trajectorySummary.text ||
      !payload.summaryGroups.every(
        (group) =>
          group &&
          groupId.test(group.id) &&
          typeof group.text === 'string' &&
          Array.isArray(group.lineIds) &&
          group.lineIds.every((id) => summaryIds.has(id)),
      ) ||
      !validateSummaryGroups(payload.summaryGroups, payload.summaryLines))
  )
    return false;

  return payload.insights.every(
    (insight) =>
      insight &&
      insightId.test(insight.id) &&
      typeof insight.title === 'string' &&
      typeof insight.text === 'string' &&
      (insight.authorship === undefined || insight.authorship === 'reviewer') &&
      (insight.authorship !== 'reviewer' ||
        [
          insight.title,
          insight.type,
          ...(insight.description !== undefined || insight.example !== undefined
            ? [
                insight.description,
                ...(insight.workflow !== undefined ? [insight.workflow] : []),
                insight.example,
              ]
            : [insight.scope, insight.takeaway]),
        ].every(
          (value) => typeof value === 'string' && Boolean(value.trim()),
        )) &&
      insightStatuses.has(insight.status) &&
      Array.isArray(insight.evidence) &&
      insight.evidence.every((id) => summaryIds.has(id)),
  );
}

function candidateRoundTrips(
  insight: Insight,
  payload: ReviewSavePayload,
  protocolVersion: number,
) {
  try {
    const cards = parseV5Insights(
      serializeInsights([{ ...insight, status: 'accepted' }], protocolVersion),
      payload.summaryLines,
      protocolVersion,
      { allowEmptyEvidence: true },
    );
    return (
      cards.length === 1 &&
      cards[0].title === insight.title &&
      cards[0].description === insight.description?.trim() &&
      cards[0].example === insight.example?.trim() &&
      cards[0].workflow === insight.workflow?.trim()
    );
  } catch {
    return false;
  }
}

export function isValidV5Review(review: Review, payload: ReviewSavePayload) {
  if (review.format !== 'v5') return true;
  const contentIds = new Set(
    payload.summaryLines
      .filter((line) => line.kind === 'content')
      .map((line) => line.id),
  );
  const validLines = payload.summaryLines.every(
    (line, index) =>
      line.id === `L${String(index + 1).padStart(3, '0')}` &&
      (line.ending === '' ||
        line.ending === '\n' ||
        line.ending === '\r\n' ||
        line.ending === undefined) &&
      !line.text.includes('\n') &&
      !line.text.includes('\r'),
  );
  const classifiedLines = classifySummaryLines(
    summaryMarkdown(payload.summaryLines),
  );
  const validKinds = classifiedLines.every(
    (line, index) => line.kind === payload.summaryLines[index]?.kind,
  );
  const candidateSchema = isSkillCandidateProtocol(review.protocolVersion);
  const candidateKeys = insightKeysForProtocol(review.protocolVersion);
  const workflow = hasWorkflowField(review.protocolVersion);
  const validCards = payload.insights.every(
    (insight, index) =>
      insight.id === `I${String(index + 1).padStart(3, '0')}` &&
      Boolean(insight.title.trim()) &&
      (candidateSchema
        ? [
            insight.description,
            ...(workflow ? [insight.workflow] : []),
            insight.example,
          ].every(
            (value) => typeof value === 'string' && Boolean(value.trim()),
          ) &&
          (workflow || insight.workflow === undefined) &&
          skillInsightTypes.some((type) => type === insight.type) &&
          !/[\r\n]/.test(insight.title) &&
          !insight.text.trim() &&
          [
            insight.scope,
            insight.takeaway,
            insight.appliesWhen,
            insight.why,
          ].every((value) => value === undefined) &&
          Array.isArray(insight.presentKeys) &&
          insight.presentKeys.length === candidateKeys.length &&
          candidateKeys.every((key) => insight.presentKeys!.includes(key)) &&
          new Set(insight.evidence).size === insight.evidence.length &&
          candidateRoundTrips(insight, payload, review.protocolVersion)
        : insight.description === undefined &&
          insight.workflow === undefined &&
          insight.example === undefined) &&
      (insight.type === undefined || typeof insight.type === 'string') &&
      (insight.appliesWhen === undefined ||
        typeof insight.appliesWhen === 'string') &&
      (insight.scope === undefined || typeof insight.scope === 'string') &&
      (insight.takeaway === undefined ||
        typeof insight.takeaway === 'string') &&
      (insight.why === undefined || typeof insight.why === 'string') &&
      (insight.presentKeys === undefined ||
        (Array.isArray(insight.presentKeys) &&
          new Set(insight.presentKeys).size === insight.presentKeys.length &&
          insight.presentKeys.every((key) => insightKeys.includes(key)))) &&
      (insight.authorship === 'reviewer' ||
        insight.evidence.length > 0 ||
        insight.status === 'needs_review' ||
        insight.status === 'rejected') &&
      insight.evidence.every((id) => contentIds.has(id)),
  );
  const canComplete =
    payload.status !== 'completed' ||
    (review.privacyStatus === 'redacted' &&
      payload.insights.every(
        (insight) =>
          insight.status === 'accepted' || insight.status === 'rejected',
      ));
  return validLines && validKinds && validCards && canComplete;
}
