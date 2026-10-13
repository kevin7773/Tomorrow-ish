import { D1GovernedPublicationRepository } from '../data/d1-governed-publication-repository';
import {
	automatedPublicationEnabled,
	GovernedAutomatedPublicationService,
} from './governed-automated-publication-service';
import { ROUTINE_AUTOMATION_ACTOR } from './routine-generation-policy';

export interface AutomatedPublicationEnvironment {
	DB: D1Database;
	EDITORIAL_AUTOMATED_PUBLICATION_ENABLED?: string;
	AUTOMATION_ACTOR_EMAIL?: string;
}

export async function runGovernedAutomatedPublication(environment: AutomatedPublicationEnvironment) {
	const report = await new GovernedAutomatedPublicationService(
		new D1GovernedPublicationRepository(environment.DB),
		automatedPublicationEnabled(environment.EDITORIAL_AUTOMATED_PUBLICATION_ENABLED),
		environment.AUTOMATION_ACTOR_EMAIL?.trim().toLowerCase() || ROUTINE_AUTOMATION_ACTOR,
	).process();
	console.log('[governed-automated-publication] processing completed', report);
	return report;
}
