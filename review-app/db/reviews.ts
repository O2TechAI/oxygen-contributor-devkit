import { env } from 'cloudflare:workers';

import { sampleReviews } from '@/lib/sample-data';
import type {
  Insight,
  Review,
  ReviewCreatePayload,
  ReviewHierarchy,
  ReviewState,
  ReviewHistory,
  ReviewHistorySnapshot,
  ReviewPrivacyPayload,
  ReviewPrivacyResult,
  ReviewWriteResult,
  ReviewSavePayload,
  SummaryLine,
} from '@/lib/review-types';
import { isValidPayload, isValidV5Review } from '@/lib/review-validation';
import { insightKeys, normalizeInsightType } from '@/lib/review-types';
import { parseSummary, validateSummaryGroups } from '@/lib/summary-format';
import { parseGlobalReview } from '@/lib/global-review';
import { parseV5Review } from '@/lib/review-import';
import { exportLabelingSummary } from '@/lib/export-labeling';
import {
  labeledSummaryMarkdown,
  serializeInsights,
  summaryMarkdown,
} from '@/lib/v5-format';

type ReviewRow = {
  id: string;
  project_name: string;
  source_path: string;
  status: Review['status'];
  generated_at: string;
  original_summary_json: string;
  original_insights_json: string;
  original_hierarchy_json: string;
  current_summary_json: string;
  current_insights_json: string;
  current_hierarchy_json: string;
  updated_at: string;
  revision_count: number;
  version: number;
  privacy_epoch: number;
  initial_status: Review['status'];
  created_at: string;
};

let initialized = false;

function database() {
  if (!env.DB) throw new Error('D1 binding DB is unavailable.');
  return env.DB;
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function defaultHierarchy(): ReviewHierarchy {
  return {
    trajectorySummary: { originalText: '', text: '' },
    summaryGroups: [],
    format: 'legacy',
    protocolVersion: 1,
    stage: 'historical',
    privacyStatus: 'unknown',
    provenance: { hashVerified: false, runComplete: false },
  };
}

function normalizeHierarchy(value: string): ReviewHierarchy {
  const parsed = parseJson<ReviewHierarchy>(value);
  return { ...defaultHierarchy(), ...parsed };
}

function normalizeSummaryLine(line: SummaryLine): SummaryLine {
  return {
    ...line,
    kind: line.kind ?? 'content',
    ending: line.ending,
  };
}

function mapReview(row: ReviewRow): Review {
  const originalSummary = parseJson<SummaryLine[]>(
    row.original_summary_json,
  ).map(normalizeSummaryLine);
  const originalInsights = parseJson<Insight[]>(row.original_insights_json);
  const originalHierarchy = normalizeHierarchy(row.original_hierarchy_json);
  const currentHierarchy = normalizeHierarchy(row.current_hierarchy_json);
  const originalGroupsById = new Map(
    originalHierarchy.summaryGroups.map((group) => [group.id, group.text]),
  );
  const originalSummaryById = new Map(
    originalSummary.map((line) => [line.id, line.text]),
  );
  const originalInsightsById = new Map(
    originalInsights.map((insight) => [
      insight.id,
      insight.originalText ?? insight.text,
    ]),
  );

  return {
    id: row.id,
    projectName: row.project_name,
    sourcePath: row.source_path,
    status: row.status,
    generatedAt: row.generated_at,
    updatedAt: row.updated_at,
    revisionCount: Number(row.revision_count || 0),
    version: row.version,
    privacyEpoch: row.privacy_epoch,
    reviewLevel: currentHierarchy.reviewLevel,
    globalSources: currentHierarchy.globalSources,
    format: currentHierarchy.format ?? originalHierarchy.format ?? 'legacy',
    protocolVersion:
      currentHierarchy.protocolVersion ??
      originalHierarchy.protocolVersion ??
      1,
    stage: currentHierarchy.stage ?? originalHierarchy.stage ?? 'historical',
    privacyStatus:
      currentHierarchy.privacyStatus ??
      originalHierarchy.privacyStatus ??
      'unknown',
    provenance: currentHierarchy.provenance ??
      originalHierarchy.provenance ?? {
        hashVerified: false,
        runComplete: false,
      },
    trajectorySummary: {
      ...currentHierarchy.trajectorySummary,
      originalText:
        originalHierarchy.trajectorySummary.text ||
        (currentHierarchy.trajectorySummary.originalText ?? ''),
    },
    summaryGroups: currentHierarchy.summaryGroups.map((group) => ({
      ...group,
      originalText:
        originalGroupsById.get(group.id) ?? group.originalText ?? group.text,
    })),
    summaryLines: parseJson<SummaryLine[]>(row.current_summary_json).map(
      (line) => ({
        ...normalizeSummaryLine(line),
        originalText:
          originalSummaryById.get(line.sourceId ?? line.id) ??
          line.originalText ??
          line.text,
      }),
    ),
    insights: parseJson<Insight[]>(row.current_insights_json).map(
      (insight) => ({
        ...insight,
        presentKeys: insight.presentKeys?.filter((key) =>
          insightKeys.includes(key),
        ),
        type: normalizeInsightType(insight.type),
        status: insight.status ?? 'pending',
        originalText:
          insight.authorship === 'reviewer'
            ? (insight.originalText ?? '')
            : (originalInsightsById.get(insight.sourceId ?? insight.id) ??
              insight.originalText ??
              insight.text),
      }),
    ),
  };
}

function hierarchyFor(review: Review): ReviewHierarchy {
  return {
    trajectorySummary: review.trajectorySummary,
    summaryGroups: review.summaryGroups,
    reviewLevel: review.reviewLevel,
    globalSources: review.globalSources,
    format: review.format,
    protocolVersion: review.protocolVersion,
    stage: review.stage,
    privacyStatus: review.privacyStatus,
    provenance: review.provenance,
  };
}

async function ensureDatabase() {
  if (initialized) return;
  const db = database();
  // Seed a new database only; a removed sample must not reappear after reset.
  if (await db.prepare('SELECT id FROM reviews LIMIT 1').first()) {
    initialized = true;
    return;
  }
  const inserts = sampleReviews.map((review) =>
    db
      .prepare(`INSERT OR IGNORE INTO reviews (
        id, project_name, source_path, status, generated_at,
        original_summary_json, original_insights_json,
        original_hierarchy_json, current_summary_json, current_insights_json,
        current_hierarchy_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        review.id,
        review.projectName,
        review.sourcePath,
        review.status,
        review.generatedAt,
        JSON.stringify(review.summaryLines),
        JSON.stringify(review.insights),
        JSON.stringify(hierarchyFor(review)),
        JSON.stringify(review.summaryLines),
        JSON.stringify(review.insights),
        JSON.stringify(hierarchyFor(review)),
        review.generatedAt,
        review.updatedAt,
      ),
  );
  if (inserts.length) await db.batch(inserts);
  initialized = true;
}

export async function listReviews(): Promise<Review[]> {
  await ensureDatabase();
  const result = await database()
    .prepare(`SELECT reviews.*,
      COUNT(review_revisions.id) AS revision_count
    FROM reviews
    LEFT JOIN review_revisions ON review_revisions.review_id = reviews.id
    GROUP BY reviews.id
    ORDER BY CASE reviews.status WHEN 'ready' THEN 0 WHEN 'in_review' THEN 1 ELSE 2 END,
      reviews.updated_at DESC`)
    .all<ReviewRow>();
  return result.results.map(mapReview);
}

function parseLegacyInsights(
  markdown: string,
  summaryIds: Set<string>,
): Insight[] {
  const sections = markdown
    .split(/^#\s+(?=I\d{3,}\s*$)/gm)
    .filter((section) => /^I\d{3,}/.test(section.trim()));
  return sections.flatMap((section) => {
    const lines = section.trim().split(/\r?\n/);
    const id = lines.shift()?.trim() ?? '';
    const evidenceLine = lines.find((line) => /^Evidence:\s*/i.test(line));
    const evidence = (evidenceLine?.replace(/^Evidence:\s*/i, '') ?? '')
      .split(',')
      .map((value) => value.trim().toUpperCase())
      .filter(
        (value, index, values) =>
          summaryIds.has(value) && values.indexOf(value) === index,
      );
    const text = lines
      .filter((line) => line !== evidenceLine)
      .join('\n')
      .trim();
    if (!/^I\d{3,}$/.test(id) || !text || !evidence.length) return [];
    const firstSentence = text.split(/(?<=[.!?])\s/)[0].replace(/[*_`#]/g, '');
    return [
      {
        id,
        sourceId: id,
        title:
          firstSentence.length > 72
            ? `${firstSentence.slice(0, 69)}…`
            : firstSentence,
        originalText: text,
        text,
        evidence,
        status: 'pending' as const,
      },
    ];
  });
}

export async function createReview(
  payload: ReviewCreatePayload,
): Promise<Review> {
  await ensureDatabase();
  let summaryLines: SummaryLine[];
  let insights: Insight[];
  let hierarchy: ReviewHierarchy;
  if (payload.format === 'global') {
    ({ summaryLines, insights, hierarchy } = await parseGlobalReview(payload));
  } else if (payload.format === 'v5') {
    ({ summaryLines, insights, hierarchy } = await parseV5Review(payload));
  } else {
    const parsed = parseSummary(payload.summaryMarkdown);
    summaryLines = parsed.summaryLines;
    const summaryIds = new Set(summaryLines.map((line) => line.id));
    insights = parseLegacyInsights(payload.insightMarkdown, summaryIds);
    hierarchy = {
      ...defaultHierarchy(),
      trajectorySummary: parsed.trajectorySummary,
      summaryGroups: parsed.summaryGroups,
    };
    if (
      !parsed.trajectorySummary.text ||
      !summaryLines.length ||
      !validateSummaryGroups(parsed.summaryGroups, summaryLines) ||
      !insights.length
    ) {
      throw new Error(
        'The legacy Markdown does not contain a valid hierarchy and evidence-linked Insights.',
      );
    }
  }

  const now = new Date().toISOString();
  const slug =
    payload.projectName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48) || 'review';
  const reviewId = `${slug}-${crypto.randomUUID().slice(0, 8)}`;
  await database()
    .prepare(`INSERT INTO reviews (
    id, project_name, source_path, status, generated_at,
    original_summary_json, original_insights_json,
    original_hierarchy_json, current_summary_json, current_insights_json,
    current_hierarchy_json, created_at, updated_at
  ) VALUES (?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      reviewId,
      payload.projectName.trim(),
      payload.sourcePath.trim(),
      now,
      JSON.stringify(summaryLines),
      JSON.stringify(insights),
      JSON.stringify(hierarchy),
      JSON.stringify(summaryLines),
      JSON.stringify(insights),
      JSON.stringify(hierarchy),
      now,
      now,
    )
    .run();

  const reviews = await listReviews();
  return reviews.find((review) => review.id === reviewId)!;
}

export class ReviewWriteError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = 'ReviewWriteError';
  }
}

type RevisionRow = {
  revision_number: number;
  request_id: string | null;
  request_hash: string | null;
  kind: 'edit' | 'privacy';
  created_at: string;
  note: string;
  status: Review['status'];
  summary_json: string;
  insights_json: string;
  hierarchy_json: string;
};

/** Strip recursively: archived snapshots must never hide old originals. */
function cleanStateValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map(cleanStateValue) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'originalText')
        .map(([key, child]) => [key, cleanStateValue(child)]),
    ) as T;
  }
  return value;
}

function stateFor(value: Review | ReviewSavePayload): ReviewState {
  return cleanStateValue({
    trajectorySummary: value.trajectorySummary,
    summaryGroups: value.summaryGroups,
    summaryLines: value.summaryLines,
    insights: value.insights,
    status: value.status,
  });
}

function stateFromColumns(
  summary: string,
  insights: string,
  hierarchy: string,
  status: Review['status'],
): ReviewState {
  const parsed = normalizeHierarchy(hierarchy);
  return cleanStateValue({
    trajectorySummary: parsed.trajectorySummary,
    summaryGroups: parsed.summaryGroups,
    summaryLines: parseJson<SummaryLine[]>(summary),
    insights: parseJson<Insight[]>(insights),
    status,
  });
}

async function rowFor(reviewId: string): Promise<ReviewRow> {
  await ensureDatabase();
  const row = await database()
    .prepare(`SELECT reviews.*,
    (SELECT COUNT(*) FROM review_revisions WHERE review_id = reviews.id) AS revision_count
    FROM reviews WHERE id = ?`)
    .bind(reviewId)
    .first<ReviewRow>();
  if (!row) throw new ReviewWriteError('Review not found.', 404);
  return row;
}

async function rowWithHistory(reviewId: string) {
  await ensureDatabase();
  // A single SELECT provides a consistent snapshot even during privacy cleanup.
  const row = await database()
    .prepare(`SELECT reviews.*,
    (SELECT COUNT(*) FROM review_revisions WHERE review_id = reviews.id) AS revision_count,
    (SELECT json_group_array(json_object(
      'revision_number', revision_number, 'request_id', request_id, 'request_hash', request_hash,
      'kind', kind, 'created_at', created_at, 'note', note, 'status', status,
      'summary_json', summary_json, 'insights_json', insights_json, 'hierarchy_json', hierarchy_json))
      FROM (SELECT * FROM review_revisions WHERE review_id = reviews.id ORDER BY revision_number)) AS history_json
    FROM reviews WHERE id = ?`)
    .bind(reviewId)
    .first<ReviewRow & { history_json: string }>();
  if (!row) throw new ReviewWriteError('Review not found.', 404);
  return { row, revisions: parseJson<RevisionRow[]>(row.history_json) };
}

export async function getReviewHistory(
  reviewId: string,
): Promise<ReviewHistory> {
  const { row, revisions } = await rowWithHistory(reviewId);
  return {
    review: mapReview(row),
    snapshots: [
      {
        version: 0,
        kind: 'initial',
        createdAt: row.created_at,
        note: '',
        state: stateFromColumns(
          row.original_summary_json,
          row.original_insights_json,
          row.original_hierarchy_json,
          row.initial_status,
        ),
      },
      ...revisions.map(
        (revision): ReviewHistorySnapshot => ({
          version: revision.revision_number,
          ...(revision.request_id ? { requestId: revision.request_id } : {}),
          kind: revision.kind,
          createdAt: revision.created_at,
          note: revision.note,
          state: stateFromColumns(
            revision.summary_json,
            revision.insights_json,
            revision.hierarchy_json,
            revision.status,
          ),
        }),
      ),
    ],
  };
}

export function validWriteIdentity(
  value: unknown,
): value is { expectedVersion: number; requestId: string } {
  if (!value || typeof value !== 'object') return false;
  const payload = value as { expectedVersion?: unknown; requestId?: unknown };
  return (
    Number.isSafeInteger(payload.expectedVersion) &&
    Number(payload.expectedVersion) >= 0 &&
    typeof payload.requestId === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(payload.requestId)
  );
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => JSON.stringify(key) + ':' + canonical(child))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}

async function requestHash(value: unknown) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonical(value)),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

async function requestResult(
  reviewId: string,
  requestId: string,
  hash: string,
  replayed: boolean,
): Promise<ReviewWriteResult | undefined> {
  const { row, revisions } = await rowWithHistory(reviewId);
  const saved = revisions.find((revision) => revision.request_id === requestId);
  if (!saved) return undefined;
  if (saved.request_hash !== hash)
    throw new ReviewWriteError(
      'This request ID was already used for different changes.',
      409,
    );
  // Idempotent recovery returns the recorded result, not a later edit. Originals
  // are always fetched fresh so privacy cleanup cannot resurrect hidden text.
  const review = mapReview({
    ...row,
    current_summary_json: saved.summary_json,
    current_insights_json: saved.insights_json,
    current_hierarchy_json: saved.hierarchy_json,
    status: saved.status,
    updated_at: saved.created_at,
    version: saved.revision_number,
    revision_count: revisions.filter(
      (revision) => revision.revision_number <= saved.revision_number,
    ).length,
  });
  return {
    review,
    savedVersion: saved.revision_number,
    requestId,
    ...(replayed ? { replayed: true } : {}),
  };
}

function validateState(review: Review, state: ReviewState, note: string) {
  const payload = { ...state, note };
  if (
    !isValidPayload(payload) ||
    !isValidV5Review(review, payload) ||
    new Set(state.insights.map((insight) => insight.id)).size !==
      state.insights.length
  ) {
    throw new ReviewWriteError(
      'Invalid review fields, evidence, line IDs, or completion state.',
      400,
    );
  }
}

function columnsFor(state: ReviewState, hierarchy: ReviewHierarchy) {
  return [
    JSON.stringify(cleanStateValue(state.summaryLines)),
    JSON.stringify(cleanStateValue(state.insights)),
    JSON.stringify(
      cleanStateValue({
        ...hierarchy,
        trajectorySummary: state.trajectorySummary,
        summaryGroups: state.summaryGroups,
      }),
    ),
  ];
}

export async function saveReviewRevision(
  reviewId: string,
  payload: ReviewSavePayload,
): Promise<ReviewWriteResult> {
  if (!validWriteIdentity(payload))
    throw new ReviewWriteError(
      'A saved version and unique request ID are required.',
      400,
    );
  const state = stateFor(payload);
  const hash = await requestHash({
    kind: 'edit',
    expectedVersion: payload.expectedVersion,
    state,
    note: payload.note,
  });
  await ensureDatabase();
  const replay = await requestResult(reviewId, payload.requestId, hash, true);
  if (replay) return replay;
  const row = await rowFor(reviewId);
  validateState(mapReview(row), state, payload.note);
  if (row.version !== payload.expectedVersion)
    throw new ReviewWriteError(
      'Review changed. Read the latest state before saving.',
      409,
    );
  const db = database();
  const version = payload.expectedVersion + 1;
  const now = new Date().toISOString();
  const [summary, insights, hierarchy] = columnsFor(
    state,
    normalizeHierarchy(row.current_hierarchy_json),
  );
  // Both writes are in the same transaction. If another client wins after the
  // read above, the INSERT selects no rows and the UPDATE is also a no-op.
  await db.batch([
    db
      .prepare(`INSERT INTO review_revisions
      (review_id, revision_number, summary_json, insights_json, hierarchy_json, note, status, created_at, request_id, request_hash, kind)
      SELECT id, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'edit' FROM reviews
      WHERE id = ? AND version = ?`)
      .bind(
        version,
        summary,
        insights,
        hierarchy,
        payload.note,
        state.status,
        now,
        payload.requestId,
        hash,
        reviewId,
        payload.expectedVersion,
      ),
    db
      .prepare(`UPDATE reviews SET current_summary_json = ?, current_insights_json = ?,
      current_hierarchy_json = ?, status = ?, updated_at = ?, version = ?
      WHERE id = ? AND version = ? AND EXISTS
        (SELECT 1 FROM review_revisions WHERE review_id = ? AND request_id = ? AND request_hash = ?)`)
      .bind(
        summary,
        insights,
        hierarchy,
        state.status,
        now,
        version,
        reviewId,
        payload.expectedVersion,
        reviewId,
        payload.requestId,
        hash,
      ),
  ]);
  const result = await requestResult(reviewId, payload.requestId, hash, false);
  if (!result)
    throw new ReviewWriteError(
      'Review changed. Read the latest state before saving.',
      409,
    );
  return result;
}

/** Kept for internal callers; HTTP clients must supply their observed version. */
export async function saveRevision(
  reviewId: string,
  payload: ReviewSavePayload,
): Promise<Review> {
  const row = await rowFor(reviewId);
  return (
    await saveReviewRevision(reviewId, {
      ...payload,
      expectedVersion: payload.expectedVersion ?? row.version,
      requestId: payload.requestId ?? crypto.randomUUID(),
    })
  ).review;
}

/** Changed content and changed supporting context invalidate current approvals. */
function currentPrivacyState(
  before: ReviewState,
  sanitized: ReviewState,
): ReviewState {
  const sharedContextChanged =
    canonical(before.trajectorySummary) !==
      canonical(sanitized.trajectorySummary) ||
    canonical(before.summaryGroups) !== canonical(sanitized.summaryGroups);
  const beforeLines = new Map(
    before.summaryLines.map((line) => [line.id, line]),
  );
  const afterLines = new Map(
    sanitized.summaryLines.map((line) => [line.id, line]),
  );
  const oldCards = new Map(
    before.insights.map((card) => [card.sourceId ?? card.id, card]),
  );
  const content = ({
    status: _status,
    id: _id,
    ...card
  }: ReviewState['insights'][number]) => card;
  const insights = sanitized.insights.map((card) => {
    const previous = oldCards.get(card.sourceId ?? card.id);
    const affected =
      !previous ||
      sharedContextChanged ||
      canonical(content(previous)) !== canonical(content(card)) ||
      [...new Set([...previous.evidence, ...card.evidence])].some(
        (id) =>
          canonical(beforeLines.get(id)) !== canonical(afterLines.get(id)),
      );
    if (!affected) return card;
    return {
      ...card,
      status:
        card.authorship !== 'reviewer' && !card.evidence.length
          ? ('needs_review' as const)
          : ('pending' as const),
    };
  });
  return {
    ...sanitized,
    insights,
    status:
      sanitized.status === 'completed' &&
      insights.some(
        (card) => card.status === 'pending' || card.status === 'needs_review',
      )
        ? 'in_review'
        : sanitized.status,
  };
}

/** Remove hidden source mappings and unknown metadata, retaining only card content. */
function privacyBaseline(state: ReviewState): ReviewState {
  const select = <T extends object>(value: T, keys: string[]) =>
    Object.fromEntries(
      Object.entries(value).filter(([key]) => keys.includes(key)),
    );
  return {
    trajectorySummary: { text: state.trajectorySummary.text },
    summaryGroups: state.summaryGroups.map((group) => ({
      id: group.id,
      text: group.text,
      lineIds: group.lineIds,
    })),
    summaryLines: state.summaryLines.map((line) =>
      select(line, ['id', 'text', 'ending', 'kind']),
    ) as ReviewState['summaryLines'],
    insights: state.insights.map((card) =>
      select(card, [
        'id',
        'authorship',
        'title',
        'presentKeys',
        'text',
        'type',
        'appliesWhen',
        'scope',
        'takeaway',
        'description',
        'workflow',
        'example',
        'why',
        'evidence',
        'status',
      ]),
    ) as ReviewState['insights'],
    status: state.status,
  };
}

function validPrivacyOperation(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

export async function getPrivacyResetResult(
  operationId: string,
  expectedHash?: string,
): Promise<ReviewPrivacyResult> {
  if (!validPrivacyOperation(operationId))
    throw new ReviewWriteError('An opaque operation UUID is required.', 400);
  await ensureDatabase();
  const operation = await database()
    .prepare(
      'SELECT review_id, request_hash FROM review_privacy_operations WHERE operation_id = ?',
    )
    .bind(operationId)
    .first<{ review_id: string; request_hash: string }>();
  if (!operation) throw new ReviewWriteError('Saved baseline not found.', 404);
  if (expectedHash !== undefined && operation.request_hash !== expectedHash)
    throw new ReviewWriteError(
      'Operation ID already belongs to different baseline content.',
      409,
    );
  const row = await rowFor(operation.review_id);
  // Return the baseline even if ordinary editing has since continued. A later
  // privacy reset removes this operation, so it cannot revive earlier content.
  const review = mapReview({
    ...row,
    current_summary_json: row.original_summary_json,
    current_insights_json: row.original_insights_json,
    current_hierarchy_json: row.original_hierarchy_json,
    status: row.initial_status,
    version: 0,
    revision_count: 0,
    updated_at: row.created_at,
  });
  return {
    review,
    requestId: operationId,
    savedVersion: 0,
    replayed: true,
    archiveName: review.id,
    url: `/?review=${encodeURIComponent(review.id)}&changes=0`,
  };
}

export async function sanitizeReviewHistory(
  reviewId: string,
  payload: ReviewPrivacyPayload,
): Promise<ReviewPrivacyResult> {
  if (
    !validWriteIdentity(payload) ||
    !validPrivacyOperation(payload.requestId) ||
    !payload.state ||
    typeof payload.projectName !== 'string' ||
    !payload.projectName.trim() ||
    'snapshots' in payload
  ) {
    throw new ReviewWriteError(
      'Privacy now requires a sanitized current state, project name, and operation UUID; history rewrites are no longer supported.',
      400,
    );
  }
  const supplied = cleanStateValue(payload.state);
  const approved = payload.approvedInsightIds ?? [];
  if (!Array.isArray(approved) || approved.some((id) => typeof id !== 'string'))
    throw new ReviewWriteError('Explicit approvals must be insight IDs.', 400);
  // Hash only the surviving content and explicit choices, never old IDs,
  // revision counts, request text, source mappings or import receipts.
  let baseline: ReviewState;
  try {
    baseline = privacyBaseline(supplied);
  } catch {
    throw new ReviewWriteError('Invalid baseline state.', 400);
  }
  const hash = await requestHash({
    state: baseline,
    projectName: payload.projectName,
    approved,
  });
  try {
    return await getPrivacyResetResult(payload.requestId, hash);
  } catch (error) {
    if (!(error instanceof ReviewWriteError) || error.status !== 404)
      throw error;
  }
  const row = await rowFor(reviewId);
  if (row.version !== payload.expectedVersion)
    throw new ReviewWriteError(
      'Review changed. Read fresh state before resetting history.',
      409,
    );
  const review = mapReview(row);
  validateState(review, supplied, '');
  const current = privacyBaseline(
    currentPrivacyState(privacyBaseline(stateFor(review)), baseline),
  );
  if (approved.some((id) => !current.insights.some((card) => card.id === id)))
    throw new ReviewWriteError(
      'Explicit approval references a missing insight.',
      400,
    );
  current.insights = current.insights.map((card) =>
    approved.includes(card.id) ? { ...card, status: 'accepted' } : card,
  );
  validateState(review, current, '');
  const id = `review-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const hierarchy: ReviewHierarchy = {
    trajectorySummary: { ...current.trajectorySummary, originalText: '' },
    summaryGroups: current.summaryGroups.map((group) => ({
      ...group,
      originalText: '',
    })),
    reviewLevel: review.reviewLevel,
    format: review.format,
    protocolVersion: review.protocolVersion,
    stage: 'historical',
    privacyStatus: review.privacyStatus,
    provenance: { hashVerified: false, runComplete: false },
  };
  const [summary, insights, content] = columnsFor(current, hierarchy);
  const db = database();
  const gate =
    'EXISTS (SELECT 1 FROM review_privacy_operations WHERE operation_id = ? AND review_id = ?)';
  await db.batch([
    db
      .prepare(`INSERT INTO reviews (id, project_name, source_path, status, generated_at,
      original_summary_json, original_insights_json, original_hierarchy_json,
      current_summary_json, current_insights_json, current_hierarchy_json,
      created_at, updated_at, version, privacy_epoch, initial_status)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ? FROM reviews WHERE id = ? AND version = ?`)
      .bind(
        id,
        payload.projectName,
        `review:${id}`,
        current.status,
        now,
        summary,
        insights,
        content,
        summary,
        insights,
        content,
        now,
        now,
        current.status,
        reviewId,
        payload.expectedVersion,
      ),
    db
      .prepare(
        'INSERT INTO review_privacy_operations (operation_id, review_id, request_hash) SELECT ?, id, ? FROM reviews WHERE id = ?',
      )
      .bind(payload.requestId, hash, id),
    db
      .prepare(`DELETE FROM review_revisions WHERE review_id = ? AND ${gate}`)
      .bind(reviewId, payload.requestId, id),
    db
      .prepare(
        `DELETE FROM review_privacy_operations WHERE review_id = ? AND ${gate}`,
      )
      .bind(reviewId, payload.requestId, id),
    db
      .prepare(`DELETE FROM reviews WHERE id = ? AND version = ? AND ${gate}`)
      .bind(reviewId, payload.expectedVersion, payload.requestId, id),
  ]);
  try {
    return {
      ...(await getPrivacyResetResult(payload.requestId, hash)),
      replayed: false,
    };
  } catch (error) {
    if (error instanceof ReviewWriteError && error.status === 404)
      throw new ReviewWriteError(
        'Review changed. Read fresh state before resetting history.',
        409,
      );
    throw error;
  }
}

export async function exportReview(reviewId: string) {
  await ensureDatabase();
  const reviews = await listReviews();
  const review = reviews.find((item) => item.id === reviewId);
  if (!review) throw new Error('Review not found.');
  return exportReviewSnapshot(prepareReviewExport(review));
}

export async function exportReviews(reviewIds: string[]) {
  if (
    !reviewIds.length ||
    reviewIds.length > 500 ||
    new Set(reviewIds).size !== reviewIds.length
  ) {
    throw new Error('Select between 1 and 500 distinct reviews.');
  }
  const reviews = await listReviews();
  const selected = reviewIds.map((id) => {
    const review = reviews.find((item) => item.id === id);
    if (!review) throw new Error('Review not found.');
    return prepareReviewExport(review);
  });
  const bundles = selected.map((review) => {
    const exported = exportReviewSnapshot(review);
    const files =
      review.format === 'v5'
        ? JSON.parse(exported.body).files
        : { 'review.md': exported.body };
    return {
      reviewId: review.id,
      projectName: review.projectName,
      sourcePath: review.sourcePath,
      status: review.status,
      privacyStatus: review.privacyStatus,
      revisionCount: review.revisionCount,
      updatedAt: review.updatedAt,
      acceptedInsightCount: review.insights.filter(
        (item) => item.status === 'accepted',
      ).length,
      defaultAcceptedInsightCount: review.exportLabeling.pending,
      labelingComplete: review.exportLabeling.incompleteReviews === 0,
      declinedInsightCount: review.insights.filter(
        (item) => item.status === 'rejected',
      ).length,
      insightCount: review.insights.length,
      files,
    };
  });
  const exportedAt = new Date().toISOString();
  return {
    body: JSON.stringify(
      {
        format: 'oxygen-human-review-collection/v1',
        exportedAt,
        reviewCount: bundles.length,
        reviews: bundles,
      },
      null,
      2,
    ),
    contentType: 'application/json; charset=utf-8',
    filename: `oxygen-reviews-${exportedAt.replace(/[:.]/g, '-')}.json`,
  };
}

type ExportReview = Omit<Review, 'insights'> & {
  insights: Array<
    Insight & { savedStatus: Insight['status']; defaultAccepted: boolean }
  >;
  exportLabeling: ReturnType<typeof exportLabelingSummary>;
};

function prepareReviewExport(review: Review): ExportReview {
  return {
    ...review,
    exportLabeling: exportLabelingSummary([review]),
    insights: review.insights
      .filter(
        (insight) =>
          insight.status === 'accepted' ||
          insight.status === 'rejected' ||
          insight.status === 'pending',
      )
      .map((insight) => ({
        ...insight,
        savedStatus: insight.status,
        defaultAccepted: insight.status === 'pending',
        status: insight.status === 'pending' ? 'accepted' : insight.status,
      })),
  };
}

function latestContent<T extends { originalText: string }>({
  originalText: _originalText,
  ...content
}: T) {
  return content;
}

function exportReviewSnapshot(review: ExportReview) {
  const archive = {
    format: 'oxygen-review-snapshot/v1',
    reviewId: review.id,
    projectName: review.projectName,
    sourcePath: review.sourcePath,
    protocolVersion: review.protocolVersion,
    sourceStage: review.stage,
    privacyStatus: review.privacyStatus,
    status: review.status,
    revisionCount: review.revisionCount,
    reviewLevel: review.reviewLevel,
    globalSources: review.globalSources,
    exportScope: 'latest',
    exportLabeling: review.exportLabeling,
    current: {
      trajectorySummary: latestContent(review.trajectorySummary),
      summaryGroups: review.summaryGroups.map(latestContent),
      summaryLines: review.summaryLines.map(latestContent),
      insights: review.insights.map(latestContent),
    },
  };
  if (review.format === 'v5') {
    const approval = {
      format: 'oxygen-human-review/v1',
      reviewId: review.id,
      projectName: review.projectName,
      protocolVersion: review.protocolVersion,
      sourceStage: review.stage,
      privacyStatus: review.privacyStatus,
      status: review.status,
      generatedAt: review.generatedAt,
      reviewedAt: review.updatedAt,
      provenance: review.provenance,
      exportLabeling: review.exportLabeling,
      decisions: review.insights.map((insight, index, all) => ({
        sourceId:
          insight.authorship === 'reviewer'
            ? null
            : (insight.sourceId ?? insight.id),
        authorship: insight.authorship ?? 'generated',
        reviewId: insight.id,
        reviewedExportId: insight.id,
        status: insight.status,
        savedStatus: insight.savedStatus,
        defaultAccepted: insight.defaultAccepted,
        exportId:
          insight.status === 'accepted'
            ? `I${String(
                all
                  .slice(0, index + 1)
                  .filter((item) => item.status === 'accepted').length,
              ).padStart(3, '0')}`
            : null,
      })),
    };
    return {
      body: JSON.stringify(
        {
          format: 'oxygen-human-review-bundle/v1',
          reviewId: review.id,
          files: {
            'summary.md': summaryMarkdown(review.summaryLines),
            'summary_labeled.md': labeledSummaryMarkdown(review.summaryLines),
            'insight.md': serializeInsights(
              review.insights,
              review.protocolVersion,
            ),
            'insight_reviewed.md': serializeInsights(
              review.insights,
              review.protocolVersion,
              'all',
            ),
            'insight_declined.md': serializeInsights(
              review.insights.filter(
                (insight) => insight.status === 'rejected',
              ),
              review.protocolVersion,
              'all',
            ),
            'review.json': JSON.stringify(archive, null, 2) + '\n',
            'approval.json': JSON.stringify(approval, null, 2) + '\n',
          },
        },
        null,
        2,
      ),
      contentType: 'application/json; charset=utf-8',
      filename: `${review.id}-review-bundle.json`,
    };
  }

  const groups = review.summaryGroups
    .map((group) => {
      const first = group.lineIds[0];
      const last = group.lineIds[group.lineIds.length - 1];
      const references = first === last ? first : `${first}-${last}`;
      return `## ${group.id}\nLines: ${references}\n\n${group.text}`;
    })
    .join('\n\n');
  const summary = review.summaryLines
    .map((line) => `${line.id} ${line.text}`)
    .join('\n');
  const insights = review.insights
    .map((insight) =>
      insight.authorship === 'reviewer'
        ? serializeInsights(
            [{ ...insight, status: 'accepted' }],
            review.protocolVersion,
          )
            .replace(/^# I001/, `# ${insight.id}\nStatus: ${insight.status}`)
            .trimEnd()
        : [
            `# ${insight.id}`,
            `Status: ${insight.status}`,
            `Evidence: ${insight.evidence.join(', ')}`,
            '',
            insight.text,
          ].join('\n'),
    )
    .join('\n\n');
  return {
    body: `# Human-reviewed Oxygen output\n\nProject: ${review.projectName}\nStatus: ${review.status}\n\n## Trajectory summary\n\n${review.trajectorySummary.text}\n\n## Summary groups\n\n${groups}\n\n## Summary lines\n\n${summary}\n\n## Reviewed insights and decisions\n\n${insights}\n\n## Current review data\n\n\`\`\`json\n${JSON.stringify(archive, null, 2)}\n\`\`\`\n`,
    contentType: 'text/markdown; charset=utf-8',
    filename: `${review.id}-review.md`,
  };
}
