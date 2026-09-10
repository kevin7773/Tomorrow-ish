import { env } from 'cloudflare:workers';
import { D1EditorialRepository } from './d1-editorial-repository';
import type { EditorialRepository } from './editorial-repository';

export function getEditorialRepository(): EditorialRepository {
	return new D1EditorialRepository(env.DB);
}
