PRAGMA foreign_keys = ON;

ALTER TABLE satire_candidates
ADD COLUMN body_generation_state TEXT NOT NULL DEFAULT 'NOT_REQUESTED'
CHECK (body_generation_state IN ('NOT_REQUESTED', 'PENDING', 'SUCCEEDED', 'FAILED'));

ALTER TABLE satire_candidates
ADD COLUMN body_generation_run_id TEXT;

CREATE TABLE candidate_body_generation_runs (
    id                           TEXT PRIMARY KEY,
    operation                    TEXT NOT NULL DEFAULT 'GENERATE_ARTICLE_BODY'
                                 CHECK (operation = 'GENERATE_ARTICLE_BODY'),
    status                       TEXT NOT NULL CHECK (status IN ('PENDING', 'SUCCEEDED', 'FAILED')),
    candidate_id                 TEXT NOT NULL,
    source_intake_id             TEXT NOT NULL,
    normalized_event_version_id  TEXT NOT NULL,
    provider                     TEXT NOT NULL,
    model                        TEXT NOT NULL,
    provider_revision            TEXT,
    prompt_version               TEXT NOT NULL,
    input_hash                   TEXT NOT NULL,
    output_hash                  TEXT,
    input_tokens                 INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
    output_tokens                INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
    input_characters             INTEGER NOT NULL CHECK (input_characters >= 0),
    output_characters            INTEGER NOT NULL DEFAULT 0 CHECK (output_characters >= 0),
    latency_ms                   INTEGER NOT NULL DEFAULT 0 CHECK (latency_ms >= 0),
    retry_count                  INTEGER NOT NULL DEFAULT 0 CHECK (retry_count = 0),
    estimated_cost_microusd      INTEGER NOT NULL CHECK (estimated_cost_microusd >= 0),
    idempotency_key              TEXT NOT NULL UNIQUE,
    requested_by_email           TEXT NOT NULL,
    source_was_sensitive         INTEGER NOT NULL CHECK (source_was_sensitive IN (0, 1)),
    caution_reason               TEXT,
    failure_classification       TEXT,
    provider_http_status         INTEGER,
    provider_error_type          TEXT,
    provider_error_code          TEXT,
    provider_error_message       TEXT,
    provider_request_id          TEXT,
    provider_retry_after         TEXT,
    created_at                   TEXT NOT NULL,
    completed_at                 TEXT,

    FOREIGN KEY (candidate_id) REFERENCES satire_candidates(id) ON DELETE RESTRICT,
    FOREIGN KEY (source_intake_id) REFERENCES source_intakes(id) ON DELETE RESTRICT,
    FOREIGN KEY (normalized_event_version_id) REFERENCES normalized_event_versions(id) ON DELETE RESTRICT,
    CHECK (
        (status = 'PENDING' AND completed_at IS NULL AND output_hash IS NULL AND failure_classification IS NULL)
        OR (status = 'SUCCEEDED' AND completed_at IS NOT NULL AND output_hash IS NOT NULL AND failure_classification IS NULL)
        OR (status = 'FAILED' AND completed_at IS NOT NULL AND output_hash IS NULL AND failure_classification IS NOT NULL)
    )
);

CREATE UNIQUE INDEX idx_candidate_body_generation_pending
ON candidate_body_generation_runs(candidate_id)
WHERE status = 'PENDING';

CREATE INDEX idx_candidate_body_generation_history
ON candidate_body_generation_runs(candidate_id, created_at DESC);

CREATE TRIGGER candidate_body_generation_runs_no_delete
BEFORE DELETE ON candidate_body_generation_runs
BEGIN
    SELECT RAISE(ABORT, 'article body generation history cannot be deleted');
END;

CREATE TRIGGER candidate_body_generation_runs_provenance_immutable
BEFORE UPDATE ON candidate_body_generation_runs
WHEN NEW.id <> OLD.id
  OR NEW.operation <> OLD.operation
  OR NEW.candidate_id <> OLD.candidate_id
  OR NEW.source_intake_id <> OLD.source_intake_id
  OR NEW.normalized_event_version_id <> OLD.normalized_event_version_id
  OR NEW.provider <> OLD.provider
  OR NEW.model <> OLD.model
  OR NEW.prompt_version <> OLD.prompt_version
  OR NEW.input_hash <> OLD.input_hash
  OR NEW.input_characters <> OLD.input_characters
  OR NEW.idempotency_key <> OLD.idempotency_key
  OR NEW.requested_by_email <> OLD.requested_by_email
  OR NEW.source_was_sensitive <> OLD.source_was_sensitive
  OR NEW.caution_reason IS NOT OLD.caution_reason
  OR NEW.created_at <> OLD.created_at
BEGIN
    SELECT RAISE(ABORT, 'article body generation provenance is immutable');
END;

CREATE TRIGGER candidate_body_generation_runs_terminal_guard
BEFORE UPDATE ON candidate_body_generation_runs
WHEN OLD.status <> 'PENDING' OR NEW.status NOT IN ('SUCCEEDED', 'FAILED')
BEGIN
    SELECT RAISE(ABORT, 'invalid article body generation transition');
END;

CREATE TRIGGER candidate_body_generation_state_guard
BEFORE UPDATE OF body_generation_state ON satire_candidates
WHEN NEW.body_generation_state <> OLD.body_generation_state
 AND NOT (
    (OLD.body_generation_state IN ('NOT_REQUESTED', 'FAILED') AND NEW.body_generation_state = 'PENDING')
    OR (OLD.body_generation_state = 'PENDING' AND NEW.body_generation_state IN ('SUCCEEDED', 'FAILED'))
 )
BEGIN
    SELECT RAISE(ABORT, 'invalid candidate body generation transition');
END;

CREATE TRIGGER candidate_body_generation_reference_guard
BEFORE UPDATE OF body_generation_run_id ON satire_candidates
WHEN NEW.body_generation_run_id IS NOT NULL
 AND NOT EXISTS (
    SELECT 1 FROM candidate_body_generation_runs AS run
    WHERE run.id = NEW.body_generation_run_id AND run.candidate_id = NEW.id
 )
BEGIN
    SELECT RAISE(ABORT, 'invalid candidate body generation reference');
END;

PRAGMA optimize;
