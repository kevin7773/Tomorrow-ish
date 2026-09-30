import type { EditorialReminderStage, ReviewReminderKind } from './editorial-review-reminder';

export interface IncomingReviewNotification {
	idempotencyKey: string;
	batchId: string;
	stage: EditorialReminderStage;
	kind: ReviewReminderKind;
	message: string;
	reviewUrl: string | null;
}

export interface EditorialNotification extends IncomingReviewNotification {
	createdAt: string;
}

export type ReviewNotificationReceiptState = 'PROCESSING' | 'DELIVERED' | 'FAILED';

export interface ReviewNotificationReceipt extends IncomingReviewNotification {
	status: ReviewNotificationReceiptState;
	attemptCount: number;
	failureClassification: string | null;
	receivedAt: string;
	lastAttemptAt: string;
	deliveredAt: string | null;
}
