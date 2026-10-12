PRAGMA foreign_keys = ON;

ALTER TABLE article_images ADD COLUMN attempt_key TEXT;
ALTER TABLE article_images ADD COLUMN attempt_state TEXT NOT NULL DEFAULT 'LEGACY'
    CHECK (attempt_state IN ('LEGACY', 'RESERVED', 'SUBMITTED', 'AMBIGUOUS', 'RESOLVED'));
ALTER TABLE article_images ADD COLUMN estimated_cost_microusd INTEGER
    CHECK (estimated_cost_microusd IS NULL OR estimated_cost_microusd > 0);
ALTER TABLE article_images ADD COLUMN pricing_basis_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(pricing_basis_json));
ALTER TABLE article_images ADD COLUMN provider_reported_usage_json TEXT
    CHECK (provider_reported_usage_json IS NULL OR json_valid(provider_reported_usage_json));
ALTER TABLE article_images ADD COLUMN verified_billed_cost_microusd INTEGER
    CHECK (verified_billed_cost_microusd IS NULL OR verified_billed_cost_microusd >= 0);
ALTER TABLE article_images ADD COLUMN uncertainty_classification TEXT;
ALTER TABLE article_images ADD COLUMN uncertainty_message TEXT;

CREATE UNIQUE INDEX idx_article_images_attempt_key
ON article_images(attempt_key)
WHERE attempt_key IS NOT NULL;

CREATE TRIGGER article_images_attempt_identity_immutable
BEFORE UPDATE ON article_images
WHEN NEW.attempt_key IS NOT OLD.attempt_key
  OR NEW.estimated_cost_microusd IS NOT OLD.estimated_cost_microusd
  OR NEW.pricing_basis_json <> OLD.pricing_basis_json
  OR (OLD.provider_reported_usage_json IS NOT NULL
      AND NEW.provider_reported_usage_json IS NOT OLD.provider_reported_usage_json)
  OR (OLD.verified_billed_cost_microusd IS NOT NULL
      AND NEW.verified_billed_cost_microusd IS NOT OLD.verified_billed_cost_microusd)
BEGIN
    SELECT RAISE(ABORT, 'article image attempt identity and cost provenance are immutable');
END;

CREATE TRIGGER article_images_attempt_state_guard
BEFORE UPDATE ON article_images
WHEN NEW.attempt_state <> OLD.attempt_state
 AND NOT (
     OLD.attempt_state = 'LEGACY' AND NEW.attempt_state IN ('SUBMITTED', 'AMBIGUOUS', 'RESOLVED')
     OR
     OLD.attempt_state = 'RESERVED' AND NEW.attempt_state IN ('SUBMITTED', 'AMBIGUOUS', 'RESOLVED')
     OR OLD.attempt_state = 'SUBMITTED' AND NEW.attempt_state IN ('AMBIGUOUS', 'RESOLVED')
     OR OLD.attempt_state = 'AMBIGUOUS' AND NEW.attempt_state = 'RESOLVED'
 )
BEGIN
    SELECT RAISE(ABORT, 'invalid article image attempt state transition');
END;

PRAGMA optimize;
