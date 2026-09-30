import { D1EditorialReviewReminderRepository } from '../data/d1-editorial-review-reminder-repository';
import {
	D1EditorialNotificationDelivery,
	D1ReviewNotificationRepository,
} from '../data/d1-review-notification-repository';
import { InternalReviewNotifier } from '../notifications/review-notifier';
import { EditorialReviewReminderService } from '../services/editorial-review-reminder-service';
import { ReviewNotificationReceiverService } from '../services/review-notification-receiver-service';

export interface ReviewReminderEnvironment {
	DB: D1Database;
	// Retained for the compatible HTTP adapter; scheduled delivery is in-process.
	REVIEW_NOTIFICATION_WEBHOOK_URL?: string;
	REVIEW_NOTIFICATION_REVIEW_URL?: string;
	IMAGE_WEBHOOK_ORIGIN?: string;
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
	return new EditorialReviewReminderService(
		new D1EditorialReviewReminderRepository(environment.DB),
		new InternalReviewNotifier(receiver, new URL(reviewUrl).origin),
		reviewUrl,
	).process();
}
