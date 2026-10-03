CREATE TABLE `review_revisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`review_id` text NOT NULL,
	`revision_number` integer NOT NULL,
	`summary_json` text NOT NULL,
	`insights_json` text NOT NULL,
	`note` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_review_revisions_review_number` ON `review_revisions` (`review_id`,`revision_number`);--> statement-breakpoint
CREATE TABLE `reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`project_name` text NOT NULL,
	`source_path` text NOT NULL,
	`status` text NOT NULL,
	`generated_at` text NOT NULL,
	`original_summary_json` text NOT NULL,
	`original_insights_json` text NOT NULL,
	`current_summary_json` text NOT NULL,
	`current_insights_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
