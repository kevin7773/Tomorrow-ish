PRAGMA foreign_keys = ON;

INSERT INTO sources (id, story_id, title, url, publisher, published_at, created_at)
SELECT
    candidate.id || ':' || reference.id,
    story.id,
    reference.source_title,
    reference.source_url,
    reference.publisher_name,
    reference.published_at,
    story.created_at
FROM stories AS story
JOIN satire_candidates AS candidate ON candidate.id = story.origin_candidate_id
JOIN source_references AS reference
    ON reference.source_intake_id = candidate.source_intake_id
WHERE NOT EXISTS (
    SELECT 1
    FROM sources AS existing
    WHERE existing.id = candidate.id || ':' || reference.id
);

PRAGMA optimize;
