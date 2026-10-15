CREATE TABLE review_privacy_operations (
  operation_id text PRIMARY KEY NOT NULL,
  review_id text NOT NULL,
  request_hash text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX idx_review_privacy_operations_review ON review_privacy_operations(review_id);
