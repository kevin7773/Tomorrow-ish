PRAGMA foreign_keys = ON;

CREATE TABLE model_request_reservations (
    idempotency_key              TEXT PRIMARY KEY,
    operation                    TEXT NOT NULL CHECK (operation IN ('NORMALIZE', 'GENERATE_CANDIDATES')),
    attempt_key                  TEXT NOT NULL,
    source_intake_id             TEXT NOT NULL,
    normalized_event_version_id  TEXT,
    owner                        TEXT NOT NULL,
    status                       TEXT NOT NULL CHECK (status IN ('PENDING', 'SUCCEEDED', 'FAILED', 'AMBIGUOUS')),
    workflow_batch_id            TEXT,
    workflow_intake_id           TEXT,
    created_at                   TEXT NOT NULL,
    provider_started_at          TEXT,
    completed_at                 TEXT,
    failure_reason               TEXT,
    failure_field                TEXT,
    provider_request_id          TEXT,
    envelope_status              TEXT,
    output_characters            INTEGER CHECK (output_characters IS NULL OR output_characters >= 0),
    output_hash                  TEXT,

    FOREIGN KEY (source_intake_id) REFERENCES source_intakes(id) ON DELETE RESTRICT,
    FOREIGN KEY (normalized_event_version_id) REFERENCES normalized_event_versions(id) ON DELETE RESTRICT,
    FOREIGN KEY (workflow_batch_id, workflow_intake_id)
        REFERENCES editorial_batch_items(batch_id, source_intake_id) ON DELETE RESTRICT,
    UNIQUE (operation, attempt_key),
    CHECK ((workflow_batch_id IS NULL) = (workflow_intake_id IS NULL)),
    CHECK (
        (status = 'PENDING' AND completed_at IS NULL)
        OR (status <> 'PENDING' AND completed_at IS NOT NULL)
    )
);

CREATE INDEX idx_model_request_reservations_intake
ON model_request_reservations(source_intake_id, created_at DESC);

CREATE TRIGGER model_request_reservations_identity_immutable
BEFORE UPDATE ON model_request_reservations
WHEN NEW.idempotency_key <> OLD.idempotency_key
  OR NEW.operation <> OLD.operation
  OR NEW.attempt_key <> OLD.attempt_key
  OR NEW.source_intake_id <> OLD.source_intake_id
  OR NEW.normalized_event_version_id IS NOT OLD.normalized_event_version_id
  OR NEW.owner <> OLD.owner
  OR NEW.workflow_batch_id IS NOT OLD.workflow_batch_id
  OR NEW.workflow_intake_id IS NOT OLD.workflow_intake_id
  OR NEW.created_at <> OLD.created_at
BEGIN
    SELECT RAISE(ABORT, 'model request reservation identity is immutable');
END;

CREATE TRIGGER model_request_reservations_terminal_immutable
BEFORE UPDATE ON model_request_reservations
WHEN OLD.status <> 'PENDING'
BEGIN
    SELECT RAISE(ABORT, 'terminal model request reservations are immutable');
END;

CREATE TRIGGER model_request_reservations_no_delete
BEFORE DELETE ON model_request_reservations
BEGIN
    SELECT RAISE(ABORT, 'model request reservations cannot be deleted');
END;

PRAGMA optimize;
