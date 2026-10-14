import { readFileSync } from 'node:fs';
import { ReleaseSafetyError } from './release-safety.mjs';

export function readProtectedJsonInput(descriptor = 0) {
	let input;
	try {
		input = readFileSync(descriptor, 'utf8');
	} catch {
		throw new ReleaseSafetyError('Protected secret input could not be read.');
	}
	if (!input.trim()) {
		throw new ReleaseSafetyError('Protected secret input is empty.');
	}
	try {
		return JSON.parse(input);
	} catch {
		throw new ReleaseSafetyError('Protected secret input is not valid JSON.');
	}
}
