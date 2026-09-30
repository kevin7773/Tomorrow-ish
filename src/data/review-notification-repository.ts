import type { EditorialNotification, IncomingReviewNotification, ReviewNotificationReceipt } from '../domain/review-notification-delivery';

export type BeginReviewNotificationResult = 'accepted' | 'duplicate' | 'processing' | 'unauthorized' | 'conflict';

export interface ReviewNotificationReceiptRepository {
	begin(notification: IncomingReviewNotification, receivedAt: string): Promise<BeginReviewNotificationResult>;
	markDelivered(idempotencyKey: string, deliveredAt: string): Promise<boolean>;
	markFailed(idempotencyKey: string, failedAt: string, classification: string): Promise<void>;
	find(idempotencyKey: string): Promise<ReviewNotificationReceipt | null>;
	listDelivered(limit?: number): Promise<EditorialNotification[]>;
}

export interface EditorialNotificationDeliveryPort {
	deliver(notification: IncomingReviewNotification, deliveredAt: string): Promise<void>;
}
