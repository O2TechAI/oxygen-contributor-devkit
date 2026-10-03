import { env } from 'cloudflare:workers';

import { sampleReviews } from '@/lib/sample-data';
import type {
  Insight,
  Review,
  ReviewCreatePayload,
  ReviewHierarchy,
  ReviewSavePayload,
  SummaryLine,
} from '@/lib/review-types';
import { insightKeys, normalizeInsightType } from '@/lib/review-types';
import { parseSummary, validateSummaryGroups } from '@/lib/summary-format';
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
    originalInsights.map((insight) => [insight.id, insight.originalText]),
  );

  return {
    id: row.id,
    projectName: row.project_name,
    sourcePath: row.source_path,
    status: row.status,
    generatedAt: row.generated_at,
    updatedAt: row.updated_at,
    revisionCount: Number(row.revision_count || 0),
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
        currentHierarchy.trajectorySummary.originalText,
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
  if (payload.format === 'v5') {
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

export async function saveRevision(
  reviewId: string,
  payload: ReviewSavePayload,
): Promise<Review> {
  await ensureDatabase();
  const db = database();
  const current = await db
    .prepare('SELECT current_hierarchy_json FROM reviews WHERE id = ?')
    .bind(reviewId)
    .first<{ current_hierarchy_json: string }>();
  if (!current) throw new Error('Review not found.');

  const last = await db
    .prepare(`SELECT COALESCE(MAX(revision_number), 0) AS revision
    FROM review_revisions WHERE review_id = ?`)
    .bind(reviewId)
    .first<{ revision: number }>();
  const revision = Number(last?.revision || 0) + 1;
  const createdAt = new Date().toISOString();
  const summaryJson = JSON.stringify(payload.summaryLines);
  const insightsJson = JSON.stringify(payload.insights);
  const existingHierarchy = normalizeHierarchy(current.current_hierarchy_json);
  const hierarchyJson = JSON.stringify({
    ...existingHierarchy,
    trajectorySummary: payload.trajectorySummary,
    summaryGroups: payload.summaryGroups,
  });

  await db.batch([
    db
      .prepare(`INSERT INTO review_revisions (
      review_id, revision_number, summary_json, insights_json, hierarchy_json,
      note, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        reviewId,
        revision,
        summaryJson,
        insightsJson,
        hierarchyJson,
        payload.note.trim(),
        payload.status,
        createdAt,
      ),
    db
      .prepare(`UPDATE reviews SET
      current_summary_json = ?, current_insights_json = ?,
      current_hierarchy_json = ?, status = ?, updated_at = ?
      WHERE id = ?`)
      .bind(
        summaryJson,
        insightsJson,
        hierarchyJson,
        payload.status,
        createdAt,
        reviewId,
      ),
  ]);

  const reviews = await listReviews();
  return reviews.find((review) => review.id === reviewId)!;
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
