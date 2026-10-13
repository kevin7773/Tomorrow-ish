import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

const migrationDirectory = join(process.cwd(), 'migrations');
const migrationNames = readdirSync(migrationDirectory)
	.filter((name) => /^\d+.*\.sql$/.test(name))
	.sort();

function hasRemoteUnsafeTriggerCase(sql: string): boolean {
	return /\bSELECT\s+CASE\b/i.test(sql);
}

describe('D1 remote migration compatibility', () => {
	it('keeps migration SQL LF-only for D1 remote trigger parsing', () => {
		for (const name of migrationNames) {
			const sql = readFileSync(join(migrationDirectory, name), 'utf8');
			expect(sql, name).not.toContain('\r');
		}
	});

	it('parenthesizes CASE expressions used as trigger SELECT statements', () => {
		const unsafe = `CREATE TRIGGER example AFTER INSERT ON items BEGIN
			SELECT CASE WHEN changes() <> 1 THEN RAISE(ABORT, 'invalid') END;
		END;`;
		const compatible = unsafe.replace('SELECT CASE', 'SELECT (CASE').replace(' END;', ' END);');
		expect(hasRemoteUnsafeTriggerCase(unsafe)).toBe(true);
		expect(hasRemoteUnsafeTriggerCase(compatible)).toBe(false);

		for (const name of migrationNames) {
			const sql = readFileSync(join(migrationDirectory, name), 'utf8');
			expect(hasRemoteUnsafeTriggerCase(sql), name).toBe(false);
		}
	});

	it('replays the complete schema with integrity and foreign keys intact', () => {
		const sqlite = new DatabaseSync(':memory:');
		for (const name of migrationNames) {
			sqlite.exec(readFileSync(join(migrationDirectory, name), 'utf8'));
		}
		expect(sqlite.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
		expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
		expect(sqlite.prepare(`SELECT name FROM sqlite_schema
			WHERE type = 'trigger' AND name IN (
				'governed_automated_story_publication',
				'apply_external_review_notification_reconciliation'
			) ORDER BY name`).all()).toEqual([
			{ name: 'apply_external_review_notification_reconciliation' },
			{ name: 'governed_automated_story_publication' },
		]);
		sqlite.close();
	});
});
