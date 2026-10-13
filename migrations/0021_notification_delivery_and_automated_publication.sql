PRAGMA foreign_keys = ON;

CREATE TABLE external_review_notification_deliveries (
    operation_key          TEXT PRIMARY KEY,
    idempotency_key        TEXT NOT NULL UNIQUE,
    batch_id               TEXT NOT NULL,
    stage                  TEXT NOT NULL CHECK (stage IN ('TRIAGE', 'FINAL_REVIEW')),
    kind                   TEXT NOT NULL CHECK (kind IN ('INITIAL', 'SIX_HOUR', 'FINAL')),
    message_text           TEXT NOT NULL,
    review_url             TEXT,
    status                 TEXT NOT NULL CHECK (status IN ('PENDING', 'DELIVERED', 'FAILED', 'AMBIGUOUS')),
    owner_token            TEXT NOT NULL,
    attempt_count          INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count = 1),
    response_status        INTEGER,
    provider_request_id    TEXT,
    failure_classification TEXT,
    created_at             TEXT NOT NULL,
    updated_at             TEXT NOT NULL,
    delivered_at           TEXT,

    FOREIGN KEY (batch_id) REFERENCES editorial_batches(id) ON DELETE RESTRICT,
    CHECK ((status = 'DELIVERED' AND delivered_at IS NOT NULL)
        OR (status <> 'DELIVERED' AND delivered_at IS NULL))
);

CREATE INDEX idx_external_review_notification_status
ON external_review_notification_deliveries(status, updated_at);

CREATE TRIGGER external_review_notification_deliveries_no_delete
BEFORE DELETE ON external_review_notification_deliveries
BEGIN
    SELECT RAISE(ABORT, 'external notification delivery evidence cannot be deleted');
END;

CREATE TRIGGER external_review_notification_identity_immutable
BEFORE UPDATE ON external_review_notification_deliveries
WHEN NEW.operation_key <> OLD.operation_key
  OR NEW.idempotency_key <> OLD.idempotency_key
  OR NEW.batch_id <> OLD.batch_id
  OR NEW.stage <> OLD.stage
  OR NEW.kind <> OLD.kind
  OR NEW.message_text <> OLD.message_text
  OR NEW.review_url IS NOT OLD.review_url
  OR NEW.owner_token <> OLD.owner_token
  OR NEW.attempt_count <> OLD.attempt_count
  OR NEW.created_at <> OLD.created_at
BEGIN
    SELECT RAISE(ABORT, 'external notification identity is immutable');
END;

CREATE TRIGGER external_review_notification_status_guard
BEFORE UPDATE OF status ON external_review_notification_deliveries
WHEN NEW.status <> OLD.status
 AND NOT (OLD.status = 'PENDING' AND NEW.status IN ('DELIVERED', 'FAILED', 'AMBIGUOUS'))
BEGIN
    SELECT RAISE(ABORT, 'invalid external notification status transition');
END;

CREATE TABLE editorial_publication_attempts (
    id                 TEXT PRIMARY KEY,
    story_id           TEXT NOT NULL UNIQUE,
    batch_id           TEXT NOT NULL,
    source_intake_id   TEXT NOT NULL,
    candidate_id       TEXT NOT NULL,
    owner_token        TEXT NOT NULL,
    actor_email        TEXT NOT NULL,
    audit_id           TEXT NOT NULL UNIQUE,
    workflow_event_id  TEXT NOT NULL UNIQUE,
    status             TEXT NOT NULL CHECK (status IN ('CLAIMED', 'PUBLISHED')),
    claimed_at         TEXT NOT NULL,
    lease_expires_at   TEXT NOT NULL,
    published_at       TEXT,
    attempt_count      INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count > 0),

    FOREIGN KEY (story_id) REFERENCES stories(id) ON DELETE RESTRICT,
    FOREIGN KEY (batch_id, source_intake_id)
        REFERENCES editorial_batch_items(batch_id, source_intake_id) ON DELETE RESTRICT,
    FOREIGN KEY (candidate_id) REFERENCES satire_candidates(id) ON DELETE RESTRICT,
    CHECK ((status = 'PUBLISHED' AND published_at IS NOT NULL)
        OR (status = 'CLAIMED' AND published_at IS NULL))
);

CREATE INDEX idx_editorial_publication_attempts_status
ON editorial_publication_attempts(status, lease_expires_at);

CREATE TRIGGER editorial_publication_attempts_no_delete
BEFORE DELETE ON editorial_publication_attempts
BEGIN
    SELECT RAISE(ABORT, 'publication attempt evidence cannot be deleted');
END;

CREATE TRIGGER editorial_publication_attempt_identity_guard
BEFORE UPDATE ON editorial_publication_attempts
WHEN NEW.id <> OLD.id
  OR NEW.story_id <> OLD.story_id
  OR NEW.batch_id <> OLD.batch_id
  OR NEW.source_intake_id <> OLD.source_intake_id
  OR NEW.candidate_id <> OLD.candidate_id
BEGIN
    SELECT RAISE(ABORT, 'publication attempt identity is immutable');
END;

CREATE TRIGGER editorial_publication_attempt_status_guard
BEFORE UPDATE OF status ON editorial_publication_attempts
WHEN NEW.status <> OLD.status
 AND NOT (OLD.status = 'CLAIMED' AND NEW.status = 'PUBLISHED')
BEGIN
    SELECT RAISE(ABORT, 'invalid publication attempt status transition');
END;

CREATE TRIGGER governed_automated_story_publication
AFTER UPDATE OF status ON stories
WHEN OLD.status = 'APPROVED' AND NEW.status = 'PUBLISHED'
  AND EXISTS (
      SELECT 1 FROM editorial_publication_attempts AS attempt
      WHERE attempt.story_id = NEW.id AND attempt.status = 'CLAIMED'
        AND attempt.lease_expires_at > NEW.updated_at
  )
BEGIN
    UPDATE editorial_batch_items
    SET workflow_state = 'PUBLISHED', updated_at = NEW.updated_at,
        lease_owner = NULL, lease_acquired_at = NULL, lease_expires_at = NULL
    WHERE story_id = NEW.id AND workflow_state = 'READY_FOR_REVIEW'
      AND EXISTS (
          SELECT 1 FROM editorial_publication_attempts AS attempt
          WHERE attempt.story_id = NEW.id
            AND attempt.batch_id = editorial_batch_items.batch_id
            AND attempt.source_intake_id = editorial_batch_items.source_intake_id
            AND attempt.status = 'CLAIMED'
      );

    INSERT INTO editorial_audit_log
        (id, actor_email, entity_type, entity_id, action, from_status, to_status, reason, created_at)
    SELECT attempt.audit_id, attempt.actor_email, 'STORY', NEW.id, 'PUBLISHED',
        'APPROVED', 'PUBLISHED', 'governed-automated-publication:v1', NEW.updated_at
    FROM editorial_publication_attempts AS attempt
    WHERE attempt.story_id = NEW.id AND attempt.status = 'CLAIMED'
      AND changes() = 1;

    INSERT INTO editorial_workflow_events
        (id, batch_id, source_intake_id, story_id, event_kind, detail, created_at)
    SELECT attempt.workflow_event_id, attempt.batch_id, attempt.source_intake_id,
        NEW.id, 'ARTICLE_PUBLISHED', 'governed-automated-publication:v1', NEW.updated_at
    FROM editorial_publication_attempts AS attempt
    WHERE attempt.story_id = NEW.id AND attempt.status = 'CLAIMED'
      AND EXISTS (SELECT 1 FROM editorial_audit_log WHERE id = attempt.audit_id);

    UPDATE editorial_publication_attempts
    SET status = 'PUBLISHED', published_at = NEW.updated_at
    WHERE story_id = NEW.id AND status = 'CLAIMED'
      AND EXISTS (SELECT 1 FROM editorial_audit_log WHERE id = audit_id)
      AND EXISTS (SELECT 1 FROM editorial_workflow_events WHERE id = workflow_event_id);

    SELECT (CASE WHEN NOT EXISTS (
        SELECT 1 FROM editorial_publication_attempts AS attempt
        JOIN editorial_batch_items AS item
          ON item.batch_id = attempt.batch_id AND item.source_intake_id = attempt.source_intake_id
        WHERE attempt.story_id = NEW.id AND attempt.status = 'PUBLISHED'
          AND attempt.published_at = NEW.updated_at AND item.workflow_state = 'PUBLISHED'
          AND EXISTS (SELECT 1 FROM editorial_audit_log WHERE id = attempt.audit_id)
          AND EXISTS (SELECT 1 FROM editorial_workflow_events WHERE id = attempt.workflow_event_id)
    ) THEN RAISE(ABORT, 'automated publication invariants were not committed atomically') END);
END;

PRAGMA optimize;
