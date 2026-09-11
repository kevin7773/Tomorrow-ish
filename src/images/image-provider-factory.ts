import { ImageProviderError, type ImageProvider } from './image-provider';
import { OpenAIImageProvider } from './openai-image-provider';
import { ReplicateFluxProvider } from './replicate-flux-provider';

export const DEFAULT_OPENAI_IMAGE_MODEL = 'gpt-image-2';
export const DEFAULT_REPLICATE_IMAGE_MODEL = 'black-forest-labs/flux-2-pro';

export interface ImageEnvironment {
	IMAGE_GENERATION_ENABLED?: string;
	IMAGE_PROVIDER?: string;
	IMAGE_MODEL?: string;
	OPENAI_API_KEY?: string;
	REPLICATE_API_TOKEN?: string;
}

export function createImageProvider(environment: ImageEnvironment): ImageProvider {
	if (environment.IMAGE_GENERATION_ENABLED !== 'true') {
		throw new ImageProviderError('Article image generation is disabled.', 'PROVIDER_DISABLED');
	}
	if (environment.IMAGE_PROVIDER === 'openai') {
		if (!environment.OPENAI_API_KEY) {
			throw new ImageProviderError('OpenAI API credentials are missing.', 'PROVIDER_CONFIGURATION');
		}
		return new OpenAIImageProvider(
			environment.OPENAI_API_KEY,
			environment.IMAGE_MODEL || DEFAULT_OPENAI_IMAGE_MODEL,
		);
	}
	if (environment.IMAGE_PROVIDER === 'replicate') {
		if (!environment.REPLICATE_API_TOKEN) {
			throw new ImageProviderError('Replicate API credentials are missing.', 'PROVIDER_CONFIGURATION');
		}
		return new ReplicateFluxProvider(
			environment.REPLICATE_API_TOKEN,
			environment.IMAGE_MODEL || DEFAULT_REPLICATE_IMAGE_MODEL,
		);
	}
	throw new ImageProviderError('The configured image provider is unsupported.', 'PROVIDER_CONFIGURATION');
}
