CREATE TABLE IF NOT EXISTS router_config (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tokens (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  verifier TEXT NOT NULL,
  active INTEGER NOT NULL,
  node_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  PRIMARY KEY (kind, id)
);

CREATE TABLE IF NOT EXISTS model_profiles (
  id TEXT PRIMARY KEY,
  profile_json TEXT NOT NULL,
  active INTEGER NOT NULL,
  rollout_percent INTEGER NOT NULL,
  version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  node_json TEXT NOT NULL,
  status TEXT NOT NULL,
  mesh_ip TEXT NOT NULL,
  inference_port INTEGER NOT NULL,
  in_flight INTEGER NOT NULL,
  capacity INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  public_model TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  upstream_model TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reservations (
  reservation_id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  public_model TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  upstream_model TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  released_at INTEGER
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  event_json TEXT NOT NULL,
  type TEXT NOT NULL,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  target TEXT
);

CREATE INDEX IF NOT EXISTS idx_tokens_kind_active ON tokens(kind, active);
CREATE INDEX IF NOT EXISTS idx_nodes_status_seen ON nodes(status, last_seen_at);
CREATE INDEX IF NOT EXISTS idx_reservations_node_released ON reservations(node_id, released_at);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_events(at);
