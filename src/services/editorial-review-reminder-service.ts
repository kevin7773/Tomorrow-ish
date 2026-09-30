import type { ReviewReminderRepository } from '../data/editorial-review-reminder-repository';
import type { ReviewReminderBatch, ReviewReminderKind } from '../domain/editorial-review-reminder';
import { ReviewNotificationError, type ReviewNotifier } from '../notifications/review-notifier';

const SIX_HOURS_MS = 6 * 60 * 60 * 1_000;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1_000;
const CLAIM_LEASE_MS = 10 * 60 * 1_000;

function message(stage: ReviewReminderBatch['stage'], kind: ReviewReminderKind, count: number): string {
	const subject = stage === 'TRIAGE'
		? `${count} new intake${count === 1 ? '' : 's'} ready for editorial triage`
		: `${count} finished ${count === 1 ? 'story is' : 'stories are'} ready for final editorial review`;
	if (kind === 'INITIAL') return `📰 Tomorrow-ish has ${subject}.`;
	if (kind === 'SIX_HOUR') return `📰 Reminder: Tomorrow-ish has ${subject}.`;
	return `📰 Final reminder: Tomorrow-ish has ${subject}.`;
}

function dueKind(batch: ReviewReminderBatch, nowMs: number): ReviewReminderKind | null {
	if (!batch.initialSentAt) return 'INITIAL';
	const initialMs = Date.parse(batch.initialSentAt);
	if (!batch.sixHourSentAt && nowMs - initialMs >= SIX_HOURS_MS) return 'SIX_HOUR';
	if (!batch.finalSentAt && nowMs - initialMs >= TWENTY_FOUR_HOURS_MS) return 'FINAL';
	return null;
}

export interface ReviewReminderReport {
	resolved: number;
	sent: number;
	failed: number;
}

export class EditorialReviewReminderService {
	private readonly now: () => Date;
	private readonly createId: () => string;

	constructor(
		private readonly repository: ReviewReminderRepository,
		private readonly notifier: ReviewNotifier,
		private readonly reviewUrl: string | null,
		dependencies: { now?: () => Date; createId?: () => string } = {},
	) {
		this.now = dependencies.now ?? (() => new Date());
		this.createId = dependencies.createId ?? (() => crypto.randomUUID());
	}

	async process(limit = 100): Promise<ReviewReminderReport> {
		const report = { resolved: 0, sent: 0, failed: 0 };
		const now = this.now();
		const nowIso = now.toISOString();
		for (const batch of await this.repository.listUnresolved(limit)) {
			const pendingCount = await this.repository.countPending(batch.batchId, batch.stage);
			if (pendingCount === 0) {
				if (await this.repository.resolve(batch.batchId, batch.stage, nowIso, this.createId())) {
					report.resolved += 1;
					console.log('[editorial-review-reminder] phase resolved', { batchId: batch.batchId, stage: batch.stage });
				}
				continue;
			}
			const kind = dueKind(batch, now.getTime());
			if (!kind) continue;
			const claim = await this.repository.claim(
				batch.batchId, batch.stage, kind, this.createId(), nowIso,
				new Date(now.getTime() - CLAIM_LEASE_MS).toISOString(),
			);
			if (!claim) continue;
			if (await this.repository.countPending(batch.batchId, batch.stage) === 0) {
				if (await this.repository.resolve(batch.batchId, batch.stage, nowIso, this.createId())) {
					report.resolved += 1;
					console.log('[editorial-review-reminder] phase resolved', { batchId: batch.batchId, stage: batch.stage });
				}
				continue;
			}
			try {
				const reviewUrl = this.reviewUrl
					? `${this.reviewUrl.replace(/\/$/, '')}/${encodeURIComponent(batch.batchId)}/${batch.stage === 'TRIAGE' ? 'triage' : 'review'}`
					: null;
				await this.notifier.send({
					batchId: batch.batchId, stage: batch.stage, kind,
					message: message(batch.stage, kind, pendingCount), reviewUrl,
					idempotencyKey: `editorial-review:${batch.batchId}:${batch.stage}:${kind}`,
				});
				if (await this.repository.complete(claim, nowIso, this.createId())) {
					report.sent += 1;
					console.log('[editorial-review-reminder] reminder sent', { batchId: batch.batchId, kind });
				}
			} catch (error) {
				const classification = error instanceof ReviewNotificationError ? error.classification : 'UNKNOWN';
				await this.repository.releaseFailed(claim, nowIso, this.createId(), classification);
				report.failed += 1;
				console.error('[editorial-review-reminder] notification send failed', { batchId: batch.batchId, kind, classification });
			}
		}
		return report;
	}
}
