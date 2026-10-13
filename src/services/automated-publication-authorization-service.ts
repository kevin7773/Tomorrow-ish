import type { AutomatedPublicationAuthorizationRepository } from '../data/automated-publication-authorization-repository';
import type { EditorialIdentity } from '../domain/editorial';
import { EditorialValidationError, requiredText } from './validation';

export const AUTOMATED_PUBLICATION_CONFIRMATION = 'AUTHORIZE';

export class AutomatedPublicationAuthorizationService {
	constructor(
		private readonly repository: AutomatedPublicationAuthorizationRepository,
		private readonly now: () => string = () => new Date().toISOString(),
		private readonly createId: () => string = () => crypto.randomUUID(),
	) {}

	async authorize(identity: EditorialIdentity | null | undefined, input: {
		storyId: unknown; imageId: unknown; batchId: unknown; intakeId: unknown; confirmation: unknown;
	}): Promise<void> {
		const actorEmail = identity?.email?.trim().toLowerCase();
		if (!actorEmail) throw new EditorialValidationError('An authenticated editor is required.', 'unauthorized');
		if (input.confirmation !== AUTOMATED_PUBLICATION_CONFIRMATION) {
			throw new EditorialValidationError(`Type ${AUTOMATED_PUBLICATION_CONFIRMATION} to authorize scheduled publication.`);
		}
		const authorized = await this.repository.authorize({
			id: this.createId(), auditId: this.createId(),
			storyId: requiredText(input.storyId, 'Story ID', 100),
			imageId: requiredText(input.imageId, 'Image ID', 100),
			batchId: requiredText(input.batchId, 'Batch ID', 100),
			intakeId: requiredText(input.intakeId, 'Intake ID', 100),
			actorEmail, authorizedAt: this.now(),
		});
		if (!authorized) throw new EditorialValidationError(
			'The approved story, image, or routine workflow identity changed; reload before authorizing.', 'conflict');
	}
}
