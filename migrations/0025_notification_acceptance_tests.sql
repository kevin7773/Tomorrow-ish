PRAGMA foreign_keys = ON;

CREATE TABLE editorial_notification_acceptance_tests (
    id                       TEXT PRIMARY KEY,
    authorization_id         TEXT NOT NULL UNIQUE,
    operation_key            TEXT NOT NULL UNIQUE,
    idempotency_key          TEXT NOT NULL UNIQUE,
    idempotency_hash         TEXT NOT NULL UNIQUE CHECK (length(idempotency_hash) = 64),
    payload_hash             TEXT NOT NULL CHECK (length(payload_hash) = 64),
    purpose                  TEXT NOT NULL CHECK (purpose = 'ACCEPTANCE_TEST'),
    actor_email              TEXT NOT NULL,
    status                   TEXT NOT NULL CHECK (status IN ('PENDING', 'DELIVERED', 'FAILED', 'AMBIGUOUS')),
    provider_email_id        TEXT UNIQUE,
    response_status          INTEGER,
    failure_classification   TEXT,
    authorized_at            TEXT NOT NULL,
    updated_at               TEXT NOT NULL,
    provider_accepted_at     TEXT,
    delivered_at             TEXT,
    failed_at                TEXT,

    CHECK ((status = 'DELIVERED' AND provider_email_id IS NOT NULL AND delivered_at IS NOT NULL)
        OR (status <> 'DELIVERED' AND delivered_at IS NULL)),
    CHECK ((provider_accepted_at IS NULL) OR provider_email_id IS NOT NULL),
    CHECK ((status = 'FAILED' AND failed_at IS NOT NULL)
        OR (status <> 'FAILED' AND failed_at IS NULL))
);

CREATE INDEX idx_editorial_notification_acceptance_tests_status
ON editorial_notification_acceptance_tests(status, updated_at);

CREATE TRIGGER editorial_notification_acceptance_tests_no_delete
BEFORE DELETE ON editorial_notification_acceptance_tests
BEGIN
    SELECT RAISE(ABORT, 'notification acceptance-test evidence cannot be deleted');
END;

CREATE TRIGGER editorial_notification_acceptance_test_identity_immutable
BEFORE UPDATE ON editorial_notification_acceptance_tests
WHEN NEW.id <> OLD.id
  OR NEW.authorization_id <> OLD.authorization_id
  OR NEW.operation_key <> OLD.operation_key
  OR NEW.idempotency_key <> OLD.idempotency_key
  OR NEW.idempotency_hash <> OLD.idempotency_hash
  OR NEW.payload_hash <> OLD.payload_hash
  OR NEW.purpose <> OLD.purpose
  OR NEW.actor_email <> OLD.actor_email
  OR NEW.authorized_at <> OLD.authorized_at
  OR (OLD.provider_email_id IS NOT NULL AND NEW.provider_email_id IS NOT OLD.provider_email_id)
  OR (OLD.provider_accepted_at IS NOT NULL AND NEW.provider_accepted_at IS NOT OLD.provider_accepted_at)
BEGIN
    SELECT RAISE(ABORT, 'notification acceptance-test identity is immutable');
END;

CREATE TRIGGER editorial_notification_acceptance_test_status_guard
BEFORE UPDATE OF status ON editorial_notification_acceptance_tests
WHEN NEW.status <> OLD.status
 AND NOT (
    OLD.status = 'PENDING' AND NEW.status IN ('DELIVERED', 'FAILED', 'AMBIGUOUS')
    OR OLD.status = 'AMBIGUOUS' AND NEW.status IN ('DELIVERED', 'FAILED')
 )
BEGIN
    SELECT RAISE(ABORT, 'invalid notification acceptance-test status transition');
END;

CREATE TABLE editorial_notification_acceptance_test_events (
    id                    TEXT PRIMARY KEY,
    acceptance_test_id    TEXT NOT NULL,
    event_kind            TEXT NOT NULL CHECK (event_kind IN (
                              'AUTHORIZED',
                              'PROVIDER_ACCEPTED',
                              'PROVIDER_AMBIGUOUS',
                              'PROVIDER_FAILED',
                              'EMAIL_DELIVERED',
                              'EMAIL_DELAYED',
                              'EMAIL_FAILED',
                              'IGNORED_TERMINAL'
                          )),
    actor_email           TEXT,
    provider_event_id     TEXT UNIQUE,
    provider_email_id     TEXT,
    classification        TEXT,
    response_status       INTEGER,
    payload_hash          TEXT CHECK (payload_hash IS NULL OR length(payload_hash) = 64),
    created_at            TEXT NOT NULL,

    FOREIGN KEY (acceptance_test_id)
        REFERENCES editorial_notification_acceptance_tests(id) ON DELETE RESTRICT,
    CHECK ((event_kind = 'AUTHORIZED' AND actor_email IS NOT NULL)
        OR event_kind <> 'AUTHORIZED')
);

CREATE INDEX idx_editorial_notification_acceptance_test_events_test
ON editorial_notification_acceptance_test_events(acceptance_test_id, created_at);

CREATE TRIGGER editorial_notification_acceptance_test_events_no_update
BEFORE UPDATE ON editorial_notification_acceptance_test_events
BEGIN
    SELECT RAISE(ABORT, 'notification acceptance-test events are immutable');
END;

CREATE TRIGGER editorial_notification_acceptance_test_events_no_delete
BEFORE DELETE ON editorial_notification_acceptance_test_events
BEGIN
    SELECT RAISE(ABORT, 'notification acceptance-test events cannot be deleted');
END;

PRAGMA optimize;
