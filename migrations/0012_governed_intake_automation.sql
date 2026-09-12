PRAGMA foreign_keys = ON;

CREATE TABLE automation_sources (
    item_identity       TEXT PRIMARY KEY,
    source_url          TEXT NOT NULL UNIQUE,
    source_intake_id    TEXT NOT NULL UNIQUE,
    category_id         TEXT NOT NULL,
    first_seen_at       TEXT NOT NULL,
    last_seen_at        TEXT NOT NULL,

    FOREIGN KEY (source_intake_id) REFERENCES source_intakes(id) ON DELETE RESTRICT,
    FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE RESTRICT
);

CREATE TABLE automation_runs (
    id                  TEXT PRIMARY KEY,
    trigger_kind        TEXT NOT NULL CHECK (trigger_kind IN ('MANUAL', 'SCHEDULED')),
    status              TEXT NOT NULL CHECK (status IN ('RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED')),
    discovered_count    INTEGER NOT NULL DEFAULT 0 CHECK (discovered_count >= 0),
    processed_count     INTEGER NOT NULL DEFAULT 0 CHECK (processed_count >= 0),
    intake_count        INTEGER NOT NULL DEFAULT 0 CHECK (intake_count >= 0),
    generated_count     INTEGER NOT NULL DEFAULT 0 CHECK (generated_count >= 0),
    skipped_count       INTEGER NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
    failed_count        INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
    failure_reason      TEXT,
    started_at          TEXT NOT NULL,
    completed_at        TEXT,

    CHECK (
        (status = 'RUNNING' AND completed_at IS NULL)
        OR (status <> 'RUNNING' AND completed_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX idx_automation_single_running
ON automation_runs(status)
WHERE status = 'RUNNING';

CREATE INDEX idx_automation_runs_started
ON automation_runs(started_at DESC);

CREATE TABLE automation_run_items (
    run_id                       TEXT NOT NULL,
    item_number                  INTEGER NOT NULL CHECK (item_number > 0),
    item_identity                TEXT NOT NULL,
    source_url                   TEXT,
    outcome                      TEXT NOT NULL CHECK (
                                    outcome IN (
                                        'INTAKE_CREATED',
                                        'GENERATED',
                                        'DUPLICATE',
                                        'INELIGIBLE',
                                        'ALREADY_GENERATED',
                                        'MALFORMED',
                                        'FAILED'
                                    )
                                ),
    reason                       TEXT NOT NULL,
    source_intake_id             TEXT,
    normalized_event_version_id  TEXT,
    model_run_id                 TEXT,
    created_at                   TEXT NOT NULL,

    PRIMARY KEY (run_id, item_number),
    FOREIGN KEY (run_id) REFERENCES automation_runs(id) ON DELETE RESTRICT,
    FOREIGN KEY (source_intake_id) REFERENCES source_intakes(id) ON DELETE RESTRICT,
    FOREIGN KEY (normalized_event_version_id) REFERENCES normalized_event_versions(id) ON DELETE RESTRICT,
    FOREIGN KEY (model_run_id) REFERENCES model_runs(id) ON DELETE RESTRICT
);

CREATE INDEX idx_automation_run_items_identity
ON automation_run_items(run_id, item_identity);

CREATE TRIGGER automation_run_items_no_update
BEFORE UPDATE ON automation_run_items
BEGIN
    SELECT RAISE(ABORT, 'automation run items are immutable');
END;

CREATE TRIGGER automation_run_items_no_delete
BEFORE DELETE ON automation_run_items
BEGIN
    SELECT RAISE(ABORT, 'automation run items cannot be deleted');
END;

CREATE TRIGGER automation_runs_transition_guard
BEFORE UPDATE ON automation_runs
WHEN OLD.status <> 'RUNNING' OR NEW.status NOT IN ('SUCCEEDED', 'PARTIAL', 'FAILED')
BEGIN
    SELECT RAISE(ABORT, 'invalid automation run transition');
END;

PRAGMA optimize;
