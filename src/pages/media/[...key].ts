import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { imageResponse } from '../../images/r2-image-response';

export const GET: APIRoute = async ({ params }) => {
	const key = params.key ?? '';
	const published = await env.DB.prepare(`
		SELECT 1 FROM stories WHERE status = 'PUBLISHED' AND og_image_key = ? LIMIT 1
	`).bind(key).first();
	if (!published) return new Response('Not found', { status: 404 });
	return imageResponse(env.IMAGE_ASSETS, key);
};
