CREATE TABLE IF NOT EXISTS slack_channel_admissions (
  channel_id TEXT PRIMARY KEY,
  admitted_by TEXT NOT NULL,
  admitted_at INTEGER NOT NULL
);
