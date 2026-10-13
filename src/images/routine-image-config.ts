export interface RoutineImagePreparationEnvironment {
	EDITORIAL_ROUTINE_IMAGE_PREPARATION_ENABLED?: string;
	IMAGE_ATTEMPT_BUDGET_MICRO_USD?: string;
	IMAGE_BATCH_BUDGET_MICRO_USD?: string;
	IMAGE_DAILY_BUDGET_MICRO_USD?: string;
}

export interface RoutineImagePreparationConfig {
	enabled: boolean;
	attemptMaxMicrousd: number;
	batchMaxMicrousd: number;
	dailyMaxMicrousd: number;
}

function gate(value: string | undefined): boolean {
	if (value === undefined || value === '' || value === 'false') return false;
	if (value === 'true') return true;
	throw new Error('EDITORIAL_ROUTINE_IMAGE_PREPARATION_ENABLED must be true or false.');
}

function ceiling(value: string | undefined, name: string): number {
	const parsed = Number(value);
	if (!value || !Number.isSafeInteger(parsed) || parsed <= 0) {
		throw new Error(`${name} must be a positive integer when routine image preparation is enabled.`);
	}
	return parsed;
}

export function routineImagePreparationConfig(
	environment: RoutineImagePreparationEnvironment,
): RoutineImagePreparationConfig {
	const enabled = gate(environment.EDITORIAL_ROUTINE_IMAGE_PREPARATION_ENABLED);
	if (!enabled) return { enabled: false, attemptMaxMicrousd: 0, batchMaxMicrousd: 0, dailyMaxMicrousd: 0 };
	const config = {
		enabled,
		attemptMaxMicrousd: ceiling(environment.IMAGE_ATTEMPT_BUDGET_MICRO_USD, 'IMAGE_ATTEMPT_BUDGET_MICRO_USD'),
		batchMaxMicrousd: ceiling(environment.IMAGE_BATCH_BUDGET_MICRO_USD, 'IMAGE_BATCH_BUDGET_MICRO_USD'),
		dailyMaxMicrousd: ceiling(environment.IMAGE_DAILY_BUDGET_MICRO_USD, 'IMAGE_DAILY_BUDGET_MICRO_USD'),
	};
	if (config.attemptMaxMicrousd !== 50_000 || config.batchMaxMicrousd !== 150_000
		|| config.dailyMaxMicrousd !== 150_000) {
		throw new Error('Routine image ceilings must be exactly 50,000 per attempt and 150,000 per batch/day.');
	}
	return config;
}
