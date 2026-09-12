import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

describe('automation architecture boundaries', () => {
	it('contains no publication or ad authority', () => {
		for (const path of [
			'src/automation/automation-service.ts',
			'src/automation/runtime-automation.ts',
			'src/worker.ts',
		]) {
			const source = read(path);
			expect(source, path).not.toMatch(/publishStory|publishApprovedStory|AdSense|ADS_ENABLED/);
		}
	});

	it('keeps the production cron trigger explicitly disabled', () => {
		const config = read('wrangler.jsonc');
		expect(config).toMatch(/"AUTOMATION_ENABLED": "false"/);
		expect(config).toMatch(/"crons": \[\]/);
	});

	it('uses the existing DRAFT-only candidate generation service', () => {
		const runtime = read('src/automation/runtime-automation.ts');
		expect(runtime).toContain('new GenerationService');
		expect(runtime).toContain('service.generateCandidates');
	});

	it('defines additive run and item observability without story status changes', () => {
		const migration = read('migrations/0012_governed_intake_automation.sql');
		expect(migration).toContain('CREATE TABLE automation_sources');
		expect(migration).toContain('CREATE TABLE automation_runs');
		expect(migration).toContain('CREATE TABLE automation_run_items');
		expect(migration).not.toMatch(/UPDATE stories|INSERT INTO stories/);
	});
});
