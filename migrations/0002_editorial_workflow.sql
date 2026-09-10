PRAGMA foreign_keys = ON;

CREATE TABLE source_intakes (
    id                         TEXT PRIMARY KEY,
    title                      TEXT NOT NULL,
    neutral_brief              TEXT NOT NULL,
    significance_score         INTEGER NOT NULL CHECK (significance_score BETWEEN 1 AND 5),
    satire_potential_score     INTEGER NOT NULL CHECK (satire_potential_score BETWEEN 1 AND 5),
    satire_suitability         TEXT NOT NULL CHECK (
                                    satire_suitability IN (
                                        'UNREVIEWED',
                                        'SUITABLE',
                                        'SENSITIVE',
                                        'UNSUITABLE'
                                    )
                                ),
    editorial_notes            TEXT NOT NULL DEFAULT '',
    created_by_email           TEXT NOT NULL,
    updated_by_email           TEXT NOT NULL,
    created_at                 TEXT NOT NULL,
    updated_at                 TEXT NOT NULL
);

CREATE TABLE source_references (
    id                  TEXT PRIMARY KEY,
    source_intake_id    TEXT NOT NULL,
    source_title        TEXT NOT NULL,
    source_url          TEXT NOT NULL,
    publisher_name      TEXT NOT NULL,
    source_tier         TEXT NOT NULL CHECK (
                            source_tier IN ('TIER_1', 'TIER_2', 'CONTEXT_ONLY')
                        ),
    source_type         TEXT NOT NULL CHECK (
                            source_type IN (
                                'PRIMARY',
                                'WIRE',
                                'STRAIGHT_NEWS',
                                'LOCAL_NEWS',
                                'TRADE',
                                'PRESS_RELEASE',
                                'SOCIAL_CONTEXT',
                                'COMMUNITY_CONTEXT',
                                'OTHER'
                            )
                        ),
    published_at        TEXT,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,

    FOREIGN KEY (source_intake_id) REFERENCES source_intakes(id) ON DELETE RESTRICT,
    CHECK (
        source_type NOT IN ('SOCIAL_CONTEXT', 'COMMUNITY_CONTEXT')
        OR source_tier = 'CONTEXT_ONLY'
    )
);

CREATE TABLE satire_candidates (
    id                      TEXT PRIMARY KEY,
    source_intake_id        TEXT NOT NULL,
    proposed_headline       TEXT NOT NULL,
    proposed_deck           TEXT NOT NULL,
    draft_body_markdown     TEXT NOT NULL,
    category_id             TEXT NOT NULL,
    editorial_notes         TEXT NOT NULL DEFAULT '',
    status                  TEXT NOT NULL CHECK (
                                status IN ('DRAFT', 'REVIEW', 'APPROVED', 'REJECTED')
                            ),
    created_by_email        TEXT NOT NULL,
    updated_by_email        TEXT NOT NULL,
    created_at              TEXT NOT NULL,
    updated_at              TEXT NOT NULL,

    FOREIGN KEY (source_intake_id) REFERENCES source_intakes(id) ON DELETE RESTRICT,
    FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE RESTRICT
);

CREATE TABLE editorial_audit_log (
    id              TEXT PRIMARY KEY,
    actor_email     TEXT NOT NULL,
    entity_type     TEXT NOT NULL CHECK (
                        entity_type IN (
                            'SOURCE_INTAKE',
                            'SOURCE_REFERENCE',
                            'SATIRE_CANDIDATE',
                            'STORY'
                        )
                    ),
    entity_id       TEXT NOT NULL,
    action          TEXT NOT NULL,
    from_status     TEXT,
    to_status       TEXT,
    created_at      TEXT NOT NULL
);

CREATE TRIGGER editorial_audit_log_no_update
BEFORE UPDATE ON editorial_audit_log
BEGIN
    SELECT RAISE(ABORT, 'editorial audit records are append-only');
END;

CREATE TRIGGER editorial_audit_log_no_delete
BEFORE DELETE ON editorial_audit_log
BEGIN
    SELECT RAISE(ABORT, 'editorial audit records are append-only');
END;

ALTER TABLE stories
ADD COLUMN origin_candidate_id TEXT REFERENCES satire_candidates(id) DEFAULT NULL;

CREATE INDEX idx_source_intakes_updated_at
ON source_intakes(updated_at DESC);

CREATE INDEX idx_source_references_intake_id
ON source_references(source_intake_id, created_at);

CREATE INDEX idx_satire_candidates_status_updated_at
ON satire_candidates(status, updated_at DESC);

CREATE INDEX idx_satire_candidates_intake_id
ON satire_candidates(source_intake_id, created_at DESC);

CREATE INDEX idx_stories_editorial_status_updated_at
ON stories(status, updated_at DESC);

CREATE UNIQUE INDEX idx_stories_origin_candidate_id
ON stories(origin_candidate_id)
WHERE origin_candidate_id IS NOT NULL;

CREATE INDEX idx_editorial_audit_entity
ON editorial_audit_log(entity_type, entity_id, created_at DESC);

PRAGMA optimize;
