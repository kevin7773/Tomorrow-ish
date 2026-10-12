import { describe, expect, it, vi } from 'vitest';
import type { ArticleImageService } from '../src/services/article-image-service';
import { generateWorkflowImageIfEnabled } from '../src/services/workflow-image-generation';

describe('workflow image generation gate', () => {
	it('reaches the review-ready image outcome without constructing a provider service when disabled', async () => {
		const createService = vi.fn();
		const result = await generateWorkflowImageIfEnabled(
			{ IMAGE_GENERATION_ENABLED: 'false' },
			{ batchId: 'batch-target', intakeId: 'intake-target' },
			'story-1',
			{ email: 'editor@example.com' },
			createService,
		);

		expect(result).toEqual({ imageId: null, status: 'DISABLED' });
		expect(createService).not.toHaveBeenCalled();
	});

	it('requires reviewed editorial direction without constructing a provider service when enabled', async () => {
		const generate = vi.fn(async () => ({ imageId: 'image-1', status: 'GENERATED' as const }));
		const createService = vi.fn(() => ({ generate }) as unknown as ArticleImageService);
		const target = { batchId: 'batch-target', intakeId: 'intake-target' };

		await expect(generateWorkflowImageIfEnabled(
			{ IMAGE_GENERATION_ENABLED: 'true' }, target, 'story-1',
			{ email: 'editor@example.com' }, createService,
		)).resolves.toEqual({ imageId: null, status: 'EDITORIAL_DIRECTION_REQUIRED' });
		expect(createService).not.toHaveBeenCalled();
		expect(generate).not.toHaveBeenCalled();
	});
});
