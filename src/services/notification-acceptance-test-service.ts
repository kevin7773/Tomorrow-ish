import type { NotificationAcceptanceTestRepository } from '../data/notification-acceptance-test-repository';
import type { EditorialIdentity } from '../domain/editorial';
import {
	notificationAcceptanceTestPayloadHash,
	renderNotificationAcceptanceTestEmail,
	ResendConfigurationError,
	ResendSubmissionError,
	sha256Hex,
	type ResendEmailConfiguration,
	type ResendEmailProvider,
} from '../notifications/resend-email';
import type { VerifiedResendWebhook } from '../notifications/resend-email';
import { EditorialValidationError, requiredText } from './validation';

export const NOTIFICATION_ACCEPTANCE_TEST_CONFIRMATION = 'SEND ONE TEST EMAIL';
const AUTHORIZATION_PATTERN = /^[a-z0-9][a-z0-9:_-]{15,199}$/;

export interface NotificationAcceptanceTestEnvironment {
	EDITORIAL_NOTIFICATION_ACCEPTANCE_TEST_ENABLED?: string;
	EDITORIAL_NOTIFICATION_ACCEPTANCE_TEST_AUTHORIZATION_ID?: string;
}

export interface NotificationAcceptanceTestAcknowledgement {
	deliveryState: 'PENDING' | 'DELIVERED' | 'FAILED' | 'AMBIGUOUS';
	testId: string;
	idempotencyKey: string;
	deliveryId: string | null;
	classification: string | null;
}

function authorization(environment: NotificationAcceptanceTestEnvironment): string {
	const enabled = environment.EDITORIAL_NOTIFICATION_ACCEPTANCE_TEST_ENABLED;
	if (enabled === undefined || enabled === '' || enabled === 'false') {
		throw new EditorialValidationError('Notification acceptance testing is disabled.', 'notification-test-disabled');
	}
	if (enabled !== 'true') {
		throw new EditorialValidationError('Notification acceptance-test configuration is invalid.', 'notification-test-disabled');
	}
	const authorizationId = environment.EDITORIAL_NOTIFICATION_ACCEPTANCE_TEST_AUTHORIZATION_ID?.trim() ?? '';
	if (!AUTHORIZATION_PATTERN.test(authorizationId)) {
		throw new EditorialValidationError('Notification acceptance-test authorization is missing or invalid.',
			'notification-test-disabled');
	}
	return authorizationId;
}

export class NotificationAcceptanceTestService {
	constructor(
		private readonly repository: NotificationAcceptanceTestRepository,
		private readonly providerFactory: () => Pick<ResendEmailProvider, 'submit'>,
		private readonly emailConfiguration: Pick<ResendEmailConfiguration, 'toEmail' | 'fromEmail'>,
		private readonly environment: NotificationAcceptanceTestEnvironment,
		private readonly now: () => string = () => new Date().toISOString(),
		private readonly createId: () => string = () => crypto.randomUUID(),
	) {}

	async submit(identity: EditorialIdentity | null | undefined, input: {
		authorizationId: unknown; confirmation: unknown;
	}): Promise<NotificationAcceptanceTestAcknowledgement> {
		const actorEmail = identity?.email?.trim().toLowerCase();
		if (!actorEmail) throw new EditorialValidationError('An authenticated editor is required.', 'unauthorized');
		const configuredAuthorization = authorization(this.environment);
		const suppliedAuthorization = requiredText(input.authorizationId, 'Authorization ID', 200);
		if (suppliedAuthorization !== configuredAuthorization) {
			throw new EditorialValidationError('The acceptance-test authorization does not match.', 'conflict');
		}
		if (input.confirmation !== NOTIFICATION_ACCEPTANCE_TEST_CONFIRMATION) {
			throw new EditorialValidationError(`Type ${NOTIFICATION_ACCEPTANCE_TEST_CONFIRMATION} to send the test.`);
		}

		const idempotencyKey = `editorial-notification-acceptance-test:${configuredAuthorization}`;
		const email = renderNotificationAcceptanceTestEmail({
			authorizationId: configuredAuthorization, idempotencyKey,
		});
		const [idempotencyHash, payloadHash] = await Promise.all([
			sha256Hex(idempotencyKey),
			notificationAcceptanceTestPayloadHash({
				authorizationId: configuredAuthorization, idempotencyKey,
			}, this.emailConfiguration, email),
		]);
		const at = this.now();
		const testId = this.createId();
		const reservation = await this.repository.reserve({
			id: testId, eventId: this.createId(), authorizationId: configuredAuthorization,
			operationKey: `acceptance-test:v1:${configuredAuthorization}`,
			idempotencyKey, idempotencyHash, payloadHash, actorEmail, authorizedAt: at,
		});
		if (reservation === 'CONFLICT') {
			return { deliveryState: 'FAILED', testId, idempotencyKey, deliveryId: null,
				classification: 'IDEMPOTENCY_CONFLICT' };
		}
		if (reservation !== 'ACQUIRED') {
			const existing = await this.repository.find(idempotencyKey);
			return { deliveryState: reservation, testId: existing?.id ?? testId, idempotencyKey,
				deliveryId: existing?.providerEmailId ?? null,
				classification: existing?.failureClassification ?? null };
		}

		try {
			// Provider construction is deliberately fenced behind the durable reservation.
			const submitted = await this.providerFactory().submit(idempotencyKey, idempotencyHash, email);
			if (!(await this.repository.markAccepted({ idempotencyKey, eventId: this.createId(),
				providerEmailId: submitted.providerEmailId, responseStatus: submitted.responseStatus, at: this.now() }))) {
				await this.repository.markAmbiguous({ idempotencyKey, eventId: this.createId(),
					classification: 'ACCEPTED_SUBMISSION_PERSISTENCE_FAILED',
					responseStatus: submitted.responseStatus, providerEmailId: submitted.providerEmailId, at: this.now() });
				return { deliveryState: 'AMBIGUOUS', testId, idempotencyKey,
					deliveryId: submitted.providerEmailId,
					classification: 'ACCEPTED_SUBMISSION_PERSISTENCE_FAILED' };
			}
			return { deliveryState: 'PENDING', testId, idempotencyKey,
				deliveryId: submitted.providerEmailId, classification: null };
		} catch (error) {
			if (error instanceof ResendConfigurationError) {
				await this.repository.markFailed({ idempotencyKey, eventId: this.createId(),
					classification: 'PROVIDER_CONFIGURATION', responseStatus: null, at: this.now() });
				return { deliveryState: 'FAILED', testId, idempotencyKey,
					deliveryId: null, classification: 'PROVIDER_CONFIGURATION' };
			}
			const providerError = error instanceof ResendSubmissionError ? error : null;
			const classification = providerError?.classification ?? 'PROVIDER_AMBIGUOUS';
			const persistenceClassification = providerError?.persistenceClassification ?? classification;
			if (classification === 'PROVIDER_REJECTED') {
				await this.repository.markFailed({ idempotencyKey, eventId: this.createId(),
					classification: persistenceClassification,
					responseStatus: providerError?.responseStatus ?? null, at: this.now() });
				return { deliveryState: 'FAILED', testId, idempotencyKey,
					deliveryId: null, classification };
			}
			await this.repository.markAmbiguous({ idempotencyKey, eventId: this.createId(),
				classification: persistenceClassification,
				responseStatus: providerError?.responseStatus ?? null, at: this.now() });
			return { deliveryState: 'AMBIGUOUS', testId, idempotencyKey,
				deliveryId: null, classification };
		}
	}

	receiveProviderEvent(event: VerifiedResendWebhook) {
		return this.repository.recordProviderEvent({
			eventId: event.eventId, providerEmailId: event.providerEmailId,
			idempotencyHash: event.idempotencyHash, eventType: event.type,
			providerCreatedAt: event.providerCreatedAt, payloadHash: event.payloadHash,
			receivedAt: this.now(),
		});
	}
}
