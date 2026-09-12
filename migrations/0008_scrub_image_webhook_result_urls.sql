PRAGMA foreign_keys = OFF;

ALTER TABLE article_image_webhook_inbox RENAME TO article_image_webhook_inbox_legacy;

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
    CHECK (
        outcome <> 'SUCCESS'
        OR (
            error_classification IS NULL
            AND (
                (processing_state IN ('RECEIVED', 'PROCESSING') AND result_url IS NOT NULL)
                OR (processing_state = 'PROCESSED' AND result_url IS NULL)
            )
        )
    ),
    CHECK (outcome <> 'FAILURE' OR (result_url IS NULL AND error_classification IS NOT NULL))
);

INSERT INTO article_image_webhook_inbox (
    image_id, provider_request_id, outcome, result_url, metadata_json,
    error_classification, error_message, received_at, processing_state
)
SELECT
    image_id, provider_request_id, outcome,
    CASE WHEN processing_state = 'PROCESSED' THEN NULL ELSE result_url END,
    metadata_json, error_classification, error_message, received_at, processing_state
FROM article_image_webhook_inbox_legacy;

DROP TABLE article_image_webhook_inbox_legacy;

PRAGMA foreign_keys = ON;
PRAGMA optimize;
