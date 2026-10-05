CREATE TABLE IF NOT EXISTS slack_progress_roots (
  channel_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  root_ts TEXT NOT NULL,
  root_text TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (channel_id, task_id)
);
