import { isImageGenerationEnabled, type ImageEnvironment } from '../images/image-provider-factory';
import type { EditorialIdentity } from '../domain/editorial';
import type { ArticleImageService } from './article-image-service';
import type { EditorialSmokeTarget } from './editorial-smoke-target';

export async function generateWorkflowImageIfEnabled(
	environment: Pick<ImageEnvironment, 'IMAGE_GENERATION_ENABLED'>,
	target: EditorialSmokeTarget | null,
	storyId: string,
	identity: EditorialIdentity,
	createService: (target: EditorialSmokeTarget | null) => ArticleImageService,
) {
	if (!isImageGenerationEnabled(environment)) return { imageId: null, status: 'DISABLED' as const };
	// Paid image work requires an authenticated editor to review the assembled
	// prompt and submit an explicit visual direction. Scheduled work cannot do so.
	void target;
	void storyId;
	void identity;
	void createService;
	return { imageId: null, status: 'EDITORIAL_DIRECTION_REQUIRED' as const };
}
