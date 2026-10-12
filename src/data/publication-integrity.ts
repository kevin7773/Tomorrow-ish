export const PUBLICATION_READINESS_SQL = `SELECT CASE
	WHEN story.status <> 'APPROVED' OR story.published_at IS NOT NULL THEN 'STORY_NOT_APPROVED'
	WHEN trim(story.headline) = '' OR trim(story.body_markdown) = '' THEN 'INVALID_CONTENT'
	WHEN NOT EXISTS (SELECT 1 FROM article_images AS image WHERE image.story_id = story.id) THEN 'IMAGE_REQUIRED'
	WHEN story.og_image_key IS NULL OR NOT EXISTS (
		SELECT 1 FROM article_images AS image
		WHERE image.story_id = story.id AND image.status = 'APPROVED'
		AND image.asset_key = story.og_image_key
	) THEN 'IMAGE_NOT_APPROVED'
	ELSE 'READY' END AS readiness
	FROM stories AS story WHERE story.id = ?`;

export const PUBLISHABLE_STORY_PREDICATE = `status = 'APPROVED' AND published_at IS NULL
	AND trim(headline) <> '' AND trim(body_markdown) <> '' AND og_image_key IS NOT NULL
	AND EXISTS (SELECT 1 FROM article_images AS image
		WHERE image.story_id = stories.id AND image.status = 'APPROVED'
		AND image.asset_key = stories.og_image_key)`;
