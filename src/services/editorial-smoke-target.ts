export const SMOKE_BATCH_ID = 'b24b69e8-0816-4c13-90fe-0925feecac00';
export const SMOKE_INTAKE_ID = '2c7f63bc-a733-4952-84f3-3bc6048290cb';
export const SMOKE_STORY_ID = '73724b18-c932-41cf-9f6a-2cff6b96b5c9';
export const SMOKE_CANDIDATE_ID = '9485a3bf-8af2-4a0d-b44c-47075fc78b33';
export const SMOKE_NORMALIZATION_ID = '5ddcc5c9-3fe1-4f1c-bc57-6e749e9d5d4d';

export interface EditorialSmokeTarget {
	batchId: string;
	intakeId: string;
	storyId?: string;
	candidateId?: string;
	normalizedEventVersionId?: string;
}

export function smokeTarget(batchId: string | undefined, intakeId: string | undefined): EditorialSmokeTarget | null {
	return batchId === SMOKE_BATCH_ID && intakeId === SMOKE_INTAKE_ID
		? {
			batchId: SMOKE_BATCH_ID,
			intakeId: SMOKE_INTAKE_ID,
			storyId: SMOKE_STORY_ID,
			candidateId: SMOKE_CANDIDATE_ID,
			normalizedEventVersionId: SMOKE_NORMALIZATION_ID,
		}
		: null;
}

export function isSmokeTargetPair(target: EditorialSmokeTarget | null, batchId: string, intakeId: string): boolean {
	return target?.batchId === batchId && target.intakeId === intakeId;
}

export function isSmokeTargetIntake(target: EditorialSmokeTarget | null, intakeId: string): boolean {
	return target?.intakeId === intakeId;
}
