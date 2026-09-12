import type { DiscoveryItem } from '../domain/automation';

export interface AutomationSourceProvider {
	discover(limit: number): Promise<DiscoveryItem[]>;
}

export class AutomationSourceProviderError extends Error {
	constructor(readonly classification: 'NOT_CONFIGURED' | 'NETWORK' | 'REJECTED' | 'MALFORMED_RESPONSE') {
		super(classification);
		this.name = 'AutomationSourceProviderError';
	}
}
