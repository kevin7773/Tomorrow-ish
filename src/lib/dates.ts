const editorialDateFormatter = new Intl.DateTimeFormat('en-US', {
	timeZone: 'America/New_York',
	weekday: 'long',
	year: 'numeric',
	month: 'long',
	day: 'numeric',
});

export function formatEditionDate(editionDate: string): string {
	return editorialDateFormatter.format(new Date(`${editionDate}T12:00:00-04:00`));
}
