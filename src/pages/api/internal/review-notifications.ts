import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import {
	D1EditorialNotificationDelivery,
	D1ReviewNotificationRepository,
} from '../../../data/d1-review-notification-repository';
import { handleReviewNotificationRequest } from '../../../notifications/review-notification-endpoint';
import { ReviewNotificationReceiverService } from '../../../services/review-notification-receiver-service';

export const POST: APIRoute = async ({ request }) => {
	const receipts = new D1ReviewNotificationRepository(env.DB);
	return handleReviewNotificationRequest(
		request,
		new ReviewNotificationReceiverService(receipts, new D1EditorialNotificationDelivery(env.DB)),
	);
};
