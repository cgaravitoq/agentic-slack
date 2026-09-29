CREATE TABLE IF NOT EXISTS approval_requests (
  request_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  surface TEXT NOT NULL,
  requester_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  args TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  decided_at INTEGER,
  decided_by TEXT,
  message_ts TEXT
);

CREATE INDEX IF NOT EXISTS idx_approval_requests_lookup
  ON approval_requests (conversation_id, tool);
