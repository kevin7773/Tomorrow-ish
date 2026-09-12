DELETE FROM sources
WHERE id = 'source-moon-sample'
  AND story_id = 'story-moon-meeting'
  AND title = 'Reserved example link — fictional seed content'
  AND url = 'https://example.com/'
  AND publisher = 'IANA Example Domain';

PRAGMA optimize;
