import type { ResendEmailRepository } from '../data/resend-email-repository';
import type { ReviewNotification } from '../notifications/review-notifier';
import {
	editorialEmailPayloadHash,
	renderEditorialEmail,
	ResendConfigurationError,
	ResendSubmissionError,
	sha256Hex,
	type ResendEmailConfiguration,
	type ResendEmailProvider,
	type VerifiedResendWebhook,
} from '../notifications/resend-email';

export interface ResendEmailAcknowledgement {
	deliveryState: 'PENDING' | 'DELIVERED' | 'FAILED' | 'AMBIGUOUS';
	idempotencyKey: string;
	deliveryId: string | null;
	classification: string | null;
}

export class ResendEditorialEmailService {
	constructor(
		private readonly repository: ResendEmailRepository,
		private readonly provider: Pick<ResendEmailProvider, 'submit'>,
		private readonly configuration: Pick<ResendEmailConfiguration, 'toEmail' | 'fromEmail'>,
		private readonly now: () => string = () => new Date().toISOString(),
	) {}

	async submit(notification: ReviewNotification): Promise<ResendEmailAcknowledgement> {
		const pendingCount = await this.repository.countPending(notification.batchId, notification.stage);
		let email;
		try { email = renderEditorialEmail(notification, pendingCount); } catch (error) {
			if (!(error instanceof ResendConfigurationError)) throw error;
			return { deliveryState: 'FAILED', idempotencyKey: notification.idempotencyKey,
				deliveryId: null, classification: 'NO_PENDING_EDITORIAL_DECISIONS' };
		}
		const payloadHash = await editorialEmailPayloadHash(notification, pendingCount, this.configuration, email);
		const idempotencyHash = await sha256Hex(notification.idempotencyKey);
		const reservation = await this.repository.reserve(notification, payloadHash, idempotencyHash, this.now());
		if (reservation === 'CONFLICT') return { deliveryState: 'FAILED', idempotencyKey: notification.idempotencyKey,
			deliveryId: null, classification: 'IDEMPOTENCY_CONFLICT' };
		if (reservation === 'BLOCKED') return { deliveryState: 'FAILED', idempotencyKey: notification.idempotencyKey,
			deliveryId: null, classification: 'SOURCE_DELIVERY_NOT_AUTHORIZED' };
		if (reservation !== 'ACQUIRED') {
			const existing = await this.repository.find(notification.idempotencyKey);
			return { deliveryState: reservation, idempotencyKey: notification.idempotencyKey,
				deliveryId: existing?.providerEmailId ?? null,
				classification: existing?.failureClassification ?? null };
		}
		try {
			const submitted = await this.provider.submit(notification.idempotencyKey, idempotencyHash, email);
			if (!(await this.repository.markAccepted(notification.idempotencyKey, submitted.providerEmailId,
				submitted.responseStatus, this.now()))) {
				await this.repository.markAmbiguous(notification.idempotencyKey,
					'ACCEPTED_SUBMISSION_PERSISTENCE_FAILED', submitted.responseStatus, this.now());
				return { deliveryState: 'AMBIGUOUS', idempotencyKey: notification.idempotencyKey,
					deliveryId: submitted.providerEmailId, classification: 'ACCEPTED_SUBMISSION_PERSISTENCE_FAILED' };
			}
			return { deliveryState: 'PENDING', idempotencyKey: notification.idempotencyKey,
				deliveryId: submitted.providerEmailId, classification: null };
		} catch (error) {
			if (error instanceof ResendConfigurationError) {
				await this.repository.markFailed(notification.idempotencyKey,
					'PROVIDER_CONFIGURATION', null, this.now());
				return { deliveryState: 'FAILED', idempotencyKey: notification.idempotencyKey,
					deliveryId: null, classification: 'PROVIDER_CONFIGURATION' };
			}
			const providerError = error instanceof ResendSubmissionError ? error : null;
			const classification = providerError?.classification ?? 'PROVIDER_AMBIGUOUS';
			if (classification === 'PROVIDER_REJECTED') {
				await this.repository.markFailed(notification.idempotencyKey, classification,
					providerError?.responseStatus ?? null, this.now());
				return { deliveryState: 'FAILED', idempotencyKey: notification.idempotencyKey,
					deliveryId: null, classification };
			}
			await this.repository.markAmbiguous(notification.idempotencyKey, classification,
				providerError?.responseStatus ?? null, this.now());
			return { deliveryState: 'AMBIGUOUS', idempotencyKey: notification.idempotencyKey,
				deliveryId: null, classification };
		}
	}

	async receiveProviderEvent(event: VerifiedResendWebhook): Promise<'RECORDED' | 'DUPLICATE' | 'UNKNOWN'> {
		return this.repository.recordProviderEvent({
			eventId: event.eventId,
			providerEmailId: event.providerEmailId,
			idempotencyHash: event.idempotencyHash,
			eventType: event.type,
			providerCreatedAt: event.providerCreatedAt,
			payloadHash: event.payloadHash,
			receivedAt: this.now(),
		});
	}
}
