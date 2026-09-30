import { env } from 'cloudflare:workers';
import { D1ReviewNotificationRepository } from './d1-review-notification-repository';

export function getReviewNotificationRepository(): D1ReviewNotificationRepository {
	return new D1ReviewNotificationRepository(env.DB);
}
