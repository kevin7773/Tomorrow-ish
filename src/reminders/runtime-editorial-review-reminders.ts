import { D1EditorialReviewReminderRepository } from '../data/d1-editorial-review-reminder-repository';
import { WebhookReviewNotifier } from '../notifications/review-notifier';
import { EditorialReviewReminderService } from '../services/editorial-review-reminder-service';

export interface ReviewReminderEnvironment {
	DB: D1Database;
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
	return new EditorialReviewReminderService(
		new D1EditorialReviewReminderRepository(environment.DB),
		new WebhookReviewNotifier(environment.REVIEW_NOTIFICATION_WEBHOOK_URL ?? ''),
		configuredReviewUrl(environment),
	).process();
}
