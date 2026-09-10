export const PUBLICATION_STATUSES = [
	'DRAFT',
	'REVIEW',
	'APPROVED',
	'PUBLISHED',
	'REJECTED',
	'ARCHIVED',
] as const;

export type PublicationStatus = (typeof PUBLICATION_STATUSES)[number];

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
