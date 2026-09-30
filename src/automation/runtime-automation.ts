import type { ModelEnvironment } from '../ai/runtime-model-provider';
import { D1AutomationRepository } from '../data/d1-automation-repository';
import type { AutomationReport, AutomationTrigger } from '../domain/automation';
import { AutomationService } from './automation-service';
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

export async function runRuntimeAutomation(
	environment: AutomationEnvironment,
	input: { trigger: AutomationTrigger; dryRun: boolean; maxItems?: number },
	actorOverride?: string,
): Promise<AutomationReport> {
	const repository = new D1AutomationRepository(environment.DB);
	const service = new AutomationService(
		repository,
		automationSourceProvider(environment.AUTOMATION_SOURCE_URL ?? ''),
		{
			enabled: environment.AUTOMATION_ENABLED === 'true',
			maxItemsPerRun: maxItems(environment.AUTOMATION_MAX_ITEMS_PER_RUN),
			actorEmail: actorOverride ?? environment.AUTOMATION_ACTOR_EMAIL ?? 'automation@tomorrow-ish.news',
		},
	);
	return service.run(input);
}
