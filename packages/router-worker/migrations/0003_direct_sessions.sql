CREATE TABLE IF NOT EXISTS direct_sessions (
  affinity_key TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  public_model TEXT NOT NULL,
  node_id TEXT NOT NULL,
  user_hash TEXT NOT NULL,
  session_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  failover_count INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_direct_sessions_expires ON direct_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_direct_sessions_node ON direct_sessions(node_id);
