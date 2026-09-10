import { env } from 'cloudflare:workers';
import { D1GenerationRepository } from './d1-generation-repository';
import type { GenerationRepository } from './generation-repository';

export function getGenerationRepository(): GenerationRepository {
	return new D1GenerationRepository(env.DB);
}
