import type {
	ExternalDeliveryReconciliationDecision,
	ExternalNotificationReconciliationRepository,
} from '../data/external-review-notification-repository';
import type { EditorialIdentity } from '../domain/editorial';
import { EditorialValidationError, requiredText } from './validation';

const confirmations: Record<ExternalDeliveryReconciliationDecision, string> = {
	CONFIRMED_DELIVERED: 'CONFIRM DELIVERED',
	CONFIRMED_FAILED: 'CONFIRM FAILED',
	MANUALLY_DELIVERED: 'CONFIRM MANUAL DELIVERY',
};

export class ExternalNotificationReconciliationService {
	constructor(
		private readonly repository: ExternalNotificationReconciliationRepository,
		private readonly now: () => string = () => new Date().toISOString(),
		private readonly createId: () => string = () => crypto.randomUUID(),
	) {}

	async reconcile(identity: EditorialIdentity | null | undefined, input: {
		operationKey: unknown; decision: unknown; evidenceReference: unknown; confirmation: unknown;
	}): Promise<void> {
		const actorEmail = identity?.email?.trim().toLowerCase();
		if (!actorEmail) throw new EditorialValidationError('An authenticated editor is required.', 'unauthorized');
		const operationKey = requiredText(input.operationKey, 'Operation key', 300);
		const decision = requiredText(input.decision, 'Decision', 40) as ExternalDeliveryReconciliationDecision;
		if (!(decision in confirmations)) throw new EditorialValidationError('Select a supported reconciliation decision.');
		if (input.confirmation !== confirmations[decision]) {
			throw new EditorialValidationError(`Type ${confirmations[decision]} to confirm reconciliation.`);
		}
		const evidenceReference = requiredText(input.evidenceReference, 'Evidence reference', 500);
		const delivery = await this.repository.find(operationKey);
		if (!delivery) throw new EditorialValidationError('The external delivery record was not found.', 'not-found');
		if (decision === 'MANUALLY_DELIVERED' && delivery.status !== 'FAILED') {
			throw new EditorialValidationError('Only a definitively failed delivery can be recorded as manually delivered.', 'conflict');
		}
		if (decision === 'MANUALLY_DELIVERED' && !evidenceReference.includes(delivery.idempotencyKey)) {
			throw new EditorialValidationError('Manual-delivery evidence must include the original idempotency key.');
		}
		if (decision !== 'MANUALLY_DELIVERED' && delivery.status !== 'AMBIGUOUS'
			&& !(decision === 'CONFIRMED_FAILED' && delivery.status === 'FAILED')) {
			throw new EditorialValidationError('The delivery state is not eligible for this reconciliation.', 'conflict');
		}
		try {
			if (!(await this.repository.reconcile({ id: this.createId(), operationKey, decision,
				evidenceReference, actorEmail, createdAt: this.now() }))) throw new Error('not persisted');
		} catch {
			throw new EditorialValidationError('The delivery changed; reload before reconciling.', 'conflict');
		}
	}
}
