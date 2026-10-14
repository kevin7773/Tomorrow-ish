import type { ResendEditorialEmailService } from '../services/resend-editorial-email-service';
import {
	ReviewNotificationError,
	type ReviewNotification,
	type ReviewNotificationTransport,
	type ReviewNotificationTransportResult,
} from './review-notifier';

/**
 * Scheduled reminders already execute inside the Worker. This adapter preserves the
 * durable external-delivery and Resend ledgers without making a public HTTP call back
 * into the same Worker. The bearer-protected HTTP endpoint remains available for
 * genuinely external callers.
 */
export class ResendReviewNotificationTransport implements ReviewNotificationTransport {
	constructor(private readonly service: Pick<ResendEditorialEmailService, 'submit'>) {}

	async send(notification: ReviewNotification): Promise<ReviewNotificationTransportResult> {
		const acknowledgement = await this.service.submit(notification);
		if (acknowledgement.deliveryState === 'FAILED') {
			throw new ReviewNotificationError(
				acknowledgement.classification === 'PROVIDER_CONFIGURATION' ? 'NOT_CONFIGURED' : 'REJECTED',
			);
		}
		if (acknowledgement.deliveryState === 'AMBIGUOUS') {
			return { status: 502, requestId: acknowledgement.deliveryId, deliveryState: 'AMBIGUOUS' };
		}
		return {
			status: acknowledgement.deliveryState === 'DELIVERED' ? 200 : 202,
			requestId: acknowledgement.deliveryId,
			deliveryState: acknowledgement.deliveryState,
		};
	}
}
