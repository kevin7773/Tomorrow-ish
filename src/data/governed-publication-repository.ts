export interface PublicationClaim {
	id: string;
	storyId: string;
	batchId: string;
	intakeId: string;
	candidateId: string;
	owner: string;
	actorEmail: string;
	leaseExpiresAt: string;
}

export interface GovernedPublicationRepository {
	claimNext(record: {
		owner: string; actorEmail: string; at: string; leaseExpiresAt: string;
		createId: () => string;
	}): Promise<PublicationClaim | null>;
	publish(claim: PublicationClaim, at: string): Promise<boolean>;
}
