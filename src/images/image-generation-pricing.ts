import { ImageProviderError, type ImageProvider } from './image-provider';

export const IMAGE_SMOKE_MAX_ESTIMATED_COST_MICROUSD = 50_000;

export interface ImageCostEstimate {
	estimatedCostMicrousd: number;
	basis: {
		provider: string;
		model: string;
		aspectRatio: '3:2';
		size: '1536x1024';
		quality: 'medium';
		outputFormat: 'webp';
		textInputTokensConservative: number;
		textInputPriceMicrousdPerToken: 5;
		outputCostMicrousd: 41_000;
		pricingVersion: 'openai-gpt-image-2-2026-10-12';
	};
}

export function estimateSmokeImageCost(
	provider: Pick<ImageProvider, 'provider' | 'model' | 'generationProfile'>,
	prompt: string,
	aspectRatio: string,
): ImageCostEstimate {
	if (provider.provider !== 'cloudflare-ai-gateway'
		|| provider.model !== 'openai/gpt-image-2'
		|| aspectRatio !== '3:2'
		|| provider.generationProfile?.aspectRatio !== '3:2'
		|| provider.generationProfile.size !== '1536x1024'
		|| provider.generationProfile.quality !== 'medium'
		|| provider.generationProfile.outputFormat !== 'webp') {
		throw new ImageProviderError(
			'The configured image pricing assumptions are unavailable.',
			'PROVIDER_CONFIGURATION',
		);
	}
	const bytes = new TextEncoder().encode(prompt).byteLength;
	if (bytes <= 0) {
		throw new ImageProviderError('The image prompt cannot be priced safely.', 'PROVIDER_CONFIGURATION');
	}
	// Deliberately conservative: UTF-8 bytes / 3 is higher than the usual English-text estimate.
	const textInputTokensConservative = Math.ceil(bytes / 3);
	const estimatedCostMicrousd = 41_000 + textInputTokensConservative * 5;
	if (!Number.isSafeInteger(estimatedCostMicrousd)
		|| estimatedCostMicrousd > IMAGE_SMOKE_MAX_ESTIMATED_COST_MICROUSD) {
		throw new ImageProviderError(
			'The image request exceeds the authorized 50,000 microusd ceiling.',
			'PROVIDER_CONFIGURATION',
			null,
			{ estimatedCostMicrousd, maximumCostMicrousd: IMAGE_SMOKE_MAX_ESTIMATED_COST_MICROUSD },
		);
	}
	return {
		estimatedCostMicrousd,
		basis: {
			provider: provider.provider,
			model: provider.model,
			aspectRatio: '3:2',
			size: '1536x1024',
			quality: 'medium',
			outputFormat: 'webp',
			textInputTokensConservative,
			textInputPriceMicrousdPerToken: 5,
			outputCostMicrousd: 41_000,
			pricingVersion: 'openai-gpt-image-2-2026-10-12',
		},
	};
}
