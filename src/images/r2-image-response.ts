export async function imageResponse(bucket: R2Bucket, key: string): Promise<Response> {
	if (!/^article-images\/[a-zA-Z0-9-]+\/[a-zA-Z0-9-]+\.(?:webp|png|jpg)$/.test(key)) {
		return new Response('Not found', { status: 404 });
	}
	const object = await bucket.get(key);
	if (!object) return new Response('Not found', { status: 404 });
	const headers = new Headers();
	object.writeHttpMetadata(headers);
	headers.set('ETag', object.httpEtag);
	headers.set('X-Content-Type-Options', 'nosniff');
	return new Response(object.body, { headers });
}
