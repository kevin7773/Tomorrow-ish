import type { ArticleImage, ArticleImageStatus } from '../domain/article-image';
import type {
	ArticleImageRepository,
	AttachImageSubmission,
	CompletePendingImageGeneration,
	FailPendingImageGeneration,
	ImageWebhookInboxRecord,
	RecordFailedImageGeneration,
	RecordGeneratedImage,
	RecordPendingImageGeneration,
	ReviewImageRecord,
} from './article-image-repository';

interface ArticleImageRow {
	id: string;
	story_id: string;
	provider: string;
	model: string;
	prompt: string;
	aspect_ratio: string;
	provider_request_id: string | null;
	asset_key: string | null;
	content_type: string | null;
	byte_size: number | null;
	status: ArticleImageStatus;
	alt_text: string | null;
	metadata_json: string;
	error_classification: string | null;
	error_message: string | null;
	requested_by_email: string;
	requested_at: string;
	generated_at: string | null;
	reviewed_by_email: string | null;
	reviewed_at: string | null;
}

function parseMetadata(value: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(value);
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
			? parsed as Record<string, unknown>
			: {};
	} catch {
		return {};
	}
}

function mapImage(row: ArticleImageRow): ArticleImage {
	return {
		id: row.id,
		storyId: row.story_id,
		provider: row.provider,
		model: row.model,
		prompt: row.prompt,
		aspectRatio: row.aspect_ratio,
		providerRequestId: row.provider_request_id,
		assetKey: row.asset_key,
		contentType: row.content_type,
		byteSize: row.byte_size,
		status: row.status,
		altText: row.alt_text,
		metadata: parseMetadata(row.metadata_json),
		errorClassification: row.error_classification,
		errorMessage: row.error_message,
		requestedByEmail: row.requested_by_email,
		requestedAt: row.requested_at,
		generatedAt: row.generated_at,
		reviewedByEmail: row.reviewed_by_email,
		reviewedAt: row.reviewed_at,
	};
}

export class D1ArticleImageRepository implements ArticleImageRepository {
	constructor(private readonly db: D1Database) {}

	async listByStory(storyId: string): Promise<ArticleImage[]> {
		const result = await this.db.prepare(`
			SELECT * FROM article_images WHERE story_id = ? ORDER BY requested_at DESC
		`).bind(storyId).all<ArticleImageRow>();
		return result.results.map(mapImage);
	}

	async findById(id: string): Promise<ArticleImage | null> {
		const row = await this.db.prepare('SELECT * FROM article_images WHERE id = ? LIMIT 1')
			.bind(id).first<ArticleImageRow>();
		return row ? mapImage(row) : null;
	}

	async findByProviderRequestId(provider: string, providerRequestId: string): Promise<ArticleImage | null> {
		const row = await this.db.prepare(`
			SELECT * FROM article_images WHERE provider = ? AND provider_request_id = ? LIMIT 1
		`).bind(provider, providerRequestId).first<ArticleImageRow>();
		return row ? mapImage(row) : null;
	}

	async hasPendingForStory(storyId: string): Promise<boolean> {
		const row = await this.db.prepare(`
			SELECT 1 AS present FROM article_images WHERE story_id = ? AND status = 'PENDING' LIMIT 1
		`).bind(storyId).first<{ present: number }>();
		return row?.present === 1;
	}

	async recordGenerated(record: RecordGeneratedImage): Promise<boolean> {
		const results = await this.db.batch([
			this.db.prepare(`
				INSERT INTO article_images (
					id, story_id, provider, model, prompt, prompt_version, aspect_ratio,
					provider_request_id, asset_key, content_type, byte_size, status, alt_text,
					metadata_json, requested_by_email, requested_at, generated_at
				)
				SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'GENERATED', ?, ?, ?, ?, ?
				WHERE EXISTS (SELECT 1 FROM stories WHERE id = ?)
			`).bind(
				record.id, record.storyId, record.provider, record.model, record.prompt,
				record.promptVersion, record.aspectRatio, record.providerRequestId, record.assetKey,
				record.contentType, record.byteSize, record.altText, JSON.stringify(record.metadata),
				record.requestedByEmail, record.requestedAt, record.generatedAt, record.storyId,
			),
			this.db.prepare(`
				INSERT INTO editorial_audit_log (id, actor_email, entity_type, entity_id, action, reason, created_at)
				SELECT ?, ?, 'STORY', ?, 'IMAGE_GENERATED', ?, ?
				WHERE EXISTS (SELECT 1 FROM article_images WHERE id = ? AND status = 'GENERATED')
			`).bind(record.auditId, record.requestedByEmail, record.storyId, record.id, record.generatedAt, record.id),
		]);
		return results[0].meta.changes === 1 && results[1].meta.changes === 1;
	}

	async recordFailure(record: RecordFailedImageGeneration): Promise<boolean> {
		const results = await this.db.batch([
			this.db.prepare(`
				INSERT INTO article_images (
					id, story_id, provider, model, prompt, prompt_version, aspect_ratio,
					provider_request_id, status, metadata_json, error_classification, error_message,
					requested_by_email, requested_at
				)
				SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'GENERATION_FAILED', ?, ?, ?, ?, ?
				WHERE EXISTS (SELECT 1 FROM stories WHERE id = ?)
			`).bind(
				record.id, record.storyId, record.provider, record.model, record.prompt,
				record.promptVersion, record.aspectRatio, record.providerRequestId,
				JSON.stringify(record.metadata), record.errorClassification, record.errorMessage,
				record.requestedByEmail, record.requestedAt, record.storyId,
			),
			this.db.prepare(`
				INSERT INTO editorial_audit_log (id, actor_email, entity_type, entity_id, action, reason, created_at)
				SELECT ?, ?, 'STORY', ?, 'IMAGE_GENERATION_FAILED', ?, ?
				WHERE EXISTS (SELECT 1 FROM article_images WHERE id = ? AND status = 'GENERATION_FAILED')
			`).bind(record.auditId, record.requestedByEmail, record.storyId, record.errorClassification, record.requestedAt, record.id),
		]);
		return results[0].meta.changes === 1 && results[1].meta.changes === 1;
	}

	async recordPending(record: RecordPendingImageGeneration): Promise<boolean> {
		const results = await this.db.batch([
			this.db.prepare(`
				INSERT INTO article_images (
					id, story_id, provider, model, prompt, prompt_version, aspect_ratio,
					status, alt_text, metadata_json, requested_by_email, requested_at
				)
				SELECT ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, '{}', ?, ?
				WHERE EXISTS (SELECT 1 FROM stories WHERE id = ? AND status = 'APPROVED')
				  AND NOT EXISTS (
					SELECT 1 FROM article_images WHERE story_id = ? AND status = 'PENDING'
				  )
			`).bind(
				record.id, record.storyId, record.provider, record.model, record.prompt,
				record.promptVersion, record.aspectRatio, record.altText,
				record.requestedByEmail, record.requestedAt, record.storyId, record.storyId,
			),
			this.db.prepare(`
				INSERT INTO editorial_audit_log (id, actor_email, entity_type, entity_id, action, reason, created_at)
				SELECT ?, ?, 'STORY', ?, 'IMAGE_GENERATION_REQUESTED', ?, ?
				WHERE EXISTS (SELECT 1 FROM article_images WHERE id = ? AND status = 'PENDING')
			`).bind(record.auditId, record.requestedByEmail, record.storyId, record.id, record.requestedAt, record.id),
		]);
		return results[0].meta.changes === 1 && results[1].meta.changes === 1;
	}

	async attachSubmission(record: AttachImageSubmission): Promise<boolean> {
		const results = await this.db.batch([
			this.db.prepare(`
				UPDATE article_images
				SET provider_request_id = ?, metadata_json = ?
				WHERE id = ? AND status = 'PENDING' AND provider_request_id IS NULL
			`).bind(record.providerRequestId, JSON.stringify(record.metadata), record.imageId),
			this.db.prepare(`
				INSERT INTO editorial_audit_log (id, actor_email, entity_type, entity_id, action, reason, created_at)
				SELECT ?, requested_by_email, 'STORY', story_id, 'IMAGE_GENERATION_SUBMITTED', ?, ?
				FROM article_images
				WHERE id = ? AND status = 'PENDING' AND provider_request_id = ?
			`).bind(record.auditId, record.providerRequestId, record.submittedAt, record.imageId, record.providerRequestId),
		]);
		return results[0].meta.changes === 1 && results[1].meta.changes === 1;
	}

	async completePending(record: CompletePendingImageGeneration): Promise<boolean> {
		const results = await this.db.batch([
			this.db.prepare(`
				UPDATE article_images
				SET status = 'GENERATED', asset_key = ?, content_type = ?, byte_size = ?,
					metadata_json = ?, generated_at = ?
				WHERE id = ? AND status = 'PENDING' AND provider_request_id = ?
			`).bind(
				record.assetKey, record.contentType, record.byteSize, JSON.stringify(record.metadata),
				record.generatedAt, record.imageId, record.providerRequestId,
			),
			this.db.prepare(`
				INSERT INTO editorial_audit_log (id, actor_email, entity_type, entity_id, action, reason, created_at)
				SELECT ?, requested_by_email, 'STORY', story_id, 'IMAGE_GENERATED', ?, ?
				FROM article_images
				WHERE id = ? AND status = 'GENERATED' AND provider_request_id = ?
			`).bind(record.auditId, record.imageId, record.generatedAt, record.imageId, record.providerRequestId),
		]);
		return results[0].meta.changes === 1 && results[1].meta.changes === 1;
	}

	async failPending(record: FailPendingImageGeneration): Promise<boolean> {
		const results = await this.db.batch([
			this.db.prepare(`
				UPDATE article_images
				SET status = 'GENERATION_FAILED', provider_request_id = COALESCE(provider_request_id, ?),
					metadata_json = ?, error_classification = ?, error_message = ?
				WHERE id = ? AND status = 'PENDING'
				  AND (? IS NULL OR provider_request_id = ? OR provider_request_id IS NULL)
			`).bind(
				record.providerRequestId, JSON.stringify(record.metadata), record.errorClassification, record.errorMessage,
				record.imageId, record.providerRequestId, record.providerRequestId,
			),
			this.db.prepare(`
				INSERT INTO editorial_audit_log (id, actor_email, entity_type, entity_id, action, reason, created_at)
				SELECT ?, COALESCE(?, requested_by_email), 'STORY', story_id, 'IMAGE_GENERATION_FAILED', ?, ?
				FROM article_images WHERE id = ? AND status = 'GENERATION_FAILED'
			`).bind(record.auditId, record.actorEmail ?? null, record.errorClassification, record.failedAt, record.imageId),
		]);
		return results[0].meta.changes === 1 && results[1].meta.changes === 1;
	}

	async recordWebhook(record: Omit<ImageWebhookInboxRecord, 'processingState'>): Promise<'created' | 'duplicate' | 'conflict'> {
		const result = await this.db.prepare(`
			INSERT OR IGNORE INTO article_image_webhook_inbox (
				image_id, provider_request_id, outcome, result_url, metadata_json,
				error_classification, error_message, received_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`).bind(
			record.imageId, record.providerRequestId, record.outcome, record.resultUrl,
			JSON.stringify(record.metadata), record.errorClassification, record.errorMessage, record.receivedAt,
		).run();
		if (result.meta.changes === 1) return 'created';
		const existing = await this.findWebhook(record.imageId);
		return existing
			&& existing.providerRequestId === record.providerRequestId
			&& existing.outcome === record.outcome
			&& existing.resultUrl === record.resultUrl
			? 'duplicate'
			: 'conflict';
	}

	async findWebhook(imageId: string): Promise<ImageWebhookInboxRecord | null> {
		const row = await this.db.prepare(`
			SELECT image_id, provider_request_id, outcome, result_url, metadata_json,
				error_classification, error_message, received_at, processing_state
			FROM article_image_webhook_inbox WHERE image_id = ? LIMIT 1
		`).bind(imageId).first<{
			image_id: string; provider_request_id: string; outcome: 'SUCCESS' | 'FAILURE';
			result_url: string | null; metadata_json: string; error_classification: string | null;
			error_message: string | null; received_at: string; processing_state: ImageWebhookInboxRecord['processingState'];
		}>();
		return row ? {
			imageId: row.image_id,
			providerRequestId: row.provider_request_id,
			outcome: row.outcome,
			resultUrl: row.result_url,
			metadata: parseMetadata(row.metadata_json),
			errorClassification: row.error_classification,
			errorMessage: row.error_message,
			receivedAt: row.received_at,
			processingState: row.processing_state,
		} : null;
	}

	async claimWebhook(imageId: string, providerRequestId: string): Promise<boolean> {
		const result = await this.db.prepare(`
			UPDATE article_image_webhook_inbox SET processing_state = 'PROCESSING'
			WHERE image_id = ? AND provider_request_id = ? AND processing_state = 'RECEIVED'
		`).bind(imageId, providerRequestId).run();
		return result.meta.changes === 1;
	}

	async releaseWebhook(imageId: string, providerRequestId: string): Promise<void> {
		await this.db.prepare(`
			UPDATE article_image_webhook_inbox SET processing_state = 'RECEIVED'
			WHERE image_id = ? AND provider_request_id = ? AND processing_state = 'PROCESSING'
		`).bind(imageId, providerRequestId).run();
	}

	async markWebhookProcessed(imageId: string, providerRequestId: string): Promise<void> {
		await this.db.prepare(`
			UPDATE article_image_webhook_inbox
			SET processing_state = 'PROCESSED', result_url = NULL
			WHERE image_id = ? AND provider_request_id = ? AND processing_state IN ('RECEIVED', 'PROCESSING')
		`).bind(imageId, providerRequestId).run();
	}

	async approve(record: ReviewImageRecord): Promise<boolean> {
		const results = await this.db.batch([
			this.db.prepare(`
				UPDATE article_images SET status = 'APPROVED', alt_text = ?, reviewed_by_email = ?, reviewed_at = ?
				WHERE id = ? AND story_id = ? AND status = 'GENERATED'
				AND asset_key IS NOT NULL
				AND EXISTS (SELECT 1 FROM stories WHERE id = ? AND status = 'APPROVED')
			`).bind(record.altText, record.actorEmail, record.reviewedAt, record.imageId, record.storyId, record.storyId),
			this.db.prepare(`
				UPDATE stories SET og_image_key = (
					SELECT asset_key FROM article_images WHERE id = ? AND story_id = ? AND status = 'APPROVED'
				), updated_at = ?
				WHERE id = ? AND status = 'APPROVED'
				AND EXISTS (SELECT 1 FROM article_images WHERE id = ? AND story_id = ? AND status = 'APPROVED')
			`).bind(record.imageId, record.storyId, record.reviewedAt, record.storyId, record.imageId, record.storyId),
			this.db.prepare(`
				INSERT INTO editorial_audit_log (id, actor_email, entity_type, entity_id, action, reason, created_at)
				SELECT ?, ?, 'STORY', ?, 'IMAGE_APPROVED', ?, ?
				WHERE EXISTS (SELECT 1 FROM article_images WHERE id = ? AND status = 'APPROVED')
			`).bind(record.auditId, record.actorEmail, record.storyId, record.imageId, record.reviewedAt, record.imageId),
		]);
		return results.every((result) => result.meta.changes === 1);
	}

	async transition(record: ReviewImageRecord & { from: ArticleImageStatus; to: ArticleImageStatus }): Promise<boolean> {
		const results = await this.db.batch([
			this.db.prepare(`
				UPDATE article_images SET status = ?, reviewed_by_email = ?, reviewed_at = ?
				WHERE id = ? AND story_id = ? AND status = ?
				AND NOT EXISTS (SELECT 1 FROM stories WHERE id = ? AND og_image_key = article_images.asset_key)
			`).bind(record.to, record.actorEmail, record.reviewedAt, record.imageId, record.storyId, record.from, record.storyId),
			this.db.prepare(`
				INSERT INTO editorial_audit_log (id, actor_email, entity_type, entity_id, action, reason, created_at)
				SELECT ?, ?, 'STORY', ?, ?, ?, ?
				WHERE EXISTS (SELECT 1 FROM article_images WHERE id = ? AND status = ?)
			`).bind(record.auditId, record.actorEmail, record.storyId, `IMAGE_${record.to}`, record.imageId, record.reviewedAt, record.imageId, record.to),
		]);
		return results[0].meta.changes === 1 && results[1].meta.changes === 1;
	}
}
