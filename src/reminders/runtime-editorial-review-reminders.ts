import { D1EditorialReviewReminderRepository } from '../data/d1-editorial-review-reminder-repository';
import {
	D1EditorialNotificationDelivery,
	D1ReviewNotificationRepository,
} from '../data/d1-review-notification-repository';
import { D1ResendEmailRepository } from '../data/resend-email-repository';
import { InternalReviewNotifier } from '../notifications/review-notifier';
import { CompositeReviewNotifier, DurableExternalReviewNotifier } from '../notifications/durable-external-review-notifier';
import { D1ExternalReviewNotificationRepository } from '../data/external-review-notification-repository';
import { ResendEmailProvider } from '../notifications/resend-email';
import { ResendReviewNotificationTransport } from '../notifications/resend-review-notification-transport';
import { EditorialReviewReminderService } from '../services/editorial-review-reminder-service';
import { ReviewNotificationReceiverService } from '../services/review-notification-receiver-service';
import { ResendEditorialEmailService } from '../services/resend-editorial-email-service';

export interface ReviewReminderEnvironment {
	DB: D1Database;
	EDITORIAL_EXTERNAL_NOTIFICATIONS_ENABLED?: string;
	REVIEW_NOTIFICATION_REVIEW_URL?: string;
	IMAGE_WEBHOOK_ORIGIN?: string;
	RESEND_API_KEY?: string;
	RESEND_WEBHOOK_SIGNING_SECRET?: string;
	EDITORIAL_NOTIFICATION_TO_EMAIL?: string;
	EDITORIAL_NOTIFICATION_FROM_EMAIL?: string;
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
	const resendConfiguration = {
		apiKey: environment.RESEND_API_KEY ?? '',
		webhookSigningSecret: environment.RESEND_WEBHOOK_SIGNING_SECRET ?? '',
		toEmail: environment.EDITORIAL_NOTIFICATION_TO_EMAIL ?? '',
		fromEmail: environment.EDITORIAL_NOTIFICATION_FROM_EMAIL ?? '',
	};
	const notifier = externalEnabled(environment.EDITORIAL_EXTERNAL_NOTIFICATIONS_ENABLED)
		? new CompositeReviewNotifier([
			internal,
			new DurableExternalReviewNotifier(
				new D1ExternalReviewNotificationRepository(environment.DB),
				new ResendReviewNotificationTransport(
					new ResendEditorialEmailService(
						new D1ResendEmailRepository(environment.DB),
						new ResendEmailProvider(resendConfiguration),
						resendConfiguration,
					),
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
