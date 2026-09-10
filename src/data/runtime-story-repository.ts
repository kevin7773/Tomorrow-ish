import { env } from 'cloudflare:workers';
import { createStoryRepository } from './d1-story-repository';
import type { StoryRepository } from './story-repository';

export function getStoryRepository(): StoryRepository {
	return createStoryRepository(env.DB);
}
