import type { Story, StoryCategory } from '../domain/story';

export interface PublishedStoryQuery {
	excludeId?: string;
	categorySlug?: string;
	limit?: number;
}

export interface StoryRepository {
	findPublishedBySlug(slug: string): Promise<Story | null>;
	getLeadStory(): Promise<Story | null>;
	listCategories(): Promise<StoryCategory[]>;
	findCategoryBySlug(slug: string): Promise<StoryCategory | null>;
	listPublished(options?: PublishedStoryQuery): Promise<Story[]>;
}
