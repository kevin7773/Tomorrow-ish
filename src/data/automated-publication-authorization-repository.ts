export interface AutomatedPublicationAuthorization {
	id: string;
	storyId: string;
	imageId: string;
	batchId: string;
	intakeId: string;
	candidateId: string;
	actorEmail: string;
	authorizedAt: string;
}

export interface AutomatedPublicationAuthorizationRepository {
	authorize(record: {
		id: string;
		auditId: string;
		storyId: string;
		imageId: string;
		batchId: string;
		intakeId: string;
		actorEmail: string;
		authorizedAt: string;
	}): Promise<boolean>;
	findValid(storyId: string): Promise<AutomatedPublicationAuthorization | null>;
}
