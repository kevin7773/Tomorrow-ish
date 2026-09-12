import { createRuntimeModelConfiguration, type ModelEnvironment } from '../ai/runtime-model-provider';
import { D1AutomationRepository } from '../data/d1-automation-repository';
import { D1GenerationRepository } from '../data/d1-generation-repository';
import type { AutomationReport, AutomationTrigger } from '../domain/automation';
import { GenerationService } from '../services/generation-service';
import { AutomationService, type CandidateGenerationPort } from './automation-service';
import { automationSourceProvider } from './governed-source-provider';

export interface AutomationEnvironment extends ModelEnvironment {
	DB: D1Database;
	AUTOMATION_ENABLED?: string;
	AUTOMATION_SOURCE_URL?: string;
	AUTOMATION_MAX_ITEMS_PER_RUN?: string;
	AUTOMATION_ACTOR_EMAIL?: string;
}

function maxItems(value: string | undefined): number {
	const parsed = Number(value ?? '3');
	return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 20 ? parsed : 3;
}

function candidatePort(environment: AutomationEnvironment): CandidateGenerationPort {
	const repository = new D1GenerationRepository(environment.DB);
	return {
		async generate(input) {
			const existing = await repository.findModelRunByIdempotencyKey(input.idempotencyKey);
			if (existing) return { runId: existing.id, status: existing.status };
			const model = createRuntimeModelConfiguration(environment);
			const service = new GenerationService(repository, model.provider, {
				dailyBudgetMicrousd: model.dailyBudgetMicrousd,
				generationEnabled: model.generationEnabled,
			});
			try {
				const runId = await service.generateCandidates({ email: input.actorEmail }, {
					intakeId: input.intakeId,
					normalizedEventVersionId: input.normalizedEventVersionId,
					categoryId: input.categoryId,
					idempotencyKey: input.idempotencyKey,
				});
				const run = await repository.findModelRun(runId);
				return { runId, status: run?.status ?? 'FAILED' };
			} catch (error) {
				const failed = await repository.findModelRunByIdempotencyKey(input.idempotencyKey);
				if (failed) return { runId: failed.id, status: failed.status };
				throw error;
			}
		},
	};
}

export async function runRuntimeAutomation(
	environment: AutomationEnvironment,
	input: { trigger: AutomationTrigger; dryRun: boolean; maxItems?: number },
	actorOverride?: string,
): Promise<AutomationReport> {
	const repository = new D1AutomationRepository(environment.DB);
	const service = new AutomationService(
		repository,
		automationSourceProvider(environment.AUTOMATION_SOURCE_URL ?? ''),
		candidatePort(environment),
		{
			enabled: environment.AUTOMATION_ENABLED === 'true',
			maxItemsPerRun: maxItems(environment.AUTOMATION_MAX_ITEMS_PER_RUN),
			actorEmail: actorOverride ?? environment.AUTOMATION_ACTOR_EMAIL ?? 'automation@tomorrow-ish.news',
		},
	);
	return service.run(input);
}
