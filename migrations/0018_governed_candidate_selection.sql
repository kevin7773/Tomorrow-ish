PRAGMA foreign_keys = ON;

CREATE TABLE editorial_candidate_selections (
    batch_id                    TEXT NOT NULL,
    source_intake_id            TEXT NOT NULL,
    normalized_event_version_id TEXT NOT NULL,
    candidate_id                TEXT NOT NULL UNIQUE,
    previous_candidate_id       TEXT,
    selected_by_email           TEXT NOT NULL,
    selected_at                 TEXT NOT NULL,
    revision                    INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),

    PRIMARY KEY (batch_id, source_intake_id),

    FOREIGN KEY (batch_id, source_intake_id)
        REFERENCES editorial_batch_items(batch_id, source_intake_id) ON DELETE RESTRICT,
    FOREIGN KEY (normalized_event_version_id)
        REFERENCES normalized_event_versions(id) ON DELETE RESTRICT,
    FOREIGN KEY (candidate_id)
        REFERENCES satire_candidates(id) ON DELETE RESTRICT,
    FOREIGN KEY (previous_candidate_id)
        REFERENCES satire_candidates(id) ON DELETE RESTRICT
);

CREATE TABLE editorial_candidate_selection_events (
    id                          TEXT PRIMARY KEY,
    batch_id                    TEXT NOT NULL,
    source_intake_id            TEXT NOT NULL,
    normalized_event_version_id TEXT NOT NULL,
    candidate_id                TEXT NOT NULL,
    previous_candidate_id       TEXT,
    selected_by_email           TEXT NOT NULL,
    selected_at                 TEXT NOT NULL,
    revision                    INTEGER NOT NULL CHECK (revision > 0),
    reason                      TEXT,
    event_kind                  TEXT NOT NULL CHECK (event_kind IN ('SELECTED', 'SELECTION_CHANGED')),

    FOREIGN KEY (batch_id) REFERENCES editorial_batches(id) ON DELETE RESTRICT,
    FOREIGN KEY (source_intake_id) REFERENCES source_intakes(id) ON DELETE RESTRICT,
    FOREIGN KEY (normalized_event_version_id) REFERENCES normalized_event_versions(id) ON DELETE RESTRICT,
    FOREIGN KEY (candidate_id) REFERENCES satire_candidates(id) ON DELETE RESTRICT,
    FOREIGN KEY (previous_candidate_id) REFERENCES satire_candidates(id) ON DELETE RESTRICT,
    UNIQUE (batch_id, source_intake_id, revision)
);

CREATE INDEX idx_candidate_selection_events_candidate
ON editorial_candidate_selection_events(candidate_id, selected_at DESC);

CREATE TRIGGER editorial_candidate_selection_replacement_guard
BEFORE UPDATE ON editorial_candidate_selections
WHEN NEW.batch_id <> OLD.batch_id
  OR NEW.source_intake_id <> OLD.source_intake_id
  OR NEW.candidate_id = OLD.candidate_id
  OR NEW.previous_candidate_id IS NOT OLD.candidate_id
  OR NEW.revision <> OLD.revision + 1
  OR EXISTS (
      SELECT 1 FROM satire_candidates AS candidate
      WHERE candidate.id = OLD.candidate_id
        AND (candidate.body_generation_state <> 'NOT_REQUESTED'
          OR trim(candidate.draft_body_markdown) <> '')
  )
  OR EXISTS (
      SELECT 1 FROM candidate_body_generation_runs AS run
      WHERE run.candidate_id = OLD.candidate_id
  )
  OR EXISTS (
      SELECT 1 FROM stories AS story WHERE story.origin_candidate_id = OLD.candidate_id
  )
BEGIN
    SELECT RAISE(ABORT, 'invalid or late candidate selection replacement');
END;

CREATE TRIGGER editorial_candidate_selections_no_delete
BEFORE DELETE ON editorial_candidate_selections
BEGIN
    SELECT RAISE(ABORT, 'candidate selections cannot be deleted');
END;

CREATE TRIGGER editorial_candidate_selection_events_no_update
BEFORE UPDATE ON editorial_candidate_selection_events
BEGIN
    SELECT RAISE(ABORT, 'candidate selection events are append-only');
END;

CREATE TRIGGER editorial_candidate_selection_events_no_delete
BEFORE DELETE ON editorial_candidate_selection_events
BEGIN
    SELECT RAISE(ABORT, 'candidate selection events cannot be deleted');
END;

PRAGMA optimize;
