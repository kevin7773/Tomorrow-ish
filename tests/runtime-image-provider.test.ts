import { describe, expect, it } from 'vitest';
import {
	createImageProvider,
	DEFAULT_CLOUDFLARE_IMAGE_MODEL,
	DEFAULT_OPENAI_IMAGE_MODEL,
	DEFAULT_REPLICATE_IMAGE_MODEL,
} from '../src/images/image-provider-factory';

describe('runtime image provider configuration', () => {
	it('fails safely when generation or credentials are not configured', () => {
		expect(() => createImageProvider({ IMAGE_GENERATION_ENABLED: 'false' })).toThrow('disabled');
		expect(() => createImageProvider({ IMAGE_GENERATION_ENABLED: 'true', IMAGE_PROVIDER: 'openai' })).toThrow('credentials');
		expect(() => createImageProvider({ IMAGE_GENERATION_ENABLED: 'true', IMAGE_PROVIDER: 'replicate' })).toThrow('credentials');
		expect(() => createImageProvider({ IMAGE_GENERATION_ENABLED: 'true', IMAGE_PROVIDER: 'cloudflare-ai-gateway' })).toThrow('configuration');
	});

	it('selects the asynchronous Cloudflare AI Gateway provider only with complete configuration', () => {
		expect(DEFAULT_CLOUDFLARE_IMAGE_MODEL).toBe('openai/gpt-image-2');
		const provider = createImageProvider({
			IMAGE_GENERATION_ENABLED: 'true', IMAGE_PROVIDER: 'cloudflare-ai-gateway',
			CLOUDFLARE_ACCOUNT_ID: '13fbf38daabf893cddf8e7214957bfce',
			CLOUDFLARE_AI_API_TOKEN: 'token', CLOUDFLARE_AI_GATEWAY_ID: 'tomorrow-ish-images',
		});
		expect(provider).toMatchObject({ lifecycle: 'asynchronous', model: 'openai/gpt-image-2' });
	});

	it('selects OpenAI with the existing OpenAI secret and current official default', () => {
		expect(DEFAULT_OPENAI_IMAGE_MODEL).toBe('gpt-image-2');
		expect(createImageProvider({
			IMAGE_GENERATION_ENABLED: 'true', IMAGE_PROVIDER: 'openai', OPENAI_API_KEY: 'token',
		}).model).toBe('gpt-image-2');
	});

	it('preserves Replicate as an available configured provider', () => {
		expect(DEFAULT_REPLICATE_IMAGE_MODEL).toBe('black-forest-labs/flux-2-pro');
		expect(createImageProvider({
			IMAGE_GENERATION_ENABLED: 'true', IMAGE_PROVIDER: 'replicate', IMAGE_MODEL: 'black-forest-labs/flux-2-pro', REPLICATE_API_TOKEN: 'token',
		}).model).toBe('black-forest-labs/flux-2-pro');
	});
});
