import { env } from 'cloudflare:workers';
import { FakeModelProvider } from './fake-model-provider';
import type { ModelProvider } from './model-provider';
import { ModelProviderError } from './model-provider';
import { OpenAIModelProvider, OPENAI_MODEL } from './openai-model-provider';

export const DEFAULT_DAILY_BUDGET_MICRO_USD = 1_000_000;

export interface ModelEnvironment {
	MODEL_PROVIDER?: string;
	MODEL_NAME?: string;
	MODEL_GENERATION_ENABLED?: string;
	MODEL_DAILY_BUDGET_MICRO_USD?: string;
	OPENAI_API_KEY?: string;
}

export interface RuntimeModelConfiguration {
	provider: ModelProvider;
	dailyBudgetMicrousd: number;
	generationEnabled: boolean;
}

class DisabledModelProvider implements ModelProvider {
	readonly providerId = 'disabled';
	readonly modelId = 'not-configured';
	estimateMaximumCostMicrousd(): number { return 0; }
	async normalizeEvent(): Promise<never> { throw new ModelProviderError('PROVIDER_DISABLED', false, 'Model generation is disabled.'); }
	async generateCandidates(): Promise<never> { throw new ModelProviderError('PROVIDER_DISABLED', false, 'Model generation is disabled.'); }
	async generateArticleBody(): Promise<never> { throw new ModelProviderError('PROVIDER_DISABLED', false, 'Model generation is disabled.'); }
}

function dailyBudget(value: string | undefined): number {
	if (!value) return DEFAULT_DAILY_BUDGET_MICRO_USD;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new ModelProviderError('PROVIDER_CONFIGURATION', false);
	return parsed;
}

export function createRuntimeModelConfiguration(
	environment: ModelEnvironment,
	options: { development?: boolean; transport?: typeof fetch } = {},
): RuntimeModelConfiguration {
	const budget = dailyBudget(environment.MODEL_DAILY_BUDGET_MICRO_USD);
	if (options.development) {
		return { provider: new FakeModelProvider(), dailyBudgetMicrousd: budget, generationEnabled: true };
	}
	if (environment.MODEL_GENERATION_ENABLED !== 'true') {
		return { provider: new DisabledModelProvider(), dailyBudgetMicrousd: budget, generationEnabled: false };
	}
	if (environment.MODEL_PROVIDER !== 'openai' || environment.MODEL_NAME !== OPENAI_MODEL || !environment.OPENAI_API_KEY) {
		throw new ModelProviderError('PROVIDER_CONFIGURATION', false);
	}
	return {
		provider: new OpenAIModelProvider(environment.OPENAI_API_KEY, environment.MODEL_NAME, options.transport),
		dailyBudgetMicrousd: budget,
		generationEnabled: true,
	};
}

export function getRuntimeModelConfiguration(): RuntimeModelConfiguration {
	return createRuntimeModelConfiguration(env as ModelEnvironment, { development: import.meta.env.DEV });
}

export function isRuntimeModelGenerationAvailable(): boolean {
	if (import.meta.env.DEV) return true;
	const environment = env as ModelEnvironment;
	return environment.MODEL_GENERATION_ENABLED === 'true'
		&& environment.MODEL_PROVIDER === 'openai'
		&& environment.MODEL_NAME === OPENAI_MODEL
		&& Boolean(environment.OPENAI_API_KEY);
}
