import { describe, expect, it } from 'vitest';
import { createImageProvider, DEFAULT_REPLICATE_IMAGE_MODEL } from '../src/images/image-provider-factory';

describe('runtime image provider configuration', () => {
	it('fails safely when generation or credentials are not configured', () => {
		expect(() => createImageProvider({ IMAGE_GENERATION_ENABLED: 'false' })).toThrow('disabled');
		expect(() => createImageProvider({ IMAGE_GENERATION_ENABLED: 'true', IMAGE_PROVIDER: 'replicate' })).toThrow('credentials');
	});

	it('uses the replaceable configured model with a current official default', () => {
		expect(DEFAULT_REPLICATE_IMAGE_MODEL).toBe('black-forest-labs/flux-2-pro');
		expect(createImageProvider({
			IMAGE_GENERATION_ENABLED: 'true', IMAGE_PROVIDER: 'replicate', IMAGE_MODEL: 'black-forest-labs/flux-2-pro', REPLICATE_API_TOKEN: 'token',
		}).model).toBe('black-forest-labs/flux-2-pro');
	});
});
