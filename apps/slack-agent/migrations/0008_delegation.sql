CREATE TABLE delegation_runners (
  name TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  repos TEXT NOT NULL,
  capacity INTEGER NOT NULL CHECK (capacity > 0)
);
CREATE TABLE delegation_tasks (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  channel TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  requester TEXT NOT NULL,
  reporters TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  raw_thread TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('proposed', 'approved', 'claimed', 'running', 'done', 'failed', 'unknown', 'expired', 'cancelled')),
  expires_at INTEGER NOT NULL,
  runner TEXT,
  token_hash TEXT,
  instance_id TEXT NOT NULL
);
CREATE INDEX idx_delegation_tasks_runner ON delegation_tasks (runner, state, expires_at);
CREATE UNIQUE INDEX idx_delegation_tasks_token ON delegation_tasks (token_hash);
