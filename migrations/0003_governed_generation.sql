PRAGMA foreign_keys = ON;

CREATE TABLE model_runs (
    id                           TEXT PRIMARY KEY,
    operation                    TEXT NOT NULL CHECK (operation IN ('NORMALIZE', 'GENERATE_CANDIDATES')),
    status                       TEXT NOT NULL CHECK (status IN ('SUCCEEDED', 'FAILED')),
    source_intake_id             TEXT NOT NULL,
    normalized_event_version_id  TEXT,
    provider                     TEXT NOT NULL,
    model                        TEXT NOT NULL,
    provider_revision            TEXT,
    prompt_version               TEXT NOT NULL,
    input_hash                   TEXT NOT NULL,
    output_hash                  TEXT,
    input_tokens                 INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
    output_tokens                INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
    input_characters             INTEGER NOT NULL CHECK (input_characters >= 0),
    output_characters            INTEGER NOT NULL CHECK (output_characters >= 0),
    latency_ms                   INTEGER NOT NULL CHECK (latency_ms >= 0),
    retry_count                  INTEGER NOT NULL CHECK (retry_count >= 0),
    estimated_cost_microusd      INTEGER NOT NULL CHECK (estimated_cost_microusd >= 0),
    candidate_count              INTEGER NOT NULL DEFAULT 0 CHECK (candidate_count BETWEEN 0 AND 20),
    idempotency_key              TEXT NOT NULL UNIQUE,
    requested_by_email           TEXT NOT NULL,
    failure_classification       TEXT,
    created_at                   TEXT NOT NULL,
    completed_at                 TEXT NOT NULL,

    FOREIGN KEY (source_intake_id) REFERENCES source_intakes(id) ON DELETE RESTRICT,
    FOREIGN KEY (normalized_event_version_id) REFERENCES normalized_event_versions(id) ON DELETE RESTRICT
);

CREATE TABLE normalized_event_versions (
    id                              TEXT PRIMARY KEY,
    source_intake_id                TEXT NOT NULL,
    parent_version_id               TEXT,
    version_number                  INTEGER NOT NULL CHECK (version_number > 0),
    review_state                    TEXT NOT NULL CHECK (
                                        review_state IN ('PROPOSED', 'ACCEPTED', 'REJECTED', 'SUPERSEDED')
                                    ),
    origin                          TEXT NOT NULL CHECK (origin IN ('EDITOR', 'MODEL')),
    event_statement                 TEXT NOT NULL,
    proposed_significance_score     INTEGER NOT NULL CHECK (proposed_significance_score BETWEEN 1 AND 5),
    proposed_satire_potential_score INTEGER NOT NULL CHECK (proposed_satire_potential_score BETWEEN 1 AND 5),
    proposed_suitability            TEXT NOT NULL CHECK (
                                        proposed_suitability IN ('UNREVIEWED', 'SUITABLE', 'SENSITIVE', 'UNSUITABLE')
                                    ),
    suitability_reason              TEXT NOT NULL,
    guardrail_flags_json            TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(guardrail_flags_json)),
    model_run_id                    TEXT,
    created_by_email                TEXT NOT NULL,
    reviewed_by_email               TEXT,
    review_reason                   TEXT,
    created_at                      TEXT NOT NULL,
    reviewed_at                     TEXT,

    FOREIGN KEY (source_intake_id) REFERENCES source_intakes(id) ON DELETE RESTRICT,
    FOREIGN KEY (parent_version_id) REFERENCES normalized_event_versions(id) ON DELETE RESTRICT,
    FOREIGN KEY (model_run_id) REFERENCES model_runs(id) ON DELETE RESTRICT,
    UNIQUE (source_intake_id, version_number)
);

CREATE TABLE normalized_event_assertions (
    id                           TEXT PRIMARY KEY,
    normalized_event_version_id  TEXT NOT NULL,
    ordinal                      INTEGER NOT NULL CHECK (ordinal >= 0),
    assertion_kind               TEXT NOT NULL CHECK (assertion_kind IN ('FACT', 'UNCERTAINTY', 'CONTEXT')),
    statement                    TEXT NOT NULL,

    FOREIGN KEY (normalized_event_version_id) REFERENCES normalized_event_versions(id) ON DELETE RESTRICT,
    UNIQUE (normalized_event_version_id, ordinal)
);

CREATE TABLE normalized_assertion_sources (
    assertion_id        TEXT NOT NULL,
    source_reference_id TEXT NOT NULL,
    relationship        TEXT NOT NULL CHECK (relationship IN ('SUPPORTS', 'CONTRADICTS', 'CONTEXT')),

    FOREIGN KEY (assertion_id) REFERENCES normalized_event_assertions(id) ON DELETE RESTRICT,
    FOREIGN KEY (source_reference_id) REFERENCES source_references(id) ON DELETE RESTRICT,
    PRIMARY KEY (assertion_id, source_reference_id, relationship)
);

ALTER TABLE source_intakes ADD COLUMN suitability_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE source_intakes
ADD COLUMN guardrail_flags_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(guardrail_flags_json));
ALTER TABLE source_intakes ADD COLUMN assessment_reviewed_by_email TEXT;
ALTER TABLE source_intakes ADD COLUMN assessment_reviewed_at TEXT;
ALTER TABLE source_intakes
ADD COLUMN accepted_model_run_id TEXT REFERENCES model_runs(id) DEFAULT NULL;

ALTER TABLE editorial_audit_log ADD COLUMN reason TEXT;

ALTER TABLE satire_candidates
ADD COLUMN origin_model_run_id TEXT REFERENCES model_runs(id) DEFAULT NULL;
ALTER TABLE satire_candidates
ADD COLUMN normalized_event_version_id TEXT REFERENCES normalized_event_versions(id) DEFAULT NULL;
ALTER TABLE satire_candidates ADD COLUMN generation_ordinal INTEGER;
ALTER TABLE satire_candidates ADD COLUMN rationale TEXT NOT NULL DEFAULT '';
ALTER TABLE satire_candidates ADD COLUMN satirical_mechanism TEXT NOT NULL DEFAULT '';
ALTER TABLE satire_candidates
ADD COLUMN origin_kind TEXT NOT NULL DEFAULT 'MANUAL' CHECK (origin_kind IN ('MANUAL', 'MODEL'));

CREATE UNIQUE INDEX idx_normalized_event_accepted
ON normalized_event_versions(source_intake_id)
WHERE review_state = 'ACCEPTED';

CREATE INDEX idx_normalized_event_history
ON normalized_event_versions(source_intake_id, version_number DESC);

CREATE INDEX idx_normalized_assertions_version
ON normalized_event_assertions(normalized_event_version_id, ordinal);

CREATE INDEX idx_model_runs_intake
ON model_runs(source_intake_id, created_at DESC);

CREATE UNIQUE INDEX idx_generated_candidate_ordinal
ON satire_candidates(origin_model_run_id, generation_ordinal)
WHERE origin_model_run_id IS NOT NULL;

CREATE TRIGGER normalized_event_versions_no_delete
BEFORE DELETE ON normalized_event_versions
BEGIN
    SELECT RAISE(ABORT, 'normalized event versions cannot be deleted');
END;

CREATE TRIGGER normalized_event_versions_content_immutable
BEFORE UPDATE ON normalized_event_versions
WHEN NEW.source_intake_id <> OLD.source_intake_id
  OR NEW.parent_version_id IS NOT OLD.parent_version_id
  OR NEW.version_number <> OLD.version_number
  OR NEW.origin <> OLD.origin
  OR NEW.event_statement <> OLD.event_statement
  OR NEW.proposed_significance_score <> OLD.proposed_significance_score
  OR NEW.proposed_satire_potential_score <> OLD.proposed_satire_potential_score
  OR NEW.proposed_suitability <> OLD.proposed_suitability
  OR NEW.suitability_reason <> OLD.suitability_reason
  OR NEW.guardrail_flags_json <> OLD.guardrail_flags_json
  OR NEW.model_run_id IS NOT OLD.model_run_id
  OR NEW.created_by_email <> OLD.created_by_email
  OR NEW.created_at <> OLD.created_at
BEGIN
    SELECT RAISE(ABORT, 'normalized event version content is immutable');
END;

CREATE TRIGGER normalized_event_assertions_no_update
BEFORE UPDATE ON normalized_event_assertions
BEGIN
    SELECT RAISE(ABORT, 'normalized event assertions are immutable');
END;

CREATE TRIGGER normalized_event_assertions_no_delete
BEFORE DELETE ON normalized_event_assertions
BEGIN
    SELECT RAISE(ABORT, 'normalized event assertions cannot be deleted');
END;

CREATE TRIGGER normalized_assertion_sources_no_update
BEFORE UPDATE ON normalized_assertion_sources
BEGIN
    SELECT RAISE(ABORT, 'normalized assertion provenance is immutable');
END;

CREATE TRIGGER normalized_assertion_sources_no_delete
BEFORE DELETE ON normalized_assertion_sources
BEGIN
    SELECT RAISE(ABORT, 'normalized assertion provenance cannot be deleted');
END;

PRAGMA optimize;
