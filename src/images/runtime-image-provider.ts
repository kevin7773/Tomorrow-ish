import { env } from 'cloudflare:workers';
import type { ImageProvider } from './image-provider';
import { createImageProvider } from './image-provider-factory';

export function getImageProvider(): ImageProvider {
	return createImageProvider(env);
}
