export interface RoutineBatchAdmissionRepository {
	admit(record: {
		operatingDate: string;
		timeZone: 'America/New_York';
		batchNotBefore: string;
		actorEmail: string;
		admittedAt: string;
	}): Promise<string | null>;
}
