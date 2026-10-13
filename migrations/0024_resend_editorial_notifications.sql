PRAGMA foreign_keys = ON;

CREATE TABLE resend_email_submissions (
    idempotency_key        TEXT PRIMARY KEY,
    operation_key          TEXT NOT NULL UNIQUE,
    idempotency_hash       TEXT NOT NULL UNIQUE CHECK (length(idempotency_hash) = 64),
    payload_hash           TEXT NOT NULL CHECK (length(payload_hash) = 64),
    status                 TEXT NOT NULL CHECK (status IN ('PENDING', 'DELIVERED', 'FAILED', 'AMBIGUOUS')),
    provider_email_id      TEXT UNIQUE,
    failure_classification TEXT,
    response_status        INTEGER,
    created_at             TEXT NOT NULL,
    updated_at             TEXT NOT NULL,
    accepted_at            TEXT,
    delivered_at           TEXT,
    failed_at              TEXT,

    FOREIGN KEY (operation_key)
        REFERENCES external_review_notification_deliveries(operation_key) ON DELETE RESTRICT,
    CHECK ((status = 'DELIVERED' AND provider_email_id IS NOT NULL AND delivered_at IS NOT NULL)
        OR (status <> 'DELIVERED' AND delivered_at IS NULL)),
    CHECK ((accepted_at IS NULL) OR provider_email_id IS NOT NULL),
    CHECK ((status = 'FAILED' AND failed_at IS NOT NULL)
        OR (status <> 'FAILED' AND failed_at IS NULL))
);

CREATE INDEX idx_resend_email_submissions_status
ON resend_email_submissions(status, updated_at);

CREATE TRIGGER resend_email_submissions_no_delete
BEFORE DELETE ON resend_email_submissions
BEGIN
    SELECT RAISE(ABORT, 'Resend submission evidence cannot be deleted');
END;

CREATE TRIGGER resend_email_submission_identity_immutable
BEFORE UPDATE ON resend_email_submissions
WHEN NEW.idempotency_key <> OLD.idempotency_key
  OR NEW.operation_key <> OLD.operation_key
  OR NEW.idempotency_hash <> OLD.idempotency_hash
  OR NEW.payload_hash <> OLD.payload_hash
  OR NEW.created_at <> OLD.created_at
  OR (OLD.provider_email_id IS NOT NULL AND NEW.provider_email_id IS NOT OLD.provider_email_id)
  OR (OLD.accepted_at IS NOT NULL AND NEW.accepted_at IS NOT OLD.accepted_at)
BEGIN
    SELECT RAISE(ABORT, 'Resend submission identity is immutable');
END;

CREATE TRIGGER resend_email_submission_status_guard
BEFORE UPDATE OF status ON resend_email_submissions
WHEN NEW.status <> OLD.status
 AND NOT (
    OLD.status = 'PENDING' AND NEW.status IN ('DELIVERED', 'FAILED', 'AMBIGUOUS')
    OR OLD.status = 'AMBIGUOUS' AND NEW.status IN ('DELIVERED', 'FAILED')
 )
BEGIN
    SELECT RAISE(ABORT, 'invalid Resend submission status transition');
END;

CREATE TABLE resend_email_delivery_events (
    event_id             TEXT PRIMARY KEY,
    operation_key        TEXT NOT NULL,
    provider_email_id    TEXT NOT NULL,
    event_type           TEXT NOT NULL CHECK (event_type IN (
                            'email.delivered',
                            'email.delivery_delayed',
                            'email.failed',
                            'email.bounced',
                            'email.suppressed'
                        )),
    disposition          TEXT NOT NULL CHECK (disposition IN (
                            'DELIVERED', 'DELAYED', 'FAILED', 'IGNORED_TERMINAL'
                        )),
    provider_created_at  TEXT NOT NULL,
    payload_hash         TEXT NOT NULL CHECK (length(payload_hash) = 64),
    received_at          TEXT NOT NULL,

    FOREIGN KEY (operation_key)
        REFERENCES external_review_notification_deliveries(operation_key) ON DELETE RESTRICT,
    FOREIGN KEY (provider_email_id)
        REFERENCES resend_email_submissions(provider_email_id) ON DELETE RESTRICT
);

CREATE INDEX idx_resend_email_delivery_events_operation
ON resend_email_delivery_events(operation_key, received_at);

CREATE TRIGGER resend_email_delivery_events_no_update
BEFORE UPDATE ON resend_email_delivery_events
BEGIN
    SELECT RAISE(ABORT, 'Resend delivery events are immutable');
END;

CREATE TRIGGER resend_email_delivery_events_no_delete
BEFORE DELETE ON resend_email_delivery_events
BEGIN
    SELECT RAISE(ABORT, 'Resend delivery events cannot be deleted');
END;

DROP TRIGGER external_review_notification_status_guard;

CREATE TRIGGER external_review_notification_status_guard
BEFORE UPDATE OF status ON external_review_notification_deliveries
WHEN NEW.status <> OLD.status
 AND NOT (
     OLD.status = 'PENDING' AND NEW.status IN ('DELIVERED', 'FAILED', 'AMBIGUOUS')
     OR OLD.status = 'AMBIGUOUS' AND NEW.status IN ('DELIVERED', 'FAILED')
        AND (EXISTS (
            SELECT 1 FROM external_review_notification_reconciliations AS reconciliation
            WHERE reconciliation.operation_key = OLD.operation_key
              AND ((NEW.status = 'DELIVERED' AND reconciliation.decision = 'CONFIRMED_DELIVERED')
                OR (NEW.status = 'FAILED' AND reconciliation.decision = 'CONFIRMED_FAILED'))
        ) OR EXISTS (
            SELECT 1 FROM resend_email_delivery_events AS event
            WHERE event.operation_key = OLD.operation_key
              AND ((NEW.status = 'DELIVERED' AND event.disposition = 'DELIVERED')
                OR (NEW.status = 'FAILED' AND event.disposition = 'FAILED'))
        ))
     OR OLD.status = 'FAILED' AND NEW.status = 'DELIVERED'
        AND EXISTS (
            SELECT 1 FROM external_review_notification_reconciliations AS reconciliation
            WHERE reconciliation.operation_key = OLD.operation_key
              AND reconciliation.decision = 'MANUALLY_DELIVERED'
        )
 )
BEGIN
    SELECT RAISE(ABORT, 'invalid external notification status transition');
END;

PRAGMA optimize;
