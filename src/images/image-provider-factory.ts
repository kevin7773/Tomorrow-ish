import { ImageProviderError, type ImageProvider } from './image-provider';
import { ReplicateFluxProvider } from './replicate-flux-provider';

export const DEFAULT_REPLICATE_IMAGE_MODEL = 'black-forest-labs/flux-2-pro';

export interface ImageEnvironment {
	IMAGE_GENERATION_ENABLED?: string;
	IMAGE_PROVIDER?: string;
	IMAGE_MODEL?: string;
	REPLICATE_API_TOKEN?: string;
}

export function createImageProvider(environment: ImageEnvironment): ImageProvider {
	if (environment.IMAGE_GENERATION_ENABLED !== 'true') {
		throw new ImageProviderError('Article image generation is disabled.', 'PROVIDER_DISABLED');
	}
	if (environment.IMAGE_PROVIDER !== 'replicate') {
		throw new ImageProviderError('The configured image provider is unsupported.', 'PROVIDER_CONFIGURATION');
	}
	if (!environment.REPLICATE_API_TOKEN) {
		throw new ImageProviderError('Replicate API credentials are missing.', 'PROVIDER_CONFIGURATION');
	}
	return new ReplicateFluxProvider(
		environment.REPLICATE_API_TOKEN,
		environment.IMAGE_MODEL || DEFAULT_REPLICATE_IMAGE_MODEL,
	);
}
