import { env } from 'cloudflare:workers';
import { FakeModelProvider } from './fake-model-provider';
import type { ModelProviderAccess } from './model-provider';
import { ModelProviderError } from './model-provider';
import { estimateOpenAIMaximumCostMicrousd, OpenAIModelProvider, OPENAI_MODEL } from './openai-model-provider';
import type { ModelBudgetLimits } from '../data/generation-repository';
import { parseModelBudgetLimits, strictConfigurationBoolean, type ModelBudgetEnvironment } from './model-budget-config';

export interface ModelEnvironment extends ModelBudgetEnvironment {
	MODEL_PROVIDER?: string;
	MODEL_NAME?: string;
	MODEL_GENERATION_ENABLED?: string;
	OPENAI_API_KEY?: string;
}

export interface RuntimeModelConfiguration {
	providerAccess: ModelProviderAccess;
	budgetLimits: ModelBudgetLimits;
	generationEnabled: boolean;
}

export function createRuntimeModelConfiguration(
	environment: ModelEnvironment,
	options: { development?: boolean; transport?: typeof fetch } = {},
): RuntimeModelConfiguration {
	const generationEnabled = options.development
		? true
		: strictConfigurationBoolean(environment.MODEL_GENERATION_ENABLED, 'MODEL_GENERATION_ENABLED');
	const budgetLimits: ModelBudgetLimits = parseModelBudgetLimits(environment);
	if (options.development) {
		const provider = new FakeModelProvider();
		return {
			providerAccess: {
				providerId: provider.providerId,
				modelId: provider.modelId,
				estimateMaximumCostMicrousd: (operation) => provider.estimateMaximumCostMicrousd(operation),
				createProvider: () => provider,
			},
			budgetLimits,
			generationEnabled,
		};
	}
	const providerConfigured = environment.MODEL_PROVIDER === 'openai'
		&& environment.MODEL_NAME === OPENAI_MODEL && Boolean(environment.OPENAI_API_KEY);
	if (generationEnabled && !providerConfigured) throw new ModelProviderError('PROVIDER_CONFIGURATION', false);
	return {
		providerAccess: {
			providerId: environment.MODEL_PROVIDER ?? 'disabled',
			modelId: environment.MODEL_NAME ?? 'not-configured',
			estimateMaximumCostMicrousd: estimateOpenAIMaximumCostMicrousd,
			createProvider: () => {
				if (!generationEnabled || !providerConfigured) {
					throw new ModelProviderError('PROVIDER_DISABLED', false, 'Model generation is disabled.');
				}
				return new OpenAIModelProvider(environment.OPENAI_API_KEY!, environment.MODEL_NAME!, options.transport);
			},
		},
		budgetLimits,
		generationEnabled,
	};
}

export function getRuntimeModelConfiguration(): RuntimeModelConfiguration {
	return createRuntimeModelConfiguration(env as ModelEnvironment, { development: import.meta.env.DEV });
}

export function isRuntimeModelGenerationAvailable(): boolean {
	if (import.meta.env.DEV) return true;
	const environment = env as ModelEnvironment;
	try {
		return environment.MODEL_GENERATION_ENABLED === 'true'
			&& parseModelBudgetLimits(environment).enabled
			&& environment.MODEL_PROVIDER === 'openai'
			&& environment.MODEL_NAME === OPENAI_MODEL
			&& Boolean(environment.OPENAI_API_KEY);
	} catch {
		return false;
	}
}
