export const SMOKE_BATCH_ID = 'b24b69e8-0816-4c13-90fe-0925feecac00';
export const SMOKE_INTAKE_ID = '2c7f63bc-a733-4952-84f3-3bc6048290cb';

export function smokeTarget(batchId: string | undefined, intakeId: string | undefined) {
	return batchId === SMOKE_BATCH_ID && intakeId === SMOKE_INTAKE_ID
		? { batchId: SMOKE_BATCH_ID, intakeId: SMOKE_INTAKE_ID }
		: null;
}
