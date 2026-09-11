export interface StoredImageAsset {
	key: string;
	contentType: string;
	byteSize: number;
}

export interface ImageAssetStore {
	put(key: string, bytes: ArrayBuffer, contentType: string): Promise<StoredImageAsset>;
	delete(key: string): Promise<void>;
}

export class R2ImageAssetStore implements ImageAssetStore {
	constructor(private readonly bucket: R2Bucket) {}

	async put(key: string, bytes: ArrayBuffer, contentType: string): Promise<StoredImageAsset> {
		await this.bucket.put(key, bytes, {
			httpMetadata: { contentType, cacheControl: 'public, max-age=31536000, immutable' },
		});
		return { key, contentType, byteSize: bytes.byteLength };
	}

	async delete(key: string): Promise<void> {
		await this.bucket.delete(key);
	}
}
