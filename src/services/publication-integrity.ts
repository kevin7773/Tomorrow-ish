import type { PublicationReadiness } from '../domain/publication-integrity';
import { EditorialValidationError } from './validation';

export function requirePublicationReady(readiness: PublicationReadiness): void {
	switch (readiness) {
		case 'READY': return;
		case 'NOT_FOUND': throw new EditorialValidationError('The story was not found.', 'not-found');
		case 'STORY_NOT_APPROVED':
			throw new EditorialValidationError('The story must be approved before publication.', 'story-not-approved');
		case 'IMAGE_REQUIRED':
			throw new EditorialValidationError('An editorially approved image is required before publication.', 'image-required');
		case 'IMAGE_NOT_APPROVED':
			throw new EditorialValidationError('The story image must be explicitly approved and attached before publication.', 'image-not-approved');
		case 'INVALID_CONTENT':
			throw new EditorialValidationError('The story headline and article body are required before publication.');
	}
}
