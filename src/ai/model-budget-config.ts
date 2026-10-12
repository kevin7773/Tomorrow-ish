import type { ModelBudgetLimits } from '../data/generation-repository';
import { ModelProviderError } from './model-provider';

export interface ModelBudgetEnvironment {
	MODEL_BUDGET_ADMISSION_ENABLED?: string;
	MODEL_NORMALIZE_MAX_COST_MICRO_USD?: string;
	MODEL_CANDIDATES_MAX_COST_MICRO_USD?: string;
	MODEL_ARTICLE_BODY_MAX_COST_MICRO_USD?: string;
	MODEL_ITEM_BUDGET_MICRO_USD?: string;
	MODEL_DAILY_BUDGET_MICRO_USD?: string;
}

export function strictConfigurationBoolean(value: string | undefined, name: string): boolean {
	if (value === undefined || value === '' || value === 'false') return false;
	if (value === 'true') return true;
	throw new ModelProviderError('PROVIDER_CONFIGURATION', false, `${name} must be true or false.`);
}

function positiveBudget(value: string | undefined, name: string): number {
	if (value === undefined || value === '') return 0;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		throw new ModelProviderError('PROVIDER_CONFIGURATION', false, `${name} must be a positive integer.`);
	}
	return parsed;
}

export function parseModelBudgetLimits(environment: ModelBudgetEnvironment): ModelBudgetLimits {
	const limits: ModelBudgetLimits = {
		enabled: strictConfigurationBoolean(environment.MODEL_BUDGET_ADMISSION_ENABLED, 'MODEL_BUDGET_ADMISSION_ENABLED'),
		operationMaxMicrousd: {
			NORMALIZE: positiveBudget(environment.MODEL_NORMALIZE_MAX_COST_MICRO_USD, 'MODEL_NORMALIZE_MAX_COST_MICRO_USD'),
			GENERATE_CANDIDATES: positiveBudget(environment.MODEL_CANDIDATES_MAX_COST_MICRO_USD, 'MODEL_CANDIDATES_MAX_COST_MICRO_USD'),
			GENERATE_ARTICLE_BODY: positiveBudget(environment.MODEL_ARTICLE_BODY_MAX_COST_MICRO_USD, 'MODEL_ARTICLE_BODY_MAX_COST_MICRO_USD'),
		},
		itemMaxMicrousd: positiveBudget(environment.MODEL_ITEM_BUDGET_MICRO_USD, 'MODEL_ITEM_BUDGET_MICRO_USD'),
		dailyMaxMicrousd: positiveBudget(environment.MODEL_DAILY_BUDGET_MICRO_USD, 'MODEL_DAILY_BUDGET_MICRO_USD'),
	};
	if (limits.enabled && [limits.operationMaxMicrousd.NORMALIZE,
		limits.operationMaxMicrousd.GENERATE_CANDIDATES,
		limits.operationMaxMicrousd.GENERATE_ARTICLE_BODY,
		limits.itemMaxMicrousd, limits.dailyMaxMicrousd].some((value) => value <= 0)) {
		throw new ModelProviderError('PROVIDER_CONFIGURATION', false,
			'Every model budget ceiling is required when budget admission is enabled.');
	}
	return limits;
}
