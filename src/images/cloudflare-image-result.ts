import { ImageProviderError } from './image-provider';

export const MAX_ARTICLE_IMAGE_BYTES = 12 * 1024 * 1024;

export interface ValidatedCloudflareImage {
	bytes: ArrayBuffer;
	contentType: 'image/webp';
	fileExtension: 'webp';
	byteSize: number;
	width: number;
	height: number;
}

function resultUrl(value: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new ImageProviderError('Cloudflare returned an invalid image URL.', 'PROVIDER_INVALID_OUTPUT');
	}
	if (
		url.protocol !== 'https:' || url.username || url.password || url.port
		|| !url.hostname.endsWith('.r2.dev') || url.hostname === 'r2.dev'
	) {
		throw new ImageProviderError('Cloudflare returned an untrusted image URL.', 'PROVIDER_INVALID_OUTPUT');
	}
	return url;
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
	return String.fromCharCode(...bytes.subarray(start, start + length));
}

function webpDimensions(bytes: Uint8Array): { width: number; height: number } | null {
	if (bytes.length < 30) return null;
	const chunk = ascii(bytes, 12, 4);
	if (chunk === 'VP8X') {
		return {
			width: 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16),
			height: 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16),
		};
	}
	if (chunk === 'VP8L' && bytes[20] === 0x2f && bytes.length >= 25) {
		return {
			width: 1 + bytes[21] + ((bytes[22] & 0x3f) << 8),
			height: 1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10),
		};
	}
	if (
		chunk === 'VP8 ' && bytes.length >= 30
		&& bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a
	) {
		return {
			width: (bytes[26] | (bytes[27] << 8)) & 0x3fff,
			height: (bytes[28] | (bytes[29] << 8)) & 0x3fff,
		};
	}
	return null;
}

async function readBounded(response: Response): Promise<ArrayBuffer> {
	if (!response.body) throw new ImageProviderError('Cloudflare returned an empty image response.', 'PROVIDER_INVALID_OUTPUT');
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > MAX_ARTICLE_IMAGE_BYTES) {
				await reader.cancel();
				throw new ImageProviderError('Cloudflare returned an oversized image.', 'PROVIDER_INVALID_OUTPUT');
			}
			chunks.push(value);
		}
	} catch (error) {
		if (error instanceof ImageProviderError) throw error;
		throw new ImageProviderError('Cloudflare image download failed.', 'PROVIDER_REQUEST');
	}
	if (total === 0) throw new ImageProviderError('Cloudflare returned an empty image.', 'PROVIDER_INVALID_OUTPUT');
	const combined = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		combined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return combined.buffer;
}

export async function downloadCloudflareImage(
	value: string,
	fetcher: typeof fetch = fetch,
): Promise<ValidatedCloudflareImage> {
	const url = resultUrl(value);
	let response: Response;
	try {
		response = await fetcher(url, {
			method: 'GET',
			redirect: 'error',
			signal: AbortSignal.timeout(30_000),
		});
	} catch {
		throw new ImageProviderError('Cloudflare image download failed.', 'PROVIDER_REQUEST');
	}
	if (!response.ok) {
		throw new ImageProviderError('Cloudflare image download was rejected.', 'PROVIDER_REQUEST', null, {
			httpStatus: response.status,
		});
	}
	const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
	if (contentType !== 'image/webp') {
		throw new ImageProviderError('Cloudflare returned an unexpected image type.', 'PROVIDER_INVALID_OUTPUT');
	}
	const declaredLength = Number(response.headers.get('content-length'));
	if (Number.isFinite(declaredLength) && declaredLength > MAX_ARTICLE_IMAGE_BYTES) {
		await response.body?.cancel();
		throw new ImageProviderError('Cloudflare returned an oversized image.', 'PROVIDER_INVALID_OUTPUT');
	}
	const bytes = await readBounded(response);
	const view = new Uint8Array(bytes);
	if (view.length < 12 || ascii(view, 0, 4) !== 'RIFF' || ascii(view, 8, 4) !== 'WEBP') {
		throw new ImageProviderError('Cloudflare returned an invalid WebP image.', 'PROVIDER_INVALID_OUTPUT');
	}
	const dimensions = webpDimensions(view);
	if (!dimensions || dimensions.width !== 1536 || dimensions.height !== 1024) {
		throw new ImageProviderError('Cloudflare returned unexpected image dimensions.', 'PROVIDER_INVALID_OUTPUT');
	}
	return {
		bytes,
		contentType: 'image/webp',
		fileExtension: 'webp',
		byteSize: bytes.byteLength,
		...dimensions,
	};
}
