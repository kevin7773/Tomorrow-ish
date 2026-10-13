import { D1EditorialReviewReminderRepository } from '../data/d1-editorial-review-reminder-repository';
import {
	D1EditorialNotificationDelivery,
	D1ReviewNotificationRepository,
} from '../data/d1-review-notification-repository';
import { InternalReviewNotifier } from '../notifications/review-notifier';
import { WebhookReviewNotifier } from '../notifications/review-notifier';
import { CompositeReviewNotifier, DurableExternalReviewNotifier } from '../notifications/durable-external-review-notifier';
import { D1ExternalReviewNotificationRepository } from '../data/external-review-notification-repository';
import { EditorialReviewReminderService } from '../services/editorial-review-reminder-service';
import { ReviewNotificationReceiverService } from '../services/review-notification-receiver-service';

export interface ReviewReminderEnvironment {
	DB: D1Database;
	// Retained for the compatible HTTP adapter; scheduled delivery is in-process.
	REVIEW_NOTIFICATION_WEBHOOK_URL?: string;
	REVIEW_NOTIFICATION_EXTERNAL_URL?: string;
	REVIEW_NOTIFICATION_EXTERNAL_BEARER_TOKEN?: string;
	EDITORIAL_EXTERNAL_NOTIFICATIONS_ENABLED?: string;
	REVIEW_NOTIFICATION_REVIEW_URL?: string;
	IMAGE_WEBHOOK_ORIGIN?: string;
}

function externalEnabled(value: string | undefined): boolean {
	if (value === undefined || value === '' || value === 'false') return false;
	if (value === 'true') return true;
	throw new Error('EDITORIAL_EXTERNAL_NOTIFICATIONS_ENABLED must be true or false');
}

function configuredReviewUrl(environment: ReviewReminderEnvironment): string | null {
	const explicit = environment.REVIEW_NOTIFICATION_REVIEW_URL?.trim();
	if (explicit) return explicit;
	const origin = environment.IMAGE_WEBHOOK_ORIGIN?.trim();
	if (!origin) return null;
	try {
		return new URL('/editorial/batches', origin).toString();
	} catch {
		return null;
	}
}

export function runEditorialReviewReminders(environment: ReviewReminderEnvironment) {
	const reviewUrl = configuredReviewUrl(environment);
	if (!reviewUrl) throw new Error('A review URL is required for internal review notifications');
	const receipts = new D1ReviewNotificationRepository(environment.DB);
	const receiver = new ReviewNotificationReceiverService(
		receipts,
		new D1EditorialNotificationDelivery(environment.DB),
	);
	const internal = new InternalReviewNotifier(receiver, new URL(reviewUrl).origin);
	const notifier = externalEnabled(environment.EDITORIAL_EXTERNAL_NOTIFICATIONS_ENABLED)
		? new CompositeReviewNotifier([
			internal,
			new DurableExternalReviewNotifier(
				new D1ExternalReviewNotificationRepository(environment.DB),
				new WebhookReviewNotifier(
					environment.REVIEW_NOTIFICATION_EXTERNAL_URL?.trim() ?? '',
					environment.REVIEW_NOTIFICATION_EXTERNAL_BEARER_TOKEN?.trim() ?? '',
				),
			),
		])
		: internal;
	return new EditorialReviewReminderService(
		new D1EditorialReviewReminderRepository(environment.DB),
		notifier,
		reviewUrl,
	).process();
}
