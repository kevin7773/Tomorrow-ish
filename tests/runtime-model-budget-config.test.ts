import { describe, expect, it } from 'vitest';
import { parseModelBudgetLimits } from '../src/ai/model-budget-config';

const complete = {
	MODEL_BUDGET_ADMISSION_ENABLED: 'true', MODEL_NORMALIZE_MAX_COST_MICRO_USD: '50000',
	MODEL_CANDIDATES_MAX_COST_MICRO_USD: '50000', MODEL_ARTICLE_BODY_MAX_COST_MICRO_USD: '60000',
	MODEL_ITEM_BUDGET_MICRO_USD: '170000', MODEL_BATCH_BUDGET_MICRO_USD: '510000',
	MODEL_DAILY_BUDGET_MICRO_USD: '510000',
};

describe('runtime model budget configuration', () => {
	it('defaults budget admission and generation to disabled', () => {
		const config = parseModelBudgetLimits({});
		expect(config).toEqual({ enabled: false,
			operationMaxMicrousd: { NORMALIZE: 0, GENERATE_CANDIDATES: 0, GENERATE_ARTICLE_BODY: 0 },
			itemMaxMicrousd: 0, batchMaxMicrousd: 0, dailyMaxMicrousd: 0 });
	});

	it('parses distinct operation, item, and daily ceilings', () => {
		const config = parseModelBudgetLimits(complete);
		expect(config).toMatchObject({ enabled: true, itemMaxMicrousd: 170000,
			batchMaxMicrousd: 510000, dailyMaxMicrousd: 510000,
			operationMaxMicrousd: { NORMALIZE: 50000, GENERATE_CANDIDATES: 50000, GENERATE_ARTICLE_BODY: 60000 } });
	});

	it('parses the proposed ceilings while admission remains explicitly disabled', () => {
		expect(parseModelBudgetLimits({ ...complete, MODEL_BUDGET_ADMISSION_ENABLED: 'false' }))
			.toMatchObject({ enabled: false, itemMaxMicrousd: 170000,
				batchMaxMicrousd: 510000, dailyMaxMicrousd: 510000 });
	});

	it.each([
		{ MODEL_BUDGET_ADMISSION_ENABLED: 'true' },
		{ ...complete, MODEL_BUDGET_ADMISSION_ENABLED: 'yes' },
		{ ...complete, MODEL_DAILY_BUDGET_MICRO_USD: '0' },
		{ ...complete, MODEL_ITEM_BUDGET_MICRO_USD: '12.5' },
		{ ...complete, MODEL_CANDIDATES_MAX_COST_MICRO_USD: 'unknown' },
		{ ...complete, MODEL_NORMALIZE_MAX_COST_MICRO_USD: '9007199254740992' },
	])('rejects malformed model budget configuration', (environment) => {
		expect(() => parseModelBudgetLimits(environment)).toThrow();
	});
});
