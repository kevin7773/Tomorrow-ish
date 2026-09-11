import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { imageResponse } from '../../../images/r2-image-response';

export const GET: APIRoute = async ({ params }) => imageResponse(env.IMAGE_ASSETS, params.key ?? '');
