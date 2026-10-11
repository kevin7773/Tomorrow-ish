PRAGMA foreign_keys = ON;

ALTER TABLE editorial_batch_items ADD COLUMN lease_owner TEXT;
ALTER TABLE editorial_batch_items ADD COLUMN lease_acquired_at TEXT;
ALTER TABLE editorial_batch_items ADD COLUMN lease_expires_at TEXT;
ALTER TABLE editorial_batch_items ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0);
ALTER TABLE editorial_batch_items ADD COLUMN retry_attempt INTEGER NOT NULL DEFAULT 0 CHECK (retry_attempt >= 0);
ALTER TABLE editorial_batch_items ADD COLUMN retry_requested_by_email TEXT;
ALTER TABLE editorial_batch_items ADD COLUMN retry_requested_at TEXT;

CREATE INDEX idx_editorial_batch_items_claim
ON editorial_batch_items(workflow_state, lease_expires_at, selected_at, ordinal);

CREATE TRIGGER editorial_batch_items_lease_consistent_insert
BEFORE INSERT ON editorial_batch_items
WHEN (NEW.lease_owner IS NULL) <> (NEW.lease_acquired_at IS NULL)
  OR (NEW.lease_owner IS NULL) <> (NEW.lease_expires_at IS NULL)
BEGIN
    SELECT RAISE(ABORT, 'workflow lease fields must be set or cleared together');
END;

CREATE TRIGGER editorial_batch_items_lease_consistent_update
BEFORE UPDATE ON editorial_batch_items
WHEN (NEW.lease_owner IS NULL) <> (NEW.lease_acquired_at IS NULL)
  OR (NEW.lease_owner IS NULL) <> (NEW.lease_expires_at IS NULL)
BEGIN
    SELECT RAISE(ABORT, 'workflow lease fields must be set or cleared together');
END;

CREATE TABLE editorial_cron_windows (
    window_key       TEXT PRIMARY KEY,
    cron             TEXT NOT NULL,
    window_started_at TEXT NOT NULL,
    owner            TEXT NOT NULL,
    claimed_at       TEXT NOT NULL,
    lease_expires_at TEXT NOT NULL,
    completed_at     TEXT,
    outcome          TEXT NOT NULL CHECK (outcome IN ('RUNNING', 'SUCCEEDED', 'FAILED')),
    attempt_count    INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count > 0),
    last_error       TEXT
);

CREATE INDEX idx_editorial_cron_windows_recovery
ON editorial_cron_windows(outcome, lease_expires_at);

PRAGMA optimize;
