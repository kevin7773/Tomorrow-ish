PRAGMA foreign_keys = ON;

CREATE TABLE editorial_batches (
    id                        TEXT PRIMARY KEY,
    item_count                INTEGER NOT NULL DEFAULT 0 CHECK (item_count >= 0),
    created_at                TEXT NOT NULL,
    triage_completed_at       TEXT,
    final_review_completed_at TEXT,
    FOREIGN KEY (id) REFERENCES automation_runs(id) ON DELETE RESTRICT
);

CREATE TABLE editorial_batch_items (
    batch_id                TEXT NOT NULL,
    source_intake_id        TEXT NOT NULL UNIQUE,
    ordinal                 INTEGER NOT NULL CHECK (ordinal > 0),
    category_id             TEXT NOT NULL,
    workflow_state          TEXT NOT NULL CHECK (workflow_state IN (
                                'INGESTED', 'SELECTED', 'GENERATING',
                                'READY_FOR_REVIEW', 'PUBLISHED', 'REJECTED', 'FAILED'
                            )),
    selected_by_email       TEXT,
    selected_at             TEXT,
    rejected_by_email       TEXT,
    rejected_at             TEXT,
    candidate_id            TEXT,
    story_id                TEXT UNIQUE,
    failure_stage           TEXT,
    failure_classification  TEXT,
    created_at              TEXT NOT NULL,
    updated_at              TEXT NOT NULL,
    PRIMARY KEY (batch_id, source_intake_id),
    UNIQUE (batch_id, ordinal),
    FOREIGN KEY (batch_id) REFERENCES editorial_batches(id) ON DELETE RESTRICT,
    FOREIGN KEY (source_intake_id) REFERENCES source_intakes(id) ON DELETE RESTRICT,
    FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE RESTRICT,
    FOREIGN KEY (candidate_id) REFERENCES satire_candidates(id) ON DELETE RESTRICT,
    FOREIGN KEY (story_id) REFERENCES stories(id) ON DELETE RESTRICT,
    CHECK ((workflow_state IN ('SELECTED', 'GENERATING', 'READY_FOR_REVIEW', 'PUBLISHED', 'FAILED')
            AND selected_by_email IS NOT NULL AND selected_at IS NOT NULL)
        OR workflow_state IN ('INGESTED', 'REJECTED')),
    CHECK ((workflow_state = 'FAILED' AND failure_stage IS NOT NULL AND failure_classification IS NOT NULL)
        OR workflow_state <> 'FAILED'),
    CHECK ((workflow_state = 'PUBLISHED' AND story_id IS NOT NULL) OR workflow_state <> 'PUBLISHED')
);

CREATE INDEX idx_editorial_batch_items_workflow
ON editorial_batch_items(workflow_state, updated_at);

CREATE TABLE editorial_stage_reminders (
    batch_id                TEXT NOT NULL,
    stage                   TEXT NOT NULL CHECK (stage IN ('TRIAGE', 'FINAL_REVIEW')),
    created_at              TEXT NOT NULL,
    initial_sent_at         TEXT,
    six_hour_sent_at        TEXT,
    final_sent_at           TEXT,
    resolved_at             TEXT,
    claim_kind              TEXT CHECK (claim_kind IN ('INITIAL', 'SIX_HOUR', 'FINAL')),
    claim_token             TEXT,
    claimed_at              TEXT,
    last_error              TEXT,
    PRIMARY KEY (batch_id, stage),
    FOREIGN KEY (batch_id) REFERENCES editorial_batches(id) ON DELETE RESTRICT,
    CHECK ((claim_kind IS NULL AND claim_token IS NULL AND claimed_at IS NULL)
        OR (claim_kind IS NOT NULL AND claim_token IS NOT NULL AND claimed_at IS NOT NULL)),
    CHECK (six_hour_sent_at IS NULL OR initial_sent_at IS NOT NULL),
    CHECK (final_sent_at IS NULL OR initial_sent_at IS NOT NULL)
);

CREATE TABLE editorial_workflow_events (
    id                      TEXT PRIMARY KEY,
    batch_id                TEXT NOT NULL,
    source_intake_id        TEXT,
    story_id                TEXT,
    event_kind              TEXT NOT NULL,
    reminder_stage          TEXT CHECK (reminder_stage IN ('TRIAGE', 'FINAL_REVIEW')),
    reminder_kind           TEXT CHECK (reminder_kind IN ('INITIAL', 'SIX_HOUR', 'FINAL')),
    detail                  TEXT,
    created_at              TEXT NOT NULL,
    FOREIGN KEY (batch_id) REFERENCES editorial_batches(id) ON DELETE RESTRICT,
    FOREIGN KEY (source_intake_id) REFERENCES source_intakes(id) ON DELETE RESTRICT,
    FOREIGN KEY (story_id) REFERENCES stories(id) ON DELETE RESTRICT
);

CREATE INDEX idx_editorial_workflow_events_batch
ON editorial_workflow_events(batch_id, created_at);

CREATE TABLE review_notification_receipts (
    idempotency_key        TEXT PRIMARY KEY,
    batch_id               TEXT NOT NULL,
    stage                  TEXT NOT NULL CHECK (stage IN ('TRIAGE', 'FINAL_REVIEW')),
    kind                   TEXT NOT NULL CHECK (kind IN ('INITIAL', 'SIX_HOUR', 'FINAL')),
    message_text           TEXT NOT NULL,
    review_url             TEXT,
    status                 TEXT NOT NULL CHECK (status IN ('PROCESSING', 'DELIVERED', 'FAILED')),
    attempt_count          INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count > 0),
    failure_classification TEXT,
    received_at            TEXT NOT NULL,
    last_attempt_at        TEXT NOT NULL,
    delivered_at           TEXT,
    FOREIGN KEY (batch_id) REFERENCES editorial_batches(id) ON DELETE RESTRICT,
    CHECK ((status = 'DELIVERED' AND delivered_at IS NOT NULL)
        OR (status <> 'DELIVERED' AND delivered_at IS NULL))
);

CREATE INDEX idx_review_notification_receipts_status
ON review_notification_receipts(status, last_attempt_at);

CREATE TABLE editorial_notifications (
    idempotency_key TEXT PRIMARY KEY,
    batch_id        TEXT NOT NULL,
    stage           TEXT NOT NULL CHECK (stage IN ('TRIAGE', 'FINAL_REVIEW')),
    kind            TEXT NOT NULL CHECK (kind IN ('INITIAL', 'SIX_HOUR', 'FINAL')),
    message_text    TEXT NOT NULL,
    review_url      TEXT,
    created_at      TEXT NOT NULL,
    FOREIGN KEY (idempotency_key) REFERENCES review_notification_receipts(idempotency_key) ON DELETE RESTRICT,
    FOREIGN KEY (batch_id) REFERENCES editorial_batches(id) ON DELETE RESTRICT
);

CREATE INDEX idx_editorial_notifications_created
ON editorial_notifications(created_at DESC);

CREATE TRIGGER editorial_workflow_events_no_update
BEFORE UPDATE ON editorial_workflow_events
BEGIN
    SELECT RAISE(ABORT, 'editorial workflow events are immutable');
END;

CREATE TRIGGER editorial_workflow_events_no_delete
BEFORE DELETE ON editorial_workflow_events
BEGIN
    SELECT RAISE(ABORT, 'editorial workflow events cannot be deleted');
END;

PRAGMA optimize;
