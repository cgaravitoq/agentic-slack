ALTER TABLE slack_progress_roots ADD COLUMN owned INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS progress_receipts (
  milestone_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  ts TEXT,
  claimed_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_progress_receipts_updated_at
  ON progress_receipts (updated_at);
