PRAGMA foreign_keys = ON;

CREATE TABLE categories (
    id          TEXT PRIMARY KEY,
    slug        TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL UNIQUE,
    created_at  TEXT NOT NULL
);

CREATE TABLE stories (
    id                  TEXT PRIMARY KEY,
    slug                TEXT NOT NULL UNIQUE,
    headline            TEXT NOT NULL,
    deck                TEXT NOT NULL,
    body_markdown       TEXT NOT NULL,
    edition_date        TEXT NOT NULL,
    published_at        TEXT,
    category_id         TEXT NOT NULL,
    status              TEXT NOT NULL CHECK (
                            status IN (
                                'DRAFT',
                                'REVIEW',
                                'APPROVED',
                                'PUBLISHED',
                                'REJECTED',
                                'ARCHIVED'
                            )
                        ),
    social_excerpt      TEXT NOT NULL,
    og_image_key        TEXT,
    tags_json           TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags_json)),
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,

    FOREIGN KEY (category_id) REFERENCES categories(id),
    CHECK (status <> 'PUBLISHED' OR published_at IS NOT NULL)
);

CREATE TABLE sources (
    id              TEXT PRIMARY KEY,
    story_id        TEXT NOT NULL,
    title           TEXT NOT NULL,
    url             TEXT NOT NULL,
    publisher       TEXT,
    published_at    TEXT,
    created_at      TEXT NOT NULL,

    FOREIGN KEY (story_id) REFERENCES stories(id) ON DELETE CASCADE
);

CREATE INDEX idx_stories_published_order
ON stories(edition_date DESC, published_at DESC)
WHERE status = 'PUBLISHED';

CREATE INDEX idx_sources_story_id
ON sources(story_id);

PRAGMA optimize;
