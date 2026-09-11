import { describe, expect, it, vi } from 'vitest';
import {
	DEFAULT_MODEL_LIMITS,
	ModelExecutionError,
	ModelLimitError,
	modelLimitsForOperation,
	runWithLimits,
} from '../src/ai/model-runner';

const limits = {
	timeoutMs: 100,
	candidateTimeoutMs: 250,
	maxAttempts: 2,
	defaultCandidateCount: 5,
	maxInputCharacters: 100,
	maxOutputCharacters: 100,
	maxEstimatedCostMicrousd: 100,
};

describe('model execution limits', () => {
	it('keeps normalization at eight seconds and candidate generation at twenty-five seconds', () => {
		expect(modelLimitsForOperation('NORMALIZE').timeoutMs).toBe(8_000);
		expect(modelLimitsForOperation('GENERATE_CANDIDATES').timeoutMs).toBe(25_000);
		expect(DEFAULT_MODEL_LIMITS.maxAttempts).toBe(2);
	});
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
