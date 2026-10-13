import type { ExternalReviewNotificationRepository } from '../data/external-review-notification-repository';
import {
	ReviewNotificationError,
	type ReviewNotification,
	type ReviewNotificationTransport,
	type ReviewNotifier,
} from './review-notifier';

export class DurableExternalReviewNotifier implements ReviewNotifier {
	constructor(
		private readonly repository: ExternalReviewNotificationRepository,
		private readonly transport: ReviewNotificationTransport,
		private readonly now: () => string = () => new Date().toISOString(),
		private readonly createId: () => string = () => crypto.randomUUID(),
	) {}

	async send(notification: ReviewNotification): Promise<void> {
		const operationKey = `external-review:v1:${notification.idempotencyKey}`;
		const owner = this.createId();
		const reserved = await this.repository.reserve(notification, operationKey, owner, this.now());
		if (reserved === 'DELIVERED') return;
		if (reserved === 'CONFLICT') throw new ReviewNotificationError('CONFLICT');
		if (reserved !== 'ACQUIRED') throw new ReviewNotificationError('AMBIGUOUS');
		try {
			const result = await this.transport.send(notification);
			if (result.status === 202) {
				await this.repository.markAmbiguous(operationKey, owner, this.now(),
					'QUEUED_WITHOUT_DELIVERY_CONFIRMATION', result.status, result.requestId);
				throw new ReviewNotificationError('AMBIGUOUS', result.status, result.requestId);
			}
			if (!(await this.repository.markDelivered(operationKey, owner, this.now(), result.status, result.requestId))) {
				throw new ReviewNotificationError('AMBIGUOUS');
			}
		} catch (error) {
			const classification = error instanceof ReviewNotificationError ? error.classification : 'AMBIGUOUS';
			const responseStatus = error instanceof ReviewNotificationError ? error.responseStatus : null;
			const requestId = error instanceof ReviewNotificationError ? error.requestId : null;
			if (classification === 'REJECTED' || classification === 'NOT_CONFIGURED' || classification === 'CONFLICT') {
				await this.repository.markFailed(operationKey, owner, this.now(), classification, responseStatus, requestId);
				throw error;
			}
			await this.repository.markAmbiguous(operationKey, owner, this.now(), classification, responseStatus, requestId);
			throw new ReviewNotificationError('AMBIGUOUS');
		}
	}
}

export class CompositeReviewNotifier implements ReviewNotifier {
	constructor(private readonly notifiers: ReviewNotifier[]) {}
	async send(notification: ReviewNotification): Promise<void> {
		for (const notifier of this.notifiers) await notifier.send(notification);
	}
}
