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

function timeZoneOffsetMilliseconds(at: Date): number {
	const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
		timeZone: EDITORIAL_TIME_ZONE,
		timeZoneName: 'longOffset',
		year: 'numeric',
	}).formatToParts(at).map(({ type, value }) => [type, value]));
	const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(parts.timeZoneName ?? '');
	if (!match) throw new RangeError('Unable to resolve the editorial time-zone offset.');
	const magnitude = (Number(match[2]) * 60 + Number(match[3])) * 60_000;
	return match[1] === '-' ? -magnitude : magnitude;
}

function operatingDateStart(operatingDate: string): Date {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(operatingDate)) throw new RangeError('Invalid editorial operating date.');
	const [year, month, day] = operatingDate.split('-').map(Number) as [number, number, number];
	const utcMidnight = new Date(Date.UTC(year, month - 1, day));
	return new Date(utcMidnight.getTime() - timeZoneOffsetMilliseconds(utcMidnight));
}

export function editorialOperatingWindow(timestamp: string): {
	operatingDate: string;
	start: string;
	end: string;
} {
	const operatingDate = editorialDateFromTimestamp(timestamp);
	const start = operatingDateStart(operatingDate);
	const [year, month, day] = operatingDate.split('-').map(Number) as [number, number, number];
	const nextCalendarDate = new Date(Date.UTC(year, month - 1, day + 1));
	const nextOperatingDate = nextCalendarDate.toISOString().slice(0, 10);
	return { operatingDate, start: start.toISOString(), end: operatingDateStart(nextOperatingDate).toISOString() };
}

export function formatEditionDate(editionDate: string): string {
	return editorialDateFormatter.format(new Date(`${editionDate}T12:00:00Z`));
}
