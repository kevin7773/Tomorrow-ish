import type {
	EditorialNotificationDeliveryPort,
	ReviewNotificationReceiptRepository,
} from '../data/review-notification-repository';
import type { IncomingReviewNotification } from '../domain/review-notification-delivery';

export type ReviewNotificationReceiveResult =
	| 'accepted'
	| 'duplicate'
	| 'processing'
	| 'unauthorized'
	| 'conflict'
	| 'delivery-failed';

export class ReviewNotificationReceiverService {
	constructor(
		private readonly receipts: ReviewNotificationReceiptRepository,
		private readonly delivery: EditorialNotificationDeliveryPort,
		private readonly now: () => string = () => new Date().toISOString(),
	) {}

	async receive(notification: IncomingReviewNotification): Promise<ReviewNotificationReceiveResult> {
		const receivedAt = this.now();
		const beginning = await this.receipts.begin(notification, receivedAt);
		if (beginning !== 'accepted') return beginning;
		try {
			await this.delivery.deliver(notification, receivedAt);
			if (!(await this.receipts.markDelivered(notification.idempotencyKey, receivedAt))) {
				throw new Error('DELIVERY_COMPLETION_FAILED');
			}
			return 'accepted';
		} catch (error) {
			await this.receipts.markFailed(notification.idempotencyKey, receivedAt, 'INTERNAL_INBOX_WRITE_FAILED');
			console.error('[review-notification-receiver] delivery failed', {
				idempotencyKey: notification.idempotencyKey,
				exceptionName: error instanceof Error ? error.name : 'UnknownError',
			});
			return 'delivery-failed';
		}
	}
}
