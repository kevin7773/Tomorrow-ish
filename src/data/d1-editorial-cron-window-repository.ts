import type { CronWindowRepository } from '../services/editorial-cron-window';

export class D1EditorialCronWindowRepository implements CronWindowRepository {
	constructor(private readonly db: D1Database) {}

	async claim(record: { key: string; cron: string; windowStartedAt: string; owner: string; at: string; leaseExpiresAt: string }): Promise<boolean> {
		const inserted = await this.db.prepare(`INSERT OR IGNORE INTO editorial_cron_windows
			(window_key, cron, window_started_at, owner, claimed_at, lease_expires_at, outcome)
			VALUES (?, ?, ?, ?, ?, ?, 'RUNNING')`).bind(record.key, record.cron, record.windowStartedAt,
			record.owner, record.at, record.leaseExpiresAt).run();
		if (inserted.meta.changes === 1) return true;
		const recovered = await this.db.prepare(`UPDATE editorial_cron_windows SET owner = ?, claimed_at = ?,
			lease_expires_at = ?, attempt_count = attempt_count + 1, last_error = NULL
			WHERE window_key = ? AND outcome = 'RUNNING' AND lease_expires_at <= ?`)
			.bind(record.owner, record.at, record.leaseExpiresAt, record.key, record.at).run();
		return recovered.meta.changes === 1;
	}

	async complete(record: { key: string; owner: string; at: string; outcome: 'SUCCEEDED' | 'FAILED'; error?: string }): Promise<boolean> {
		const result = await this.db.prepare(`UPDATE editorial_cron_windows SET outcome = ?, completed_at = ?,
			last_error = ? WHERE window_key = ? AND owner = ? AND outcome = 'RUNNING'`)
			.bind(record.outcome, record.at, record.error ?? null, record.key, record.owner).run();
		return result.meta.changes === 1;
	}
}
