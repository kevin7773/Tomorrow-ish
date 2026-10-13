import type {
	AutomatedPublicationAuthorization,
	AutomatedPublicationAuthorizationRepository,
} from './automated-publication-authorization-repository';
import { ROUTINE_GENERATION_POLICY } from '../services/routine-generation-policy';

export class D1AutomatedPublicationAuthorizationRepository
implements AutomatedPublicationAuthorizationRepository {
	constructor(private readonly db: D1Database) {}

	async authorize(record: {
		id: string; auditId: string; storyId: string; imageId: string; batchId: string;
		intakeId: string; actorEmail: string; authorizedAt: string;
	}): Promise<boolean> {
		const results = await this.db.batch([
			this.db.prepare(`INSERT OR IGNORE INTO story_automated_publication_authorizations (
				id, story_id, image_id, batch_id, source_intake_id, candidate_id,
				authorization_scope, story_updated_at, image_reviewed_at, image_asset_key,
				image_alt_text, actor_email, authorized_at
			) SELECT ?, story.id, image.id, item.batch_id, item.source_intake_id, item.candidate_id,
				'SCHEDULED_PUBLICATION_V1', story.updated_at, image.reviewed_at, image.asset_key,
				trim(image.alt_text), ?, ?
			FROM editorial_batch_items AS item
			JOIN stories AS story ON story.id = item.story_id
			JOIN article_images AS image ON image.id = ? AND image.story_id = story.id
			JOIN routine_generation_batch_admissions AS admission ON admission.batch_id = item.batch_id
			WHERE item.batch_id = ? AND item.source_intake_id = ? AND story.id = ?
			  AND item.workflow_state = 'READY_FOR_REVIEW' AND item.candidate_id IS NOT NULL
			  AND story.status = 'APPROVED' AND story.published_at IS NULL
			  AND story.origin_candidate_id = item.candidate_id
			  AND image.status = 'APPROVED' AND image.asset_key = story.og_image_key
			  AND image.reviewed_at IS NOT NULL AND length(trim(image.alt_text)) > 0
			  AND EXISTS (SELECT 1 FROM editorial_workflow_events AS event
				WHERE event.batch_id = item.batch_id AND event.source_intake_id = item.source_intake_id
				AND event.event_kind = 'INTAKE_SELECTED' AND event.detail = ?)
			`).bind(record.id, record.actorEmail, record.authorizedAt, record.imageId,
				record.batchId, record.intakeId, record.storyId, ROUTINE_GENERATION_POLICY),
			this.db.prepare(`INSERT OR IGNORE INTO editorial_audit_log
				(id, actor_email, entity_type, entity_id, action, reason, created_at)
			SELECT ?, actor_email, 'STORY', story_id, 'AUTOMATED_PUBLICATION_AUTHORIZED', id, authorized_at
			FROM story_automated_publication_authorizations WHERE id = ?`)
				.bind(record.auditId, record.id),
		]);
		return results[0].meta.changes === 1 && results[1].meta.changes === 1;
	}

	async findValid(storyId: string): Promise<AutomatedPublicationAuthorization | null> {
		const row = await this.db.prepare(`SELECT authorization.id, authorization.story_id,
			authorization.image_id, authorization.batch_id, authorization.source_intake_id,
			authorization.candidate_id, authorization.actor_email, authorization.authorized_at
			FROM story_automated_publication_authorizations AS authorization
			JOIN stories AS story ON story.id = authorization.story_id
			JOIN article_images AS image ON image.id = authorization.image_id
			JOIN editorial_batch_items AS item
			  ON item.batch_id = authorization.batch_id
			 AND item.source_intake_id = authorization.source_intake_id
			WHERE authorization.story_id = ?
			  AND authorization.authorization_scope = 'SCHEDULED_PUBLICATION_V1'
			  AND story.status = 'APPROVED' AND story.updated_at = authorization.story_updated_at
			  AND story.og_image_key = authorization.image_asset_key
			  AND image.story_id = story.id AND image.status = 'APPROVED'
			  AND image.asset_key = authorization.image_asset_key
			  AND image.reviewed_at = authorization.image_reviewed_at
			  AND trim(image.alt_text) = authorization.image_alt_text
			  AND length(authorization.image_alt_text) > 0
			  AND item.story_id = story.id AND item.candidate_id = authorization.candidate_id
			  AND item.workflow_state = 'READY_FOR_REVIEW'
			ORDER BY authorization.authorized_at DESC LIMIT 1`).bind(storyId).first<{
			id: string; story_id: string; image_id: string; batch_id: string; source_intake_id: string;
			candidate_id: string; actor_email: string; authorized_at: string;
		}>();
		return row ? { id: row.id, storyId: row.story_id, imageId: row.image_id,
			batchId: row.batch_id, intakeId: row.source_intake_id, candidateId: row.candidate_id,
			actorEmail: row.actor_email, authorizedAt: row.authorized_at } : null;
	}
}
