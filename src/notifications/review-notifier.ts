import type { ReviewReminderKind } from '../domain/editorial-review-reminder';
import type { EditorialReminderStage } from '../domain/editorial-review-reminder';
import type { ReviewNotificationReceiverService } from '../services/review-notification-receiver-service';
import { InvalidReviewNotification, validateReviewNotification } from './review-notification-validation';

export interface ReviewNotification {
	batchId: string;
	stage: EditorialReminderStage;
	kind: ReviewReminderKind;
	message: string;
	reviewUrl: string | null;
	idempotencyKey: string;
}

export interface ReviewNotifier {
	send(notification: ReviewNotification): Promise<void>;
}

export class ReviewNotificationError extends Error {
	constructor(readonly classification: 'NOT_CONFIGURED' | 'NETWORK' | 'REJECTED') {
		super(`Review notification failed: ${classification}`);
	}
}

export class WebhookReviewNotifier implements ReviewNotifier {
	constructor(private readonly webhookUrl: string, private readonly fetcher: typeof fetch = fetch) {}

	async send(notification: ReviewNotification): Promise<void> {
		if (!this.webhookUrl.trim()) throw new ReviewNotificationError('NOT_CONFIGURED');
		let response: Response;
		try {
			response = await this.fetcher(this.webhookUrl, {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'idempotency-key': notification.idempotencyKey },
				body: JSON.stringify({
					text: notification.message, reviewUrl: notification.reviewUrl,
					batchId: notification.batchId, reminderStage: notification.stage,
					reminderKind: notification.kind,
				}),
			});
		} catch {
			throw new ReviewNotificationError('NETWORK');
		}
		if (!response.ok) throw new ReviewNotificationError('REJECTED');
	}
}

export class InternalReviewNotifier implements ReviewNotifier {
	constructor(
		private readonly receiver: Pick<ReviewNotificationReceiverService, 'receive'>,
		private readonly expectedOrigin: string,
	) {}

	async send(notification: ReviewNotification): Promise<void> {
		let validated;
		try {
			validated = validateReviewNotification({
				text: notification.message,
				reviewUrl: notification.reviewUrl,
				batchId: notification.batchId,
				reminderStage: notification.stage,
				reminderKind: notification.kind,
			}, notification.idempotencyKey, this.expectedOrigin);
		} catch (error) {
			if (error instanceof InvalidReviewNotification) throw new ReviewNotificationError('REJECTED');
			throw error;
		}
		const result = await this.receiver.receive(validated);
		if (result !== 'accepted' && result !== 'duplicate') throw new ReviewNotificationError('REJECTED');
	}
}
