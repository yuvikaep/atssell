-- Rate-limit counters shared by every API instance. In-memory counters reset per serverless instance,
-- so a limit of 10 logins a minute would really be 10 per instance. Not tenant data: keys are
-- route + hashed client IP (or user id), so there is no tenant_id and no row-level security.
CREATE TABLE rate_limit_counters (
    key TEXT PRIMARY KEY,
    hits INTEGER NOT NULL,
    window_ends_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX rate_limit_counters_window_ends_at_idx ON rate_limit_counters (window_ends_at);

-- Set when an admin chose the person's first password (create-login while email is off). Until they
-- pick their own, the API only lets them read /me, change their password and sign out.
ALTER TABLE users ADD COLUMN must_change_password BOOLEAN NOT NULL DEFAULT false;
