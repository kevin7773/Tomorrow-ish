import type { Story } from '../domain/story';

export interface StoryRepository {
	findPublishedBySlug(slug: string): Promise<Story | null>;
	getLeadStory(): Promise<Story | null>;
	listPublished(options?: { excludeId?: string; limit?: number }): Promise<Story[]>;
}
