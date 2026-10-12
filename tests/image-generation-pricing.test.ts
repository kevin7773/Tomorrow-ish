import { describe, expect, it } from 'vitest';
import { estimateSmokeImageCost, IMAGE_SMOKE_MAX_ESTIMATED_COST_MICROUSD } from '../src/images/image-generation-pricing';

const provider = {
	provider: 'cloudflare-ai-gateway', model: 'openai/gpt-image-2',
	generationProfile: { aspectRatio: '3:2', size: '1536x1024', quality: 'medium', outputFormat: 'webp' },
};

describe('image generation cost ceiling', () => {
	it('prices the exact supported smoke request below the hard ceiling', () => {
		const estimate = estimateSmokeImageCost(provider as never, 'x'.repeat(737), '3:2');
		expect(estimate).toMatchObject({
			estimatedCostMicrousd: 42_230,
			basis: { size: '1536x1024', quality: 'medium', outputCostMicrousd: 41_000 },
		});
		expect(estimate.estimatedCostMicrousd).toBeLessThanOrEqual(IMAGE_SMOKE_MAX_ESTIMATED_COST_MICROUSD);
	});

	it.each([
		[{ provider: 'openai', model: 'gpt-image-2' }, '3:2'],
		[{ provider: 'cloudflare-ai-gateway', model: 'openai/gpt-image-unknown' }, '3:2'],
		[{ ...provider, generationProfile: { ...provider.generationProfile, size: '1024x1024' } }, '3:2'],
		[{ ...provider, generationProfile: { ...provider.generationProfile, quality: 'high' } }, '3:2'],
		[{ ...provider, generationProfile: { ...provider.generationProfile, aspectRatio: '16:9' } }, '3:2'],
		[provider, '1:1'],
	] as const)('fails closed when provider, model, dimensions, or quality assumptions are unavailable', (configured, ratio) => {
		expect(() => estimateSmokeImageCost(configured as never, 'prompt', ratio)).toThrow(/pricing assumptions are unavailable/i);
	});

	it('fails before submission when the conservative prompt estimate exceeds the ceiling', () => {
		expect(() => estimateSmokeImageCost(provider as never, 'x'.repeat(5_500), '3:2'))
			.toThrow(/exceeds the authorized 50,000 microusd ceiling/i);
	});
});
