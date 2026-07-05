-- The scheduler reclaims expired-but-unreleased reservations on every reserve()
-- with: SELECT ... FROM reservations WHERE released_at IS NULL AND expires_at <= ?
-- The existing idx_reservations_node_released (node_id, released_at) leads on
-- node_id and cannot serve this predicate, so the query would full-scan a table
-- that only ever grows (reservations are marked released, never deleted). This
-- partial index stays small (open reservations only) and serves the hot path.
CREATE INDEX IF NOT EXISTS idx_reservations_open_expiry ON reservations(expires_at) WHERE released_at IS NULL;
