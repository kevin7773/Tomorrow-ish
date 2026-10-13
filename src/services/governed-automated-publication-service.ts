import type { GovernedPublicationRepository } from '../data/governed-publication-repository';

const PUBLICATION_LEASE_MS = 5 * 60 * 1_000;

export interface AutomatedPublicationReport {
	disabled: boolean;
	claimed: number;
	published: number;
	failed: number;
}

export function automatedPublicationEnabled(value: string | undefined): boolean {
	if (value === undefined || value === '' || value === 'false') return false;
	if (value === 'true') return true;
	throw new Error('EDITORIAL_AUTOMATED_PUBLICATION_ENABLED must be true or false');
}

export class GovernedAutomatedPublicationService {
	constructor(
		private readonly repository: GovernedPublicationRepository,
		private readonly enabled: boolean,
		private readonly actorEmail: string,
		private readonly now: () => Date = () => new Date(),
		private readonly createId: () => string = () => crypto.randomUUID(),
	) {}

	async process(limit = 3): Promise<AutomatedPublicationReport> {
		const report = { disabled: !this.enabled, claimed: 0, published: 0, failed: 0 };
		if (!this.enabled) return report;
		for (let index = 0; index < limit; index += 1) {
			const now = this.now();
			const claim = await this.repository.claimNext({
				owner: `publication:${this.createId()}`,
				actorEmail: this.actorEmail,
				at: now.toISOString(),
				leaseExpiresAt: new Date(now.getTime() + PUBLICATION_LEASE_MS).toISOString(),
				createId: this.createId,
			});
			if (!claim) break;
			report.claimed += 1;
			if (await this.repository.publish(claim, this.now().toISOString())) report.published += 1;
			else report.failed += 1;
		}
		return report;
	}
}
