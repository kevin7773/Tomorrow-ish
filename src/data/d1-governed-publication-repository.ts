import type { GovernedPublicationRepository, PublicationClaim } from './governed-publication-repository';
import { ROUTINE_GENERATION_POLICY } from '../services/routine-generation-policy';

interface CandidateRow {
	story_id: string;
	batch_id: string;
	source_intake_id: string;
	candidate_id: string;
	authorization_id: string;
}

export class D1GovernedPublicationRepository implements GovernedPublicationRepository {
	constructor(private readonly db: D1Database) {}

	async claimNext(record: {
		owner: string; actorEmail: string; at: string; leaseExpiresAt: string; createId: () => string;
	}): Promise<PublicationClaim | null> {
		const candidates = await this.db.prepare(`SELECT story.id AS story_id, item.batch_id,
			item.source_intake_id, item.candidate_id,
			(SELECT authorization.id FROM story_automated_publication_authorizations AS authorization
			 JOIN article_images AS authorized_image ON authorized_image.id = authorization.image_id
			 WHERE authorization.story_id = story.id
			   AND authorization.batch_id = item.batch_id
			   AND authorization.source_intake_id = item.source_intake_id
			   AND authorization.candidate_id = item.candidate_id
			   AND authorization.authorization_scope = 'SCHEDULED_PUBLICATION_V1'
			   AND authorization.story_updated_at = story.updated_at
			   AND authorization.image_asset_key = story.og_image_key
			   AND authorized_image.story_id = story.id AND authorized_image.status = 'APPROVED'
			   AND authorized_image.asset_key = authorization.image_asset_key
			   AND authorized_image.reviewed_at = authorization.image_reviewed_at
			   AND trim(authorized_image.alt_text) = authorization.image_alt_text
			   AND length(authorization.image_alt_text) > 0
			 ORDER BY authorization.authorized_at DESC LIMIT 1) AS authorization_id
			FROM editorial_batch_items AS item
			JOIN stories AS story ON story.id = item.story_id
			JOIN editorial_batches AS batch ON batch.id = item.batch_id AND batch.item_count = 3
			JOIN editorial_candidate_selections AS selection
				ON selection.batch_id = item.batch_id AND selection.source_intake_id = item.source_intake_id
			JOIN satire_candidates AS candidate ON candidate.id = selection.candidate_id
			JOIN normalized_event_versions AS version ON version.id = selection.normalized_event_version_id
			WHERE item.workflow_state = 'READY_FOR_REVIEW'
			AND item.candidate_id = selection.candidate_id
			AND story.origin_candidate_id = selection.candidate_id
			AND candidate.source_intake_id = item.source_intake_id
			AND candidate.normalized_event_version_id = version.id
			AND version.source_intake_id = item.source_intake_id AND version.review_state = 'ACCEPTED'
			AND story.status = 'APPROVED' AND story.published_at IS NULL
			AND trim(story.headline) <> '' AND trim(story.body_markdown) <> ''
			AND story.og_image_key IS NOT NULL
			AND EXISTS (SELECT 1 FROM article_images AS image WHERE image.story_id = story.id
				AND image.status = 'APPROVED' AND image.asset_key = story.og_image_key)
			AND EXISTS (SELECT 1 FROM story_automated_publication_authorizations AS authorization
				JOIN article_images AS authorized_image ON authorized_image.id = authorization.image_id
				WHERE authorization.story_id = story.id AND authorization.batch_id = item.batch_id
				AND authorization.source_intake_id = item.source_intake_id
				AND authorization.candidate_id = item.candidate_id
				AND authorization.authorization_scope = 'SCHEDULED_PUBLICATION_V1'
				AND authorization.story_updated_at = story.updated_at
				AND authorization.image_asset_key = story.og_image_key
				AND authorized_image.story_id = story.id AND authorized_image.status = 'APPROVED'
				AND authorized_image.asset_key = authorization.image_asset_key
				AND authorized_image.reviewed_at = authorization.image_reviewed_at
				AND trim(authorized_image.alt_text) = authorization.image_alt_text
				AND length(authorization.image_alt_text) > 0)
			AND EXISTS (SELECT 1 FROM editorial_workflow_events AS event
				WHERE event.batch_id = item.batch_id AND event.source_intake_id = item.source_intake_id
				AND event.event_kind = 'INTAKE_SELECTED' AND event.detail = ?)
			AND EXISTS (SELECT 1 FROM editorial_stage_reminders AS reminder
				WHERE reminder.batch_id = item.batch_id AND reminder.stage = 'FINAL_REVIEW'
				AND reminder.initial_sent_at IS NOT NULL)
			AND (item.lease_owner IS NULL OR item.lease_expires_at <= ?)
			AND NOT EXISTS (SELECT 1 FROM editorial_publication_attempts AS published
				WHERE published.story_id = story.id AND published.status = 'PUBLISHED')
			ORDER BY item.updated_at, item.batch_id, item.ordinal LIMIT 10`)
			.bind(ROUTINE_GENERATION_POLICY, record.at).all<CandidateRow>();

		for (const candidate of candidates.results) {
			const id = record.createId();
			const auditId = record.createId();
			const eventId = record.createId();
			const inserted = await this.db.prepare(`INSERT OR IGNORE INTO editorial_publication_attempts (
				id, story_id, batch_id, source_intake_id, candidate_id, owner_token, actor_email,
				audit_id, workflow_event_id, status, claimed_at, lease_expires_at, attempt_count
				, authorization_id
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'CLAIMED', ?, ?, 1, ?)`)
				.bind(id, candidate.story_id, candidate.batch_id, candidate.source_intake_id,
					candidate.candidate_id, record.owner, record.actorEmail, auditId, eventId,
					record.at, record.leaseExpiresAt, candidate.authorization_id).run();
			if (inserted.meta.changes !== 1) {
				const reclaimed = await this.db.prepare(`UPDATE editorial_publication_attempts
					SET owner_token = ?, actor_email = ?, audit_id = ?, workflow_event_id = ?,
						claimed_at = ?, lease_expires_at = ?, attempt_count = attempt_count + 1
						, authorization_id = ?
					WHERE story_id = ? AND status = 'CLAIMED' AND lease_expires_at <= ?`)
					.bind(record.owner, record.actorEmail, auditId, eventId, record.at,
						record.leaseExpiresAt, candidate.authorization_id, candidate.story_id, record.at).run();
				if (reclaimed.meta.changes !== 1) continue;
			}
			const row = await this.db.prepare(`SELECT id, story_id, batch_id, source_intake_id,
				candidate_id, owner_token, actor_email, lease_expires_at
				FROM editorial_publication_attempts WHERE story_id = ? AND status = 'CLAIMED'
				AND owner_token = ?`).bind(candidate.story_id, record.owner).first<{
				id: string; story_id: string; batch_id: string; source_intake_id: string;
				candidate_id: string; owner_token: string; actor_email: string; lease_expires_at: string;
			}>();
			if (row) return { id: row.id, storyId: row.story_id, batchId: row.batch_id,
				intakeId: row.source_intake_id, candidateId: row.candidate_id, owner: row.owner_token,
				actorEmail: row.actor_email, leaseExpiresAt: row.lease_expires_at };
		}
		return null;
	}

	async publish(claim: PublicationClaim, at: string): Promise<boolean> {
		const result = await this.db.prepare(`UPDATE stories SET status = 'PUBLISHED',
			published_at = ?, updated_at = ? WHERE id = ? AND status = 'APPROVED' AND published_at IS NULL
			AND trim(headline) <> '' AND trim(body_markdown) <> '' AND og_image_key IS NOT NULL
			AND EXISTS (SELECT 1 FROM article_images AS image WHERE image.story_id = stories.id
				AND image.status = 'APPROVED' AND image.asset_key = stories.og_image_key)
			AND EXISTS (SELECT 1 FROM story_automated_publication_authorizations AS authorization
				JOIN article_images AS image ON image.id = authorization.image_id
				WHERE authorization.id = (SELECT authorization_id FROM editorial_publication_attempts WHERE id = ?)
				AND authorization.story_id = stories.id
				AND authorization.story_updated_at = stories.updated_at
				AND authorization.image_asset_key = stories.og_image_key
				AND image.story_id = stories.id AND image.status = 'APPROVED'
				AND image.asset_key = authorization.image_asset_key
				AND image.reviewed_at = authorization.image_reviewed_at
				AND trim(image.alt_text) = authorization.image_alt_text
				AND length(authorization.image_alt_text) > 0)
			AND EXISTS (SELECT 1 FROM editorial_publication_attempts AS attempt
				WHERE attempt.id = ? AND attempt.story_id = stories.id AND attempt.batch_id = ?
				AND attempt.source_intake_id = ? AND attempt.candidate_id = ?
				AND attempt.owner_token = ? AND attempt.status = 'CLAIMED'
				AND attempt.lease_expires_at > ?)
			AND EXISTS (SELECT 1 FROM editorial_batch_items AS item
				WHERE item.batch_id = ? AND item.source_intake_id = ? AND item.story_id = stories.id
				AND item.candidate_id = ? AND item.workflow_state = 'READY_FOR_REVIEW')`)
			.bind(at, at, claim.storyId, claim.id, claim.id, claim.batchId, claim.intakeId,
				claim.candidateId, claim.owner, at, claim.batchId, claim.intakeId, claim.candidateId).run();
		if (result.meta.changes !== 1) return false;
		const completed = await this.db.prepare(`SELECT 1 AS complete FROM editorial_publication_attempts
			WHERE id = ? AND status = 'PUBLISHED' AND published_at = ?`)
			.bind(claim.id, at).first<{ complete: number }>();
		return completed?.complete === 1;
	}
}
