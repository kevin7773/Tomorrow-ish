import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

describe('M3 architectural boundaries', () => {
	it('keeps model and generation modules outside publication authority', () => {
		for (const file of ['src/ai/model-provider.ts', 'src/ai/fake-model-provider.ts', 'src/ai/openai-model-provider.ts', 'src/ai/model-runner.ts', 'src/services/generation-service.ts', 'src/data/generation-repository.ts', 'src/data/d1-generation-repository.ts']) {
			const source = readFileSync(join(root, file), 'utf8');
			expect(source).not.toMatch(/publication-service|publishStory|publishApprovedStory/);
		}
	});

	it('gives providers no D1, repository, browser, or publication capability', () => {
		const provider = readFileSync(join(root, 'src/ai/model-provider.ts'), 'utf8');
		expect(provider).not.toMatch(/D1Database|Repository|\bpublish\b|browser|search|tool/i);
		const openai = readFileSync(join(root, 'src/ai/openai-model-provider.ts'), 'utf8');
		expect(openai).not.toMatch(/D1Database|Repository|StoryRepository|publication-service|publishStory|publishApprovedStory/);
		expect(openai).toContain('tools: []');
		expect(openai).toContain("tool_choice: 'none'");
		const repository = readFileSync(join(root, 'src/data/generation-repository.ts'), 'utf8');
		expect(repository).not.toMatch(/StoryRepository|publishStory|publishApprovedStory/);
	});

	it('keeps candidates without a PUBLISHED state and generated inserts fixed at DRAFT', () => {
		const domain = readFileSync(join(root, 'src/domain/editorial.ts'), 'utf8');
		const repository = readFileSync(join(root, 'src/data/d1-generation-repository.ts'), 'utf8');
		expect(domain).toContain("['DRAFT', 'REVIEW', 'APPROVED', 'REJECTED']");
		expect(repository).toContain("'DRAFT'");
		expect(repository).toContain("'MODEL'");
		expect(repository).not.toMatch(/status\s*=\s*['\"]PUBLISHED/);
	});

	it('preserves SENSITIVE as the only persisted caution value', () => {
		const migration = readFileSync(join(root, 'migrations/0003_governed_generation.sql'), 'utf8');
		expect(migration).toContain("'SENSITIVE'");
		expect(migration).not.toContain("'CAUTION'");
	});

	it('defines immutable versions, one accepted version, and assertion provenance', () => {
		const migration = readFileSync(join(root, 'migrations/0003_governed_generation.sql'), 'utf8');
		expect(migration).toContain('CREATE UNIQUE INDEX idx_normalized_event_accepted');
		expect(migration).toContain('CREATE TRIGGER normalized_event_versions_content_immutable');
		expect(migration).toContain('CREATE TABLE normalized_assertion_sources');
	});
});
