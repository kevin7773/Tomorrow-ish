PRAGMA foreign_keys = ON;

CREATE TABLE _migration_0017_guard (
    eligible_count INTEGER NOT NULL CHECK (eligible_count BETWEEN 0 AND 1)
);

INSERT INTO _migration_0017_guard (eligible_count)
SELECT COUNT(*)
FROM model_request_reservations AS reservation
WHERE reservation.status = 'AMBIGUOUS'
  AND reservation.idempotency_key = 'generate:5ddcc5c9-3fe1-4f1c-bc57-6e749e9d5d4d:f4b7b8c7-342f-4ac7-b1fb-9a704381875e'
  AND reservation.operation = 'GENERATE_CANDIDATES'
  AND reservation.source_intake_id = '2c7f63bc-a733-4952-84f3-3bc6048290cb'
  AND reservation.normalized_event_version_id = '5ddcc5c9-3fe1-4f1c-bc57-6e749e9d5d4d'
  AND EXISTS (
    SELECT 1
    FROM model_runs AS run
    WHERE run.id = '93162d5c-8274-447e-91fe-3698bf62fd6c'
      AND run.idempotency_key = reservation.idempotency_key
      AND run.operation = reservation.operation
      AND run.source_intake_id = reservation.source_intake_id
      AND run.normalized_event_version_id IS reservation.normalized_event_version_id
      AND run.status = 'FAILED'
      AND run.failure_classification = 'PROVIDER_REQUEST'
      AND run.provider_http_status = 400
      AND run.provider_error_type = 'invalid_request_error'
      AND run.provider_error_code = 'invalid_json_schema'
      AND run.provider_request_id = 'req_cf418a81079944ca98b9683350cfa5fd'
      AND run.retry_count = 0
  );

-- Migration 0016 intentionally makes terminal reservations immutable. Temporarily
-- remove that guard only for evidence-backed corrections, then restore it before
-- the migration completes.
DROP TRIGGER model_request_reservations_terminal_immutable;

UPDATE model_request_reservations AS reservation
SET status = 'FAILED'
WHERE reservation.status = 'AMBIGUOUS'
  AND reservation.idempotency_key = 'generate:5ddcc5c9-3fe1-4f1c-bc57-6e749e9d5d4d:f4b7b8c7-342f-4ac7-b1fb-9a704381875e'
  AND reservation.operation = 'GENERATE_CANDIDATES'
  AND reservation.source_intake_id = '2c7f63bc-a733-4952-84f3-3bc6048290cb'
  AND reservation.normalized_event_version_id = '5ddcc5c9-3fe1-4f1c-bc57-6e749e9d5d4d'
  AND EXISTS (
    SELECT 1
    FROM model_runs AS run
    WHERE run.id = '93162d5c-8274-447e-91fe-3698bf62fd6c'
      AND run.idempotency_key = reservation.idempotency_key
      AND run.operation = reservation.operation
      AND run.source_intake_id = reservation.source_intake_id
      AND run.normalized_event_version_id IS reservation.normalized_event_version_id
      AND run.status = 'FAILED'
      AND run.failure_classification = 'PROVIDER_REQUEST'
      AND run.provider_http_status = 400
      AND run.provider_error_type = 'invalid_request_error'
      AND run.provider_error_code = 'invalid_json_schema'
      AND run.provider_request_id = 'req_cf418a81079944ca98b9683350cfa5fd'
      AND run.retry_count = 0
  );

DROP TABLE _migration_0017_guard;

CREATE TRIGGER model_request_reservations_terminal_immutable
BEFORE UPDATE ON model_request_reservations
WHEN OLD.status <> 'PENDING'
BEGIN
    SELECT RAISE(ABORT, 'terminal model request reservations are immutable');
END;

PRAGMA optimize;
