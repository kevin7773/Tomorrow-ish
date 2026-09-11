PRAGMA foreign_keys = ON;

INSERT OR IGNORE INTO categories (id, slug, name, created_at) VALUES
    ('cat-sports', 'sports', 'Sports', '2026-09-11T17:00:00Z'),
    ('cat-weather', 'weather', 'Weather', '2026-09-11T17:00:00Z'),
    ('cat-community', 'community', 'Community', '2026-09-11T17:00:00Z');

PRAGMA optimize;
