CREATE TABLE IF NOT EXISTS slack_read_cursors (
  channel_id TEXT PRIMARY KEY,
  cursor_ts TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
