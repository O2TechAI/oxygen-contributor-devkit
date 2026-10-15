ALTER TABLE reviews ADD version integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE reviews ADD privacy_epoch integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE reviews ADD initial_status text NOT NULL DEFAULT 'ready';
--> statement-breakpoint
ALTER TABLE review_revisions ADD request_id text;
--> statement-breakpoint
ALTER TABLE review_revisions ADD request_hash text;
--> statement-breakpoint
ALTER TABLE review_revisions ADD kind text NOT NULL DEFAULT 'edit';
--> statement-breakpoint
CREATE UNIQUE INDEX idx_review_revisions_request ON review_revisions(review_id, request_id);
--> statement-breakpoint
UPDATE reviews SET version = COALESCE((SELECT MAX(revision_number) FROM review_revisions WHERE review_id = reviews.id), 0);
