import type { ClaimedReviewReminder, ReviewReminderBatch, ReviewReminderKind } from '../domain/editorial-review-reminder';

export interface ReviewReminderRepository {
	listUnresolved(limit: number): Promise<ReviewReminderBatch[]>;
	countPending(batchId: string, stage: ReviewReminderBatch['stage']): Promise<number>;
	resolve(batchId: string, stage: ReviewReminderBatch['stage'], resolvedAt: string, eventId: string): Promise<boolean>;
	claim(batchId: string, stage: ReviewReminderBatch['stage'], kind: ReviewReminderKind, claimToken: string, claimedAt: string, staleBefore: string): Promise<ClaimedReviewReminder | null>;
	complete(claim: ClaimedReviewReminder, sentAt: string, eventId: string): Promise<boolean>;
	releaseFailed(claim: ClaimedReviewReminder, failedAt: string, eventId: string, classification: string): Promise<void>;
}
