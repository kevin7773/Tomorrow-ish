import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { readCloudflareImageWebhookRequest } from '../../../../images/cloudflare-image-webhook';
import { verifyImageWebhookSignature } from '../../../../images/image-webhook-auth';
import { ImageProviderError } from '../../../../images/image-provider';
import { getAsyncArticleImageService } from '../../../../services/runtime-async-article-image-service';

function response(status: number, state: string): Response {
	return Response.json({ state }, {
		status,
		headers: {
			'Cache-Control': 'no-store',
			'Referrer-Policy': 'no-referrer',
			'X-Robots-Tag': 'noindex, nofollow',
		},
	});
}

export const POST: APIRoute = async ({ params, request, url }) => {
	const imageId = params.imageId ?? '';
	const suppliedSignature = url.searchParams.get('signature') ?? '';
	if (!/^[A-Za-z0-9-]{1,100}$/.test(imageId)
		|| !await verifyImageWebhookSignature(imageId, suppliedSignature, env.IMAGE_WEBHOOK_SECRET)) {
		return response(403, 'rejected');
	}
	let providerRequestId: string | null = null;
	try {
		const callback = await readCloudflareImageWebhookRequest(request);
		providerRequestId = callback.providerRequestId;
		const result = await getAsyncArticleImageService().acceptWebhook(imageId, callback);
		switch (result) {
			case 'processed':
			case 'idempotent':
				return response(200, result);
			case 'deferred':
				return response(202, result);
			case 'unknown':
				return response(404, result);
			case 'conflict':
				return response(409, result);
		}
	} catch (error) {
		if (error instanceof ImageProviderError) return response(400, 'rejected');
		console.error('[image-webhook] processing failed', {
			imageId,
			providerRequestId,
			exceptionName: error instanceof Error ? error.name : 'UnknownError',
		});
		return response(500, 'failed');
	}
};
