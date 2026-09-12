import { describe, expect, it } from 'vitest';
import {
	GOVERNED_AUTOMATION_SOURCE_URL,
	GovernedAutomationSourceProvider,
	automationSourceProvider,
} from '../src/automation/governed-source-provider';
import { HttpAutomationSourceProvider } from '../src/automation/http-source-provider';

describe('runtime automation source selection', () => {
	it('uses the in-process governed provider for the Tomorrow-ish-owned feed', () => {
		expect(automationSourceProvider(GOVERNED_AUTOMATION_SOURCE_URL))
			.toBeInstanceOf(GovernedAutomationSourceProvider);
	});

	it('retains HTTP provider support for external feed contracts', () => {
		expect(automationSourceProvider('https://feed.example.test/items'))
			.toBeInstanceOf(HttpAutomationSourceProvider);
	});
});
