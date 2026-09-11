-- Record effort observed at outbound provider-request capture, independently
-- of detailed payload logging. Retries replace the previous observation;
-- no capture, no effort carrier, and semantic-cache responses store NULL.
-- Explicit thinking-off stores 'none'; budget-only requests do not infer a tier.
-- This request setting is distinct from response reasoning-token accounting.
ALTER TABLE call_logs ADD COLUMN reasoning_effort TEXT DEFAULT NULL;
