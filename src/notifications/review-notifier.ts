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
	constructor(
		readonly classification: 'NOT_CONFIGURED' | 'NETWORK' | 'REJECTED' | 'PENDING' | 'AMBIGUOUS' | 'CONFLICT',
		readonly responseStatus: number | null = null,
		readonly requestId: string | null = null,
	) {
		super(`Review notification failed: ${classification}`);
	}
}

export interface ReviewNotificationTransportResult {
	status: number;
	requestId: string | null;
	deliveryState: 'PENDING' | 'DELIVERED' | 'AMBIGUOUS';
}

export interface ReviewNotificationTransport {
	send(notification: ReviewNotification): Promise<ReviewNotificationTransportResult>;
}

export class WebhookReviewNotifier implements ReviewNotificationTransport {
	constructor(
		private readonly webhookUrl: string,
		private readonly bearerToken: string,
		private readonly fetcher: typeof fetch = fetch,
		private readonly timeoutMs = 8_000,
	) {}

	async send(notification: ReviewNotification): Promise<ReviewNotificationTransportResult> {
		let url: URL;
		try {
			url = new URL(this.webhookUrl.trim());
		} catch {
			throw new ReviewNotificationError('NOT_CONFIGURED');
		}
		if (url.protocol !== 'https:' || this.bearerToken.trim().length < 32) {
			throw new ReviewNotificationError('NOT_CONFIGURED');
		}
		let response: Response;
		try {
			response = await this.fetcher(url, {
				method: 'POST',
				headers: {
					'authorization': `Bearer ${this.bearerToken.trim()}`,
					'content-type': 'application/json',
					'idempotency-key': notification.idempotencyKey,
				},
				signal: AbortSignal.timeout(this.timeoutMs),
				body: JSON.stringify({
					text: notification.message, reviewUrl: notification.reviewUrl,
					batchId: notification.batchId, reminderStage: notification.stage,
					reminderKind: notification.kind,
				}),
			});
		} catch {
			throw new ReviewNotificationError('NETWORK');
		}
		let requestId = response.headers.get('cf-ray') ?? response.headers.get('x-request-id');
		if (!response.ok) throw new ReviewNotificationError(
			response.status >= 500 ? 'AMBIGUOUS' : 'REJECTED', response.status, requestId,
		);
		if (response.status !== 200 && response.status !== 202) {
			throw new ReviewNotificationError('AMBIGUOUS', response.status, requestId);
		}
		let acknowledgement: unknown;
		try {
			acknowledgement = await response.json();
		} catch {
			throw new ReviewNotificationError('AMBIGUOUS', response.status, requestId);
		}
		const deliveryState = acknowledgement && typeof acknowledgement === 'object'
			? (acknowledgement as { deliveryState?: unknown }).deliveryState : null;
		if (!acknowledgement || typeof acknowledgement !== 'object'
			|| !['PENDING', 'DELIVERED', 'AMBIGUOUS'].includes(String(deliveryState))
			|| (acknowledgement as { idempotencyKey?: unknown }).idempotencyKey !== notification.idempotencyKey) {
			throw new ReviewNotificationError('AMBIGUOUS', response.status, requestId);
		}
		if (response.status === 200 && deliveryState !== 'DELIVERED') {
			throw new ReviewNotificationError('AMBIGUOUS', response.status, requestId);
		}
		if (response.status === 202 && deliveryState === 'DELIVERED') {
			throw new ReviewNotificationError('AMBIGUOUS', response.status, requestId);
		}
		const deliveryId = (acknowledgement as { deliveryId?: unknown }).deliveryId;
		if (typeof deliveryId === 'string' && deliveryId.trim()) requestId = deliveryId.trim().slice(0, 200);
		return { status: response.status, requestId,
			deliveryState: deliveryState as ReviewNotificationTransportResult['deliveryState'] };
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
