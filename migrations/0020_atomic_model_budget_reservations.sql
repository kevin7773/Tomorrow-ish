PRAGMA foreign_keys = ON;

CREATE TABLE model_budget_reservations (
    attempt_key                       TEXT PRIMARY KEY,
    operation                         TEXT NOT NULL CHECK (operation IN (
        'NORMALIZE', 'GENERATE_CANDIDATES', 'GENERATE_ARTICLE_BODY'
    )),
    source_intake_id                  TEXT NOT NULL,
    normalized_event_version_id       TEXT,
    candidate_id                      TEXT,
    owner                             TEXT NOT NULL,
    budget_day                        TEXT NOT NULL CHECK (
        length(budget_day) = 10 AND substr(budget_day, 5, 1) = '-' AND substr(budget_day, 8, 1) = '-'
    ),
    status                            TEXT NOT NULL CHECK (status IN (
        'RESERVED', 'FINALIZED', 'RELEASED', 'AMBIGUOUS'
    )),
    estimated_cost_microusd           INTEGER NOT NULL CHECK (estimated_cost_microusd > 0),
    usage_recorded_cost_microusd      INTEGER CHECK (
        usage_recorded_cost_microusd IS NULL OR usage_recorded_cost_microusd >= 0
    ),
    verified_billed_cost_microusd     INTEGER CHECK (
        verified_billed_cost_microusd IS NULL OR verified_billed_cost_microusd >= 0
    ),
    workflow_batch_id                 TEXT,
    workflow_intake_id                TEXT,
    created_at                        TEXT NOT NULL,
    provider_started_at               TEXT,
    resolved_at                       TEXT,
    provider_request_id               TEXT,
    resolution_reason                 TEXT,

    FOREIGN KEY (source_intake_id) REFERENCES source_intakes(id) ON DELETE RESTRICT,
    FOREIGN KEY (normalized_event_version_id) REFERENCES normalized_event_versions(id) ON DELETE RESTRICT,
    FOREIGN KEY (candidate_id) REFERENCES satire_candidates(id) ON DELETE RESTRICT,
    FOREIGN KEY (workflow_batch_id, workflow_intake_id)
        REFERENCES editorial_batch_items(batch_id, source_intake_id) ON DELETE RESTRICT,
    CHECK ((workflow_batch_id IS NULL) = (workflow_intake_id IS NULL)),
    CHECK (
        (operation = 'NORMALIZE' AND normalized_event_version_id IS NULL AND candidate_id IS NULL)
        OR (operation = 'GENERATE_CANDIDATES' AND normalized_event_version_id IS NOT NULL AND candidate_id IS NULL)
        OR (operation = 'GENERATE_ARTICLE_BODY' AND normalized_event_version_id IS NOT NULL AND candidate_id IS NOT NULL)
    ),
    CHECK (
        (status = 'RESERVED' AND resolved_at IS NULL)
        OR (status <> 'RESERVED' AND resolved_at IS NOT NULL)
    ),
    CHECK (
        status <> 'RELEASED'
        OR (usage_recorded_cost_microusd IS NULL AND verified_billed_cost_microusd IS NULL)
    )
);

CREATE INDEX idx_model_budget_reservations_day
ON model_budget_reservations(budget_day, status);

CREATE INDEX idx_model_budget_reservations_item
ON model_budget_reservations(source_intake_id, status, created_at);

CREATE TRIGGER model_budget_reservations_identity_immutable
BEFORE UPDATE ON model_budget_reservations
WHEN NEW.attempt_key <> OLD.attempt_key
  OR NEW.operation <> OLD.operation
  OR NEW.source_intake_id <> OLD.source_intake_id
  OR NEW.normalized_event_version_id IS NOT OLD.normalized_event_version_id
  OR NEW.candidate_id IS NOT OLD.candidate_id
  OR NEW.owner <> OLD.owner
  OR NEW.budget_day <> OLD.budget_day
  OR NEW.estimated_cost_microusd <> OLD.estimated_cost_microusd
  OR NEW.workflow_batch_id IS NOT OLD.workflow_batch_id
  OR NEW.workflow_intake_id IS NOT OLD.workflow_intake_id
  OR NEW.created_at <> OLD.created_at
BEGIN
    SELECT RAISE(ABORT, 'model budget reservation identity is immutable');
END;

CREATE TRIGGER model_budget_reservations_terminal_immutable
BEFORE UPDATE ON model_budget_reservations
WHEN OLD.status IN ('FINALIZED', 'RELEASED')
BEGIN
    SELECT RAISE(ABORT, 'terminal model budget reservations are immutable');
END;

CREATE TRIGGER model_budget_reservations_ambiguous_resolution_only
BEFORE UPDATE ON model_budget_reservations
WHEN OLD.status = 'AMBIGUOUS' AND NEW.status NOT IN ('AMBIGUOUS', 'FINALIZED', 'RELEASED')
BEGIN
    SELECT RAISE(ABORT, 'ambiguous model budget reservation requires definitive resolution');
END;

CREATE TRIGGER model_budget_reservations_no_delete
BEFORE DELETE ON model_budget_reservations
BEGIN
    SELECT RAISE(ABORT, 'model budget reservations cannot be deleted');
END;

PRAGMA optimize;
