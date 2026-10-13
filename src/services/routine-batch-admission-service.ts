import type { RoutineBatchAdmissionRepository } from '../data/routine-batch-admission-repository';
import { editorialDateFromTimestamp } from '../lib/dates';
import { ROUTINE_AUTOMATION_ACTOR } from './routine-generation-policy';

export const ROUTINE_OPERATING_TIME_ZONE = 'America/New_York' as const;

export interface RoutineBatchAdmissionPort {
	admit(at: string): Promise<string | null>;
}

export function routineOperatingDate(at: string): string {
	try {
		return editorialDateFromTimestamp(at);
	} catch {
		throw new Error('Routine admission timestamp is invalid.');
	}
}

function activationBoundary(value: string | undefined): string {
	const candidate = value?.trim() ?? '';
	if (!candidate || Number.isNaN(Date.parse(candidate)) || !candidate.endsWith('Z')) {
		throw new Error('EDITORIAL_ROUTINE_GENERATION_NOT_BEFORE must be an explicit UTC timestamp.');
	}
	return new Date(candidate).toISOString();
}

export class RoutineBatchAdmissionService implements RoutineBatchAdmissionPort {
	constructor(
		private readonly repository: RoutineBatchAdmissionRepository,
		private readonly notBefore: string | undefined,
		private readonly actorEmail = ROUTINE_AUTOMATION_ACTOR,
	) {}

	admit(at: string): Promise<string | null> {
		return this.repository.admit({
			operatingDate: routineOperatingDate(at),
			timeZone: ROUTINE_OPERATING_TIME_ZONE,
			batchNotBefore: activationBoundary(this.notBefore),
			actorEmail: this.actorEmail,
			admittedAt: at,
		});
	}
}
