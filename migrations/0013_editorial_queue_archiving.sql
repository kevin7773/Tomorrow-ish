PRAGMA foreign_keys = ON;

ALTER TABLE source_intakes ADD COLUMN archived_at TEXT;
ALTER TABLE source_intakes ADD COLUMN archived_by_email TEXT;
ALTER TABLE source_intakes ADD COLUMN archive_reason TEXT;

ALTER TABLE satire_candidates ADD COLUMN archived_at TEXT;
ALTER TABLE satire_candidates ADD COLUMN archived_by_email TEXT;
ALTER TABLE satire_candidates ADD COLUMN archive_reason TEXT;

CREATE INDEX idx_source_intakes_active_updated_at
ON source_intakes(updated_at DESC)
WHERE archived_at IS NULL;

CREATE INDEX idx_source_intakes_archived_at
ON source_intakes(archived_at DESC)
WHERE archived_at IS NOT NULL;

CREATE INDEX idx_satire_candidates_active_updated_at
ON satire_candidates(updated_at DESC)
WHERE archived_at IS NULL;

CREATE INDEX idx_satire_candidates_archived_at
ON satire_candidates(archived_at DESC)
WHERE archived_at IS NOT NULL;

CREATE TRIGGER source_intakes_archive_insert_guard
BEFORE INSERT ON source_intakes
WHEN NEW.archived_at IS NOT NULL
  OR NEW.archived_by_email IS NOT NULL
  OR NEW.archive_reason IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'source intakes must be archived through an audited action');
END;

CREATE TRIGGER source_intakes_archive_metadata_guard
BEFORE UPDATE OF archived_at, archived_by_email, archive_reason ON source_intakes
WHEN (NEW.archived_at IS NULL AND (
        NEW.archived_by_email IS NOT NULL OR NEW.archive_reason IS NOT NULL
     ))
  OR (NEW.archived_at IS NOT NULL AND (
        NEW.archived_by_email IS NULL OR trim(NEW.archived_by_email) = ''
     ))
  OR (NEW.archive_reason IS NOT NULL AND trim(NEW.archive_reason) = '')
BEGIN
    SELECT RAISE(ABORT, 'invalid source intake archive metadata');
END;

CREATE TRIGGER source_intakes_archive_eligibility_guard
BEFORE UPDATE OF archived_at ON source_intakes
WHEN OLD.archived_at IS NULL
 AND NEW.archived_at IS NOT NULL
 AND NEW.satire_suitability <> 'UNSUITABLE'
BEGIN
    SELECT RAISE(ABORT, 'only unsuitable source intakes can be archived');
END;

CREATE TRIGGER source_intakes_archived_status_guard
BEFORE UPDATE OF satire_suitability ON source_intakes
WHEN OLD.archived_at IS NOT NULL
 AND NEW.satire_suitability <> OLD.satire_suitability
BEGIN
    SELECT RAISE(ABORT, 'restore the source intake before changing suitability');
END;

CREATE TRIGGER source_intakes_archive_immutable_guard
BEFORE UPDATE OF archived_at, archived_by_email, archive_reason ON source_intakes
WHEN OLD.archived_at IS NOT NULL
 AND NEW.archived_at IS NOT NULL
 AND (
    NEW.archived_at <> OLD.archived_at
    OR NEW.archived_by_email IS NOT OLD.archived_by_email
    OR NEW.archive_reason IS NOT OLD.archive_reason
 )
BEGIN
    SELECT RAISE(ABORT, 'source intake archive metadata is immutable until restore');
END;

CREATE TRIGGER satire_candidates_archive_insert_guard
BEFORE INSERT ON satire_candidates
WHEN NEW.archived_at IS NOT NULL
  OR NEW.archived_by_email IS NOT NULL
  OR NEW.archive_reason IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'satire candidates must be archived through an audited action');
END;

CREATE TRIGGER satire_candidates_archive_metadata_guard
BEFORE UPDATE OF archived_at, archived_by_email, archive_reason ON satire_candidates
WHEN (NEW.archived_at IS NULL AND (
        NEW.archived_by_email IS NOT NULL OR NEW.archive_reason IS NOT NULL
     ))
  OR (NEW.archived_at IS NOT NULL AND (
        NEW.archived_by_email IS NULL OR trim(NEW.archived_by_email) = ''
     ))
  OR (NEW.archive_reason IS NOT NULL AND trim(NEW.archive_reason) = '')
BEGIN
    SELECT RAISE(ABORT, 'invalid satire candidate archive metadata');
END;

CREATE TRIGGER satire_candidates_archive_eligibility_guard
BEFORE UPDATE OF archived_at ON satire_candidates
WHEN OLD.archived_at IS NULL
 AND NEW.archived_at IS NOT NULL
 AND NEW.status <> 'REJECTED'
BEGIN
    SELECT RAISE(ABORT, 'only rejected satire candidates can be archived');
END;

CREATE TRIGGER satire_candidates_archived_status_guard
BEFORE UPDATE OF status ON satire_candidates
WHEN OLD.archived_at IS NOT NULL
 AND NEW.status <> OLD.status
BEGIN
    SELECT RAISE(ABORT, 'restore the satire candidate before changing status');
END;

CREATE TRIGGER satire_candidates_archive_immutable_guard
BEFORE UPDATE OF archived_at, archived_by_email, archive_reason ON satire_candidates
WHEN OLD.archived_at IS NOT NULL
 AND NEW.archived_at IS NOT NULL
 AND (
    NEW.archived_at <> OLD.archived_at
    OR NEW.archived_by_email IS NOT OLD.archived_by_email
    OR NEW.archive_reason IS NOT OLD.archive_reason
 )
BEGIN
    SELECT RAISE(ABORT, 'satire candidate archive metadata is immutable until restore');
END;

PRAGMA optimize;
