PRAGMA foreign_keys = ON;

CREATE TABLE routine_generation_batch_admissions (
    operating_date  TEXT PRIMARY KEY CHECK (operating_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    time_zone       TEXT NOT NULL CHECK (time_zone = 'America/New_York'),
    batch_id        TEXT NOT NULL UNIQUE,
    actor_email     TEXT NOT NULL,
    admitted_at     TEXT NOT NULL,

    FOREIGN KEY (batch_id) REFERENCES editorial_batches(id) ON DELETE RESTRICT
);

CREATE TRIGGER routine_generation_batch_admissions_no_update
BEFORE UPDATE ON routine_generation_batch_admissions
BEGIN
    SELECT RAISE(ABORT, 'routine generation batch admissions are immutable');
END;

CREATE TRIGGER routine_generation_batch_admissions_no_delete
BEFORE DELETE ON routine_generation_batch_admissions
BEGIN
    SELECT RAISE(ABORT, 'routine generation batch admissions cannot be deleted');
END;

CREATE TABLE external_review_notification_reconciliations (
    id                 TEXT PRIMARY KEY,
    operation_key      TEXT NOT NULL,
    decision           TEXT NOT NULL CHECK (decision IN (
                            'CONFIRMED_DELIVERED',
                            'CONFIRMED_FAILED',
                            'MANUALLY_DELIVERED'
                        )),
    evidence_reference TEXT NOT NULL CHECK (
                            length(trim(evidence_reference)) BETWEEN 1 AND 500
                        ),
    actor_email        TEXT NOT NULL,
    created_at         TEXT NOT NULL,

    FOREIGN KEY (operation_key)
        REFERENCES external_review_notification_deliveries(operation_key) ON DELETE RESTRICT,
    UNIQUE (operation_key, decision)
);

CREATE TRIGGER external_review_notification_reconciliations_no_update
BEFORE UPDATE ON external_review_notification_reconciliations
BEGIN
    SELECT RAISE(ABORT, 'notification reconciliations are append-only');
END;

CREATE TRIGGER external_review_notification_reconciliations_no_delete
BEFORE DELETE ON external_review_notification_reconciliations
BEGIN
    SELECT RAISE(ABORT, 'notification reconciliations cannot be deleted');
END;

DROP TRIGGER external_review_notification_status_guard;

CREATE TRIGGER external_review_notification_status_guard
BEFORE UPDATE OF status ON external_review_notification_deliveries
WHEN NEW.status <> OLD.status
 AND NOT (
     OLD.status = 'PENDING' AND NEW.status IN ('DELIVERED', 'FAILED', 'AMBIGUOUS')
     OR OLD.status = 'AMBIGUOUS' AND NEW.status IN ('DELIVERED', 'FAILED')
        AND EXISTS (
            SELECT 1 FROM external_review_notification_reconciliations AS reconciliation
            WHERE reconciliation.operation_key = OLD.operation_key
              AND ((NEW.status = 'DELIVERED' AND reconciliation.decision = 'CONFIRMED_DELIVERED')
                OR (NEW.status = 'FAILED' AND reconciliation.decision = 'CONFIRMED_FAILED'))
        )
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

CREATE TRIGGER apply_external_review_notification_reconciliation
AFTER INSERT ON external_review_notification_reconciliations
BEGIN
    UPDATE external_review_notification_deliveries
    SET status = CASE
            WHEN NEW.decision = 'CONFIRMED_FAILED' THEN 'FAILED'
            ELSE 'DELIVERED'
        END,
        failure_classification = CASE
            WHEN NEW.decision = 'CONFIRMED_FAILED' THEN 'OPERATOR_CONFIRMED_NOT_DELIVERED'
            ELSE NULL
        END,
        updated_at = NEW.created_at,
        delivered_at = CASE
            WHEN NEW.decision IN ('CONFIRMED_DELIVERED', 'MANUALLY_DELIVERED') THEN NEW.created_at
            ELSE NULL
        END
    WHERE operation_key = NEW.operation_key
      AND ((status = 'AMBIGUOUS' AND NEW.decision IN ('CONFIRMED_DELIVERED', 'CONFIRMED_FAILED'))
        OR (status = 'FAILED' AND NEW.decision = 'CONFIRMED_FAILED')
        OR (status = 'FAILED' AND NEW.decision = 'MANUALLY_DELIVERED'));

    SELECT CASE WHEN changes() <> 1
        THEN RAISE(ABORT, 'notification reconciliation is incompatible with current delivery state') END;
END;

PRAGMA optimize;
