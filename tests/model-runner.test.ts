import { describe, expect, it, vi } from 'vitest';
import { ModelExecutionError, ModelLimitError, runWithLimits } from '../src/ai/model-runner';

const limits = {
	timeoutMs: 100,
	maxAttempts: 2,
	defaultCandidateCount: 5,
	maxInputCharacters: 100,
	maxOutputCharacters: 100,
	maxEstimatedCostMicrousd: 100,
};

describe('model execution limits', () => {
	it('uses bounded retries and exposes sanitized accounting metadata', async () => {
		const operation = vi.fn(async () => { throw new Error('provider unavailable'); });
		const error = await runWithLimits(operation, 10, limits).catch((caught) => caught);
		expect(operation).toHaveBeenCalledTimes(2);
		expect(error).toBeInstanceOf(ModelExecutionError);
		expect(error.retryCount).toBe(1);
		expect(error.latencyMs).toBeGreaterThanOrEqual(0);
	});

	it('rejects oversized input before invoking a provider', async () => {
		const operation = vi.fn();
		await expect(runWithLimits(operation, 101, limits)).rejects.toBeInstanceOf(ModelLimitError);
		expect(operation).not.toHaveBeenCalled();
	});
});
