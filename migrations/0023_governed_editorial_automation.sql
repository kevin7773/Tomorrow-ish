PRAGMA foreign_keys = ON;

ALTER TABLE article_images ADD COLUMN visual_direction TEXT;
ALTER TABLE article_images ADD COLUMN workflow_batch_id TEXT;
ALTER TABLE article_images ADD COLUMN workflow_intake_id TEXT;
ALTER TABLE article_images ADD COLUMN budget_operating_date TEXT;
ALTER TABLE article_images ADD COLUMN automation_scope TEXT
    CHECK (automation_scope IS NULL OR automation_scope = 'ROUTINE_IMAGE_PREPARATION_V1');

CREATE UNIQUE INDEX idx_article_images_one_routine_attempt_per_story
ON article_images(story_id)
WHERE automation_scope = 'ROUTINE_IMAGE_PREPARATION_V1';

CREATE INDEX idx_article_images_routine_batch_budget
ON article_images(workflow_batch_id, estimated_cost_microusd)
WHERE automation_scope = 'ROUTINE_IMAGE_PREPARATION_V1';

CREATE INDEX idx_article_images_routine_day_budget
ON article_images(budget_operating_date, estimated_cost_microusd)
WHERE automation_scope = 'ROUTINE_IMAGE_PREPARATION_V1';

CREATE TRIGGER article_images_routine_identity_immutable
BEFORE UPDATE ON article_images
WHEN NEW.visual_direction IS NOT OLD.visual_direction
  OR NEW.workflow_batch_id IS NOT OLD.workflow_batch_id
  OR NEW.workflow_intake_id IS NOT OLD.workflow_intake_id
  OR NEW.budget_operating_date IS NOT OLD.budget_operating_date
  OR NEW.automation_scope IS NOT OLD.automation_scope
BEGIN
    SELECT RAISE(ABORT, 'routine image preparation identity is immutable');
END;

CREATE TRIGGER article_images_routine_identity_complete
BEFORE INSERT ON article_images
WHEN NEW.automation_scope = 'ROUTINE_IMAGE_PREPARATION_V1'
 AND (
    NEW.visual_direction IS NULL OR length(trim(NEW.visual_direction)) < 20
    OR NEW.workflow_batch_id IS NULL OR NEW.workflow_intake_id IS NULL
    OR NEW.budget_operating_date IS NULL
    OR NEW.attempt_key IS NULL OR NEW.estimated_cost_microusd IS NULL
    OR NOT EXISTS (
        SELECT 1 FROM stories
        WHERE id = NEW.story_id AND status = 'REVIEW'
    )
    OR NOT EXISTS (
        SELECT 1
        FROM routine_generation_batch_admissions AS admission
        JOIN editorial_batch_items AS item
          ON item.batch_id = admission.batch_id
         AND item.source_intake_id = NEW.workflow_intake_id
        WHERE admission.batch_id = NEW.workflow_batch_id
          AND admission.operating_date = NEW.budget_operating_date
          AND item.story_id = NEW.story_id
          AND item.workflow_state = 'GENERATING'
          AND item.lease_owner IS NOT NULL
          AND item.lease_expires_at > NEW.requested_at
          AND EXISTS (
              SELECT 1 FROM editorial_workflow_events AS event
              WHERE event.batch_id = item.batch_id
                AND event.source_intake_id = item.source_intake_id
                AND event.event_kind = 'INTAKE_SELECTED'
                AND event.detail = 'routine-generation:v1'
          )
    )
 )
BEGIN
    SELECT RAISE(ABORT, 'routine image preparation identity is incomplete');
END;

CREATE INDEX idx_model_budget_reservations_batch
ON model_budget_reservations(workflow_batch_id, status)
WHERE workflow_batch_id IS NOT NULL;

CREATE TABLE story_automated_publication_authorizations (
    id                  TEXT PRIMARY KEY,
    story_id            TEXT NOT NULL,
    image_id            TEXT NOT NULL,
    batch_id            TEXT NOT NULL,
    source_intake_id    TEXT NOT NULL,
    candidate_id        TEXT NOT NULL,
    authorization_scope TEXT NOT NULL CHECK (
                            authorization_scope = 'SCHEDULED_PUBLICATION_V1'
                        ),
    story_updated_at    TEXT NOT NULL,
    image_reviewed_at   TEXT NOT NULL,
    image_asset_key     TEXT NOT NULL,
    image_alt_text      TEXT NOT NULL CHECK (length(trim(image_alt_text)) BETWEEN 1 AND 500),
    actor_email         TEXT NOT NULL CHECK (length(trim(actor_email)) > 0),
    authorized_at       TEXT NOT NULL,

    FOREIGN KEY (story_id) REFERENCES stories(id) ON DELETE RESTRICT,
    FOREIGN KEY (image_id) REFERENCES article_images(id) ON DELETE RESTRICT,
    FOREIGN KEY (batch_id, source_intake_id)
        REFERENCES editorial_batch_items(batch_id, source_intake_id) ON DELETE RESTRICT,
    FOREIGN KEY (candidate_id) REFERENCES satire_candidates(id) ON DELETE RESTRICT,
    UNIQUE (story_id, story_updated_at, image_id, authorization_scope)
);

CREATE INDEX idx_story_publication_authorizations_story
ON story_automated_publication_authorizations(story_id, authorized_at DESC);

CREATE TRIGGER story_publication_authorizations_identity_complete
BEFORE INSERT ON story_automated_publication_authorizations
WHEN NOT EXISTS (
        SELECT 1 FROM stories AS story
        WHERE story.id = NEW.story_id
          AND story.status = 'APPROVED'
          AND story.published_at IS NULL
          AND story.updated_at = NEW.story_updated_at
          AND story.og_image_key = NEW.image_asset_key
    )
 OR NOT EXISTS (
        SELECT 1 FROM article_images AS image
        WHERE image.id = NEW.image_id
          AND image.story_id = NEW.story_id
          AND image.status = 'APPROVED'
          AND image.reviewed_at = NEW.image_reviewed_at
          AND image.asset_key = NEW.image_asset_key
          AND trim(image.alt_text) = NEW.image_alt_text
    )
 OR NOT EXISTS (
        SELECT 1 FROM editorial_batch_items AS item
        JOIN routine_generation_batch_admissions AS admission
          ON admission.batch_id = item.batch_id
        JOIN editorial_candidate_selections AS selection
          ON selection.batch_id = item.batch_id
         AND selection.source_intake_id = item.source_intake_id
        WHERE item.batch_id = NEW.batch_id
          AND item.source_intake_id = NEW.source_intake_id
          AND item.story_id = NEW.story_id
          AND item.candidate_id = NEW.candidate_id
          AND item.workflow_state = 'READY_FOR_REVIEW'
          AND selection.candidate_id = NEW.candidate_id
          AND EXISTS (
              SELECT 1 FROM editorial_workflow_events AS event
              WHERE event.batch_id = item.batch_id
                AND event.source_intake_id = item.source_intake_id
                AND event.event_kind = 'INTAKE_SELECTED'
                AND event.detail = 'routine-generation:v1'
          )
    )
BEGIN
    SELECT RAISE(ABORT, 'publication authorization identity is incomplete or stale');
END;

CREATE TRIGGER story_publication_authorizations_no_update
BEFORE UPDATE ON story_automated_publication_authorizations
BEGIN
    SELECT RAISE(ABORT, 'automated publication authorizations are immutable');
END;

CREATE TRIGGER story_publication_authorizations_no_delete
BEFORE DELETE ON story_automated_publication_authorizations
BEGIN
    SELECT RAISE(ABORT, 'automated publication authorizations cannot be deleted');
END;

ALTER TABLE editorial_publication_attempts ADD COLUMN authorization_id TEXT
    REFERENCES story_automated_publication_authorizations(id) ON DELETE RESTRICT;

CREATE TRIGGER editorial_publication_attempt_authorization_required
BEFORE INSERT ON editorial_publication_attempts
WHEN NEW.authorization_id IS NULL
BEGIN
    SELECT RAISE(ABORT, 'per-story publication authorization is required');
END;

CREATE TRIGGER editorial_publication_attempt_authorization_guard
BEFORE UPDATE OF authorization_id ON editorial_publication_attempts
WHEN NEW.authorization_id IS NULL
 OR NOT (
    OLD.status = 'CLAIMED'
    AND OLD.lease_expires_at <= NEW.claimed_at
    AND NEW.claimed_at < NEW.lease_expires_at
 )
BEGIN
    SELECT RAISE(ABORT, 'publication authorization may change only during an expired claim recovery');
END;

PRAGMA optimize;
