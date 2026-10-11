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
	return createService(target).generate(identity, { storyId });
}
