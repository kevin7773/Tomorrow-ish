import type { EditorialRepository } from '../data/editorial-repository';
import type { EditorialIdentity } from '../domain/editorial';
import { canTransitionPublication } from '../domain/publication-status';
import { EditorialValidationError, requiredText } from './validation';

export const PUBLISH_CONFIRMATION = 'PUBLISH';

export interface PublishStoryDependencies {
	now?: () => string;
	createId?: () => string;
}

export async function publishStory(
	repository: EditorialRepository,
	identity: EditorialIdentity | null | undefined,
	input: { storyId: unknown; confirmation: unknown },
	dependencies: PublishStoryDependencies = {},
): Promise<string> {
	if (!identity?.email) {
		throw new EditorialValidationError('An authenticated editor is required.', 'unauthorized');
	}
	const storyId = requiredText(input.storyId, 'Story ID', 100);
	if (input.confirmation !== PUBLISH_CONFIRMATION) {
		throw new EditorialValidationError(`Type ${PUBLISH_CONFIRMATION} to confirm publication.`);
	}

	const story = await repository.findEditorialStoryById(storyId);
	if (!story) throw new EditorialValidationError('The story was not found.', 'not-found');
	if (!canTransitionPublication(story.status, 'PUBLISHED') || story.status !== 'APPROVED') {
		throw new EditorialValidationError('Only an approved story can be published.');
	}

	const publishedAt = (dependencies.now ?? (() => new Date().toISOString()))();
	const createId = dependencies.createId ?? (() => crypto.randomUUID());
	const published = await repository.publishApprovedStory({
		id: storyId,
		actorEmail: identity.email.toLowerCase(),
		publishedAt,
		auditId: createId(),
	});
	if (!published) {
		throw new EditorialValidationError('The story changed; reload before publishing.');
	}
	return publishedAt;
}
