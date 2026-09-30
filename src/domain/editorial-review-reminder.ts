export type EditorialReminderStage = 'TRIAGE' | 'FINAL_REVIEW';
export type ReviewReminderKind = 'INITIAL' | 'SIX_HOUR' | 'FINAL';

export interface ReviewReminderBatch {
	batchId: string;
	stage: EditorialReminderStage;
	itemCount: number;
	createdAt: string;
	initialSentAt: string | null;
	sixHourSentAt: string | null;
	finalSentAt: string | null;
	resolvedAt: string | null;
}

export interface ClaimedReviewReminder {
	batchId: string;
	stage: EditorialReminderStage;
	kind: ReviewReminderKind;
	claimToken: string;
}
