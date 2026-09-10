import { FakeModelProvider } from './fake-model-provider';
import type { ModelProvider } from './model-provider';

class DisabledModelProvider implements ModelProvider {
	readonly providerId = 'disabled';
	readonly modelId = 'not-configured';
	async normalizeEvent(): Promise<never> { throw new Error('No production model provider is configured.'); }
	async generateCandidates(): Promise<never> { throw new Error('No production model provider is configured.'); }
}

export function getRuntimeModelProvider(): ModelProvider {
	if (import.meta.env.DEV) return new FakeModelProvider();
	return new DisabledModelProvider();
}
