import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

const migrationDirectory = join(process.cwd(), 'migrations');
const migrationName = '0023_governed_editorial_automation.sql';
const migration = readFileSync(join(migrationDirectory, migrationName), 'utf8');
const NOW = '2026-10-13T12:00:00.000Z';

describe('migration 0023 governed editorial automation', () => {
	it('is additive and seeds no images, authorities, approvals, or publication attempts', () => {
		expect(migration).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\s+(?:OR\s+\w+\s+)?(?:INTO|FROM|stories|article_images)\b/i);
		expect(migration).toContain('CREATE TABLE story_automated_publication_authorizations');
		expect(migration).toContain('idx_article_images_one_routine_attempt_per_story');
	});

	it('upgrades a populated 0022 schema without changing historical image or audit identity', () => {
		const sqlite = new DatabaseSync(':memory:');
		for (const filename of readdirSync(migrationDirectory)
			.filter((name) => /^\d+.*\.sql$/.test(name) && name < migrationName).sort()) {
			sqlite.exec(readFileSync(join(migrationDirectory, filename), 'utf8'));
		}
		sqlite.exec(`INSERT INTO categories (id,slug,name,created_at) VALUES ('cat','cat','Category','${NOW}');
			INSERT INTO stories (id,slug,headline,deck,body_markdown,edition_date,category_id,status,social_excerpt,created_at,updated_at)
			VALUES ('historical-story','historical-story','Headline','Deck','Body','2026-10-13','cat','REVIEW','Excerpt','${NOW}','${NOW}');
			INSERT INTO article_images (id,story_id,provider,model,prompt,prompt_version,aspect_ratio,status,metadata_json,
				error_classification,error_message,requested_by_email,requested_at)
			VALUES ('historical-image','historical-story','provider','model','prompt','v1','3:2','GENERATION_FAILED','{}',
				'HISTORICAL_FAILURE','Historical failure.','editor@test','${NOW}');
			INSERT INTO editorial_audit_log (id,actor_email,entity_type,entity_id,action,reason,created_at)
			VALUES ('historical-audit','editor@test','STORY','historical-story','IMAGE_GENERATION_FAILED','historical','${NOW}');`);
		sqlite.exec(migration);
		expect(sqlite.prepare(`SELECT id,visual_direction,workflow_batch_id,workflow_intake_id,
			budget_operating_date,automation_scope FROM article_images WHERE id='historical-image'`).get()).toEqual({
			id: 'historical-image', visual_direction: null, workflow_batch_id: null,
			workflow_intake_id: null, budget_operating_date: null, automation_scope: null,
		});
		expect(sqlite.prepare("SELECT id,reason FROM editorial_audit_log WHERE id='historical-audit'").get())
			.toEqual({ id: 'historical-audit', reason: 'historical' });
		expect(sqlite.prepare('SELECT COUNT(*) AS count FROM story_automated_publication_authorizations').get())
			.toEqual({ count: 0 });
		sqlite.close();
	});
});
