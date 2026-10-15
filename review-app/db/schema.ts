import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

const emptyHierarchyJson =
  '{"trajectorySummary":{"originalText":"","text":""},"summaryGroups":[]}';

export const reviews = sqliteTable(
  'reviews',
  {
    id: text('id').primaryKey(),
    projectName: text('project_name').notNull(),
    sourcePath: text('source_path').notNull(),
    status: text('status').notNull(),
    generatedAt: text('generated_at').notNull(),
    version: integer('version').notNull().default(0),
    privacyEpoch: integer('privacy_epoch').notNull().default(0),
    initialStatus: text('initial_status').notNull().default('ready'),
    originalSummaryJson: text('original_summary_json').notNull(),
    originalInsightsJson: text('original_insights_json').notNull(),
    originalHierarchyJson: text('original_hierarchy_json')
      .notNull()
      .default(emptyHierarchyJson),
    currentSummaryJson: text('current_summary_json').notNull(),
    currentInsightsJson: text('current_insights_json').notNull(),
    currentHierarchyJson: text('current_hierarchy_json')
      .notNull()
      .default(emptyHierarchyJson),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('idx_reviews_status_updated').on(table.status, table.updatedAt),
  ],
);

export const reviewRevisions = sqliteTable(
  'review_revisions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    reviewId: text('review_id').notNull(),
    revisionNumber: integer('revision_number').notNull(),
    requestId: text('request_id'),
    requestHash: text('request_hash'),
    kind: text('kind').notNull().default('edit'),
    summaryJson: text('summary_json').notNull(),
    insightsJson: text('insights_json').notNull(),
    hierarchyJson: text('hierarchy_json').notNull().default(emptyHierarchyJson),
    note: text('note').notNull(),
    status: text('status').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_review_revisions_request').on(
      table.reviewId,
      table.requestId,
    ),
    uniqueIndex('idx_review_revisions_review_number').on(
      table.reviewId,
      table.revisionNumber,
    ),
  ],
);

// Retry recovery records identify only the surviving baseline, never its source.
export const reviewPrivacyOperations = sqliteTable(
  'review_privacy_operations',
  {
    operationId: text('operation_id').primaryKey(),
    reviewId: text('review_id').notNull(),
    requestHash: text('request_hash').notNull(),
  },
  (table) => [
    uniqueIndex('idx_review_privacy_operations_review').on(table.reviewId),
  ],
);
