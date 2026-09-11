PRAGMA foreign_keys = ON;

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
        status = 'GENERATION_FAILED'
        OR (asset_key IS NOT NULL AND content_type LIKE 'image/%' AND byte_size > 0 AND generated_at IS NOT NULL)
    ),
    CHECK (status <> 'APPROVED' OR (alt_text IS NOT NULL AND length(trim(alt_text)) > 0)),
    CHECK (
        status <> 'GENERATION_FAILED'
        OR (asset_key IS NULL AND generated_at IS NULL AND error_classification IS NOT NULL)
    )
);

CREATE INDEX idx_article_images_story_history
ON article_images(story_id, requested_at DESC);

CREATE INDEX idx_article_images_provider_request
ON article_images(provider, provider_request_id)
WHERE provider_request_id IS NOT NULL;

CREATE TRIGGER article_images_provenance_immutable
BEFORE UPDATE ON article_images
WHEN NEW.story_id <> OLD.story_id
  OR NEW.provider <> OLD.provider
  OR NEW.model <> OLD.model
  OR NEW.prompt <> OLD.prompt
  OR NEW.prompt_version <> OLD.prompt_version
  OR NEW.aspect_ratio <> OLD.aspect_ratio
  OR NEW.provider_request_id IS NOT OLD.provider_request_id
  OR NEW.asset_key IS NOT OLD.asset_key
  OR NEW.content_type IS NOT OLD.content_type
  OR NEW.byte_size IS NOT OLD.byte_size
  OR NEW.metadata_json <> OLD.metadata_json
  OR NEW.error_classification IS NOT OLD.error_classification
  OR NEW.error_message IS NOT OLD.error_message
  OR NEW.requested_by_email <> OLD.requested_by_email
  OR NEW.requested_at <> OLD.requested_at
  OR NEW.generated_at IS NOT OLD.generated_at
BEGIN
    SELECT RAISE(ABORT, 'article image generation provenance is immutable');
END;

CREATE TRIGGER article_images_no_delete
BEFORE DELETE ON article_images
BEGIN
    SELECT RAISE(ABORT, 'article image history cannot be deleted');
END;

PRAGMA optimize;
