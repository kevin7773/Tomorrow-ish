export interface CronWindowRepository {
	claim(record: { key: string; cron: string; windowStartedAt: string; owner: string; at: string; leaseExpiresAt: string }): Promise<boolean>;
	complete(record: { key: string; owner: string; at: string; outcome: 'SUCCEEDED' | 'FAILED'; error?: string }): Promise<boolean>;
}

export function fiveMinuteWindow(cron: string, scheduledTime: number): { key: string; startedAt: string } {
	const value = new Date(scheduledTime);
	value.setUTCSeconds(0, 0);
	value.setUTCMinutes(value.getUTCMinutes() - (value.getUTCMinutes() % 5));
	const startedAt = value.toISOString();
	return { key: `${cron}:${startedAt}`, startedAt };
}

export async function runDeduplicatedCronWindow(
	repository: CronWindowRepository,
	record: { cron: string; scheduledTime: number; owner: string; at: string; leaseMs?: number },
	work: () => Promise<void>,
): Promise<'COMPLETED' | 'DUPLICATE'> {
	const window = fiveMinuteWindow(record.cron, record.scheduledTime);
	const leaseExpiresAt = new Date(new Date(record.at).getTime() + (record.leaseMs ?? 4 * 60 * 1_000)).toISOString();
	if (!(await repository.claim({ key: window.key, cron: record.cron, windowStartedAt: window.startedAt,
		owner: record.owner, at: record.at, leaseExpiresAt }))) return 'DUPLICATE';
	try {
		await work();
		await repository.complete({ key: window.key, owner: record.owner, at: new Date().toISOString(), outcome: 'SUCCEEDED' });
		return 'COMPLETED';
	} catch (error) {
		await repository.complete({ key: window.key, owner: record.owner, at: new Date().toISOString(), outcome: 'FAILED',
			error: error instanceof Error ? error.message.slice(0, 500) : 'UNKNOWN' });
		throw error;
	}
}
