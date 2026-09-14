export const EDITORIAL_TIME_ZONE = 'America/New_York';

const editorialDateFormatter = new Intl.DateTimeFormat('en-US', {
	timeZone: EDITORIAL_TIME_ZONE,
	weekday: 'long',
	year: 'numeric',
	month: 'long',
	day: 'numeric',
});

const editorialDatePartsFormatter = new Intl.DateTimeFormat('en-US', {
	timeZone: EDITORIAL_TIME_ZONE,
	year: 'numeric',
	month: '2-digit',
	day: '2-digit',
});

export function editorialDateFromTimestamp(timestamp: string): string {
	const date = new Date(timestamp);
	if (Number.isNaN(date.valueOf())) throw new RangeError('Invalid publication timestamp.');
	const parts = Object.fromEntries(
		editorialDatePartsFormatter.formatToParts(date).map(({ type, value }) => [type, value]),
	);
	return `${parts.year}-${parts.month}-${parts.day}`;
}

export function formatEditionDate(editionDate: string): string {
	return editorialDateFormatter.format(new Date(`${editionDate}T12:00:00Z`));
}
