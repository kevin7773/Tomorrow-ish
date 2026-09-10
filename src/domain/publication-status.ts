export const PUBLICATION_STATUSES = [
	'DRAFT',
	'REVIEW',
	'APPROVED',
	'PUBLISHED',
	'REJECTED',
	'ARCHIVED',
] as const;

export type PublicationStatus = (typeof PUBLICATION_STATUSES)[number];
export type NonPublishingStatus = Exclude<PublicationStatus, 'PUBLISHED'>;

const transitions: Readonly<Record<PublicationStatus, readonly PublicationStatus[]>> = {
	DRAFT: ['REVIEW', 'REJECTED'],
	REVIEW: ['DRAFT', 'APPROVED', 'REJECTED'],
	APPROVED: ['REVIEW', 'PUBLISHED', 'REJECTED'],
	PUBLISHED: ['ARCHIVED'],
	REJECTED: ['DRAFT'],
	ARCHIVED: [],
};

export function canTransitionPublication(
	from: PublicationStatus,
	to: PublicationStatus,
): boolean {
	return transitions[from].includes(to);
}

export function isPublicationStatus(value: unknown): value is PublicationStatus {
	return (
		typeof value === 'string' &&
		PUBLICATION_STATUSES.includes(value as PublicationStatus)
	);
}

export function isNonPublishingStatus(value: unknown): value is NonPublishingStatus {
	return isPublicationStatus(value) && value !== 'PUBLISHED';
}
