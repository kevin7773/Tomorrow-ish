import { env } from 'cloudflare:workers';
import { D1EditorialWorkflowRepository } from './d1-editorial-workflow-repository';

export function getEditorialWorkflowRepository(): D1EditorialWorkflowRepository {
	return new D1EditorialWorkflowRepository(env.DB);
}
