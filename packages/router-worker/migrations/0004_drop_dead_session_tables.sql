-- SCH001DeadSessionSchemaDrop
-- The move to stateless forwarding left `sessions` and `reservations` without a
-- single reader or writer: the request path selects an eligible node straight
-- from `nodes` and forwards, holding no lease and no capacity gate. Cache-warm
-- affinity for direct llama.cpp profiles lives in `direct_sessions` (0003), which
-- is unrelated to these two. Dropping a table drops its indexes with it, so this
-- also retires idx_reservations_node_released (0001) and the partial
-- idx_reservations_open_expiry (0002), whose only purpose was the reclaim scan.
DROP TABLE IF EXISTS reservations;
DROP TABLE IF EXISTS sessions;
