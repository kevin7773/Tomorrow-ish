import { describe, expect, it } from 'vitest';
import { parseModelBudgetLimits } from '../src/ai/model-budget-config';

const complete = {
	MODEL_BUDGET_ADMISSION_ENABLED: 'true', MODEL_NORMALIZE_MAX_COST_MICRO_USD: '50000',
	MODEL_CANDIDATES_MAX_COST_MICRO_USD: '43870', MODEL_ARTICLE_BODY_MAX_COST_MICRO_USD: '54000',
	MODEL_ITEM_BUDGET_MICRO_USD: '150000', MODEL_DAILY_BUDGET_MICRO_USD: '1000000',
};

describe('runtime model budget configuration', () => {
	it('defaults budget admission and generation to disabled', () => {
		const config = parseModelBudgetLimits({});
		expect(config).toEqual({ enabled: false,
			operationMaxMicrousd: { NORMALIZE: 0, GENERATE_CANDIDATES: 0, GENERATE_ARTICLE_BODY: 0 },
			itemMaxMicrousd: 0, dailyMaxMicrousd: 0 });
	});

	it('parses distinct operation, item, and daily ceilings', () => {
		const config = parseModelBudgetLimits(complete);
		expect(config).toMatchObject({ enabled: true, itemMaxMicrousd: 150000,
			dailyMaxMicrousd: 1000000,
			operationMaxMicrousd: { NORMALIZE: 50000, GENERATE_CANDIDATES: 43870, GENERATE_ARTICLE_BODY: 54000 } });
	});

	it.each([
		{ MODEL_BUDGET_ADMISSION_ENABLED: 'true' },
		{ ...complete, MODEL_BUDGET_ADMISSION_ENABLED: 'yes' },
		{ ...complete, MODEL_DAILY_BUDGET_MICRO_USD: '0' },
		{ ...complete, MODEL_ITEM_BUDGET_MICRO_USD: '12.5' },
		{ ...complete, MODEL_CANDIDATES_MAX_COST_MICRO_USD: 'unknown' },
	])('rejects malformed model budget configuration', (environment) => {
		expect(() => parseModelBudgetLimits(environment)).toThrow();
	});
});
