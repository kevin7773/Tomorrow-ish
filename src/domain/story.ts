import type { PublicationStatus } from './publication-status';

export interface StoryCategory {
	id: string;
	slug: string;
	name: string;
}

export interface StorySource {
	id: string;
	title: string;
	url: string;
	publisher: string | null;
	publishedAt: string | null;
}

export interface Story {
	id: string;
	slug: string;
	headline: string;
	deck: string;
	bodyMarkdown: string;
	editionDate: string;
	publishedAt: string;
	category: StoryCategory;
	status: PublicationStatus;
	socialExcerpt: string;
	ogImageKey: string | null;
	tags: string[];
	sources: StorySource[];
}

export interface ArchiveEdition {
	editionDate: string;
	stories: Story[];
}

export function groupStoriesByEdition(stories: Story[]): ArchiveEdition[] {
	const editions = new Map<string, Story[]>();

	for (const story of stories) {
		const group = editions.get(story.editionDate) ?? [];
		group.push(story);
		editions.set(story.editionDate, group);
	}

	return Array.from(editions, ([editionDate, editionStories]) => ({
		editionDate,
		stories: editionStories,
	}));
}

export function storyParagraphs(bodyMarkdown: string): string[] {
	return bodyMarkdown
		.split(/\r?\n\s*\r?\n/)
		.map((paragraph) => paragraph.replace(/\s*\r?\n\s*/g, ' ').trim())
		.filter(Boolean);
}
