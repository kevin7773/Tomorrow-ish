PRAGMA foreign_keys = OFF;

DROP TRIGGER IF EXISTS article_images_provenance_immutable;
DROP TRIGGER IF EXISTS article_images_no_delete;
DROP INDEX IF EXISTS idx_article_images_story_history;
DROP INDEX IF EXISTS idx_article_images_provider_request;

ALTER TABLE article_images RENAME TO article_images_legacy;

CREATE TABLE article_images (
    id                       TEXT PRIMARY KEY,
    story_id                 TEXT NOT NULL,
    provider                 TEXT NOT NULL,
    model                    TEXT NOT NULL,
    prompt                   TEXT NOT NULL,
    prompt_version           TEXT NOT NULL,
    aspect_ratio             TEXT NOT NULL,
    provider_request_id      TEXT,
    asset_key                TEXT UNIQUE,
    content_type             TEXT,
    byte_size                INTEGER CHECK (byte_size IS NULL OR byte_size > 0),
    status                   TEXT NOT NULL CHECK (
                                 status IN (
                                     'PENDING',
                                     'GENERATED',
                                     'APPROVED',
                                     'REJECTED',
                                     'REGENERATE_REQUESTED',
                                     'GENERATION_FAILED'
                                 )
                             ),
    alt_text                 TEXT,
    metadata_json            TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
    error_classification     TEXT,
    error_message            TEXT,
    requested_by_email       TEXT NOT NULL,
    requested_at             TEXT NOT NULL,
    generated_at             TEXT,
    reviewed_by_email        TEXT,
    reviewed_at              TEXT,

    FOREIGN KEY (story_id) REFERENCES stories(id) ON DELETE RESTRICT,
    CHECK (
        status IN ('PENDING', 'GENERATION_FAILED')
        OR (asset_key IS NOT NULL AND content_type LIKE 'image/%' AND byte_size > 0 AND generated_at IS NOT NULL)
    ),
    CHECK (status <> 'APPROVED' OR (alt_text IS NOT NULL AND length(trim(alt_text)) > 0)),
    CHECK (
        status <> 'PENDING'
        OR (
            asset_key IS NULL AND content_type IS NULL AND byte_size IS NULL
            AND generated_at IS NULL AND error_classification IS NULL AND error_message IS NULL
        )
    ),
    CHECK (
        status <> 'GENERATION_FAILED'
        OR (asset_key IS NULL AND generated_at IS NULL AND error_classification IS NOT NULL)
    )
);

INSERT INTO article_images (
    id, story_id, provider, model, prompt, prompt_version, aspect_ratio,
    provider_request_id, asset_key, content_type, byte_size, status, alt_text,
    metadata_json, error_classification, error_message, requested_by_email,
    requested_at, generated_at, reviewed_by_email, reviewed_at
)
SELECT
    id, story_id, provider, model, prompt, prompt_version, aspect_ratio,
    provider_request_id, asset_key, content_type, byte_size, status, alt_text,
    metadata_json, error_classification, error_message, requested_by_email,
    requested_at, generated_at, reviewed_by_email, reviewed_at
FROM article_images_legacy;

DROP TABLE article_images_legacy;

CREATE INDEX idx_article_images_story_history
ON article_images(story_id, requested_at DESC);

CREATE UNIQUE INDEX idx_article_images_provider_request
ON article_images(provider, provider_request_id)
WHERE provider_request_id IS NOT NULL;

CREATE UNIQUE INDEX idx_article_images_one_pending_per_story
ON article_images(story_id)
WHERE status = 'PENDING';

CREATE TABLE article_image_webhook_inbox (
    image_id                    TEXT PRIMARY KEY,
    provider_request_id        TEXT NOT NULL UNIQUE,
    outcome                    TEXT NOT NULL CHECK (outcome IN ('SUCCESS', 'FAILURE')),
    result_url                 TEXT,
    metadata_json              TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
    error_classification       TEXT,
    error_message              TEXT,
    received_at                TEXT NOT NULL,
    processing_state           TEXT NOT NULL DEFAULT 'RECEIVED'
                               CHECK (processing_state IN ('RECEIVED', 'PROCESSING', 'PROCESSED')),

    FOREIGN KEY (image_id) REFERENCES article_images(id) ON DELETE RESTRICT,
    CHECK (outcome <> 'SUCCESS' OR (result_url IS NOT NULL AND error_classification IS NULL)),
    CHECK (outcome <> 'FAILURE' OR (result_url IS NULL AND error_classification IS NOT NULL))
);

CREATE TRIGGER article_images_provenance_immutable
BEFORE UPDATE ON article_images
WHEN NEW.story_id <> OLD.story_id
  OR NEW.provider <> OLD.provider
  OR NEW.model <> OLD.model
  OR NEW.prompt <> OLD.prompt
  OR NEW.prompt_version <> OLD.prompt_version
  OR NEW.aspect_ratio <> OLD.aspect_ratio
  OR NEW.requested_by_email <> OLD.requested_by_email
  OR NEW.requested_at <> OLD.requested_at
  OR (OLD.provider_request_id IS NOT NULL AND NEW.provider_request_id IS NOT OLD.provider_request_id)
  OR (OLD.status <> 'PENDING' AND NEW.provider_request_id IS NOT OLD.provider_request_id)
  OR (
      (
          NEW.asset_key IS NOT OLD.asset_key
          OR NEW.content_type IS NOT OLD.content_type
          OR NEW.byte_size IS NOT OLD.byte_size
          OR NEW.generated_at IS NOT OLD.generated_at
      )
      AND NOT (
          OLD.status = 'PENDING' AND NEW.status = 'GENERATED'
          AND OLD.asset_key IS NULL AND OLD.content_type IS NULL
          AND OLD.byte_size IS NULL AND OLD.generated_at IS NULL
      )
  )
  OR (
      (
          NEW.metadata_json <> OLD.metadata_json
          OR NEW.error_classification IS NOT OLD.error_classification
          OR NEW.error_message IS NOT OLD.error_message
      )
      AND NOT (OLD.status = 'PENDING' AND NEW.status IN ('PENDING', 'GENERATED', 'GENERATION_FAILED'))
  )
BEGIN
    SELECT RAISE(ABORT, 'article image generation provenance is immutable');
END;

CREATE TRIGGER article_images_status_transition_guard
BEFORE UPDATE ON article_images
WHEN NEW.status <> OLD.status
 AND NOT (
     (OLD.status = 'PENDING' AND NEW.status IN ('GENERATED', 'GENERATION_FAILED'))
     OR (OLD.status = 'GENERATED' AND NEW.status IN ('APPROVED', 'REJECTED', 'REGENERATE_REQUESTED'))
     OR (OLD.status = 'REJECTED' AND NEW.status = 'REGENERATE_REQUESTED')
 )
BEGIN
    SELECT RAISE(ABORT, 'invalid article image status transition');
END;

CREATE TRIGGER article_images_no_delete
BEFORE DELETE ON article_images
BEGIN
    SELECT RAISE(ABORT, 'article image history cannot be deleted');
END;

PRAGMA foreign_keys = ON;
PRAGMA optimize;
