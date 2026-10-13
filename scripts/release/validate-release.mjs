import { resolve } from 'node:path';
import { readJson, validateDeployedModuleInventory, validateDryRunPackage, validateGeneratedConfiguration,
	validateBaselineTransition, validateLiveSnapshot, validateUploadedVersion } from './release-safety.mjs';

function option(name, fallback) {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : fallback;
}

const configPath = resolve(option('--config', 'dist/server/wrangler.json'));
const baselinePath = resolve(option('--baseline', 'release/production-baseline.json'));
const packageDirectory = option('--package-dir', null);
const liveSnapshotPath = option('--live-snapshot', null);
const versionSnapshotPath = option('--version-snapshot', null);
const moduleInventoryPath = option('--module-inventory', null);
const transitionFromPath = option('--transition-from-baseline', null);
const transitionContractPath = option('--transition-contract', null);
const liveState = option('--live-state', 'target');
const paused = process.argv.includes('--paused');
if (paused && !liveSnapshotPath) throw new Error('--paused requires --live-snapshot so the observed zero-schedule state can be verified.');
if ((transitionFromPath === null) !== (transitionContractPath === null)) {
	throw new Error('--transition-from-baseline and --transition-contract must be supplied together.');
}
if (!['previous', 'target'].includes(liveState)) throw new Error('--live-state must be previous or target.');
if (liveState === 'previous' && !transitionFromPath) {
	throw new Error('--live-state previous requires an exact reviewed baseline transition.');
}
const config = await readJson(configPath);
const baseline = await readJson(baselinePath);
const previousBaseline = transitionFromPath ? await readJson(resolve(transitionFromPath)) : null;
const transition = previousBaseline
	? validateBaselineTransition(previousBaseline, baseline, await readJson(resolve(transitionContractPath)))
	: null;
const configuration = validateGeneratedConfiguration(config, baseline);
const modules = packageDirectory
	? await validateDryRunPackage(resolve(configPath, '..'), resolve(packageDirectory), config)
	: null;
if (liveSnapshotPath) validateLiveSnapshot(await readJson(resolve(liveSnapshotPath)),
	liveState === 'previous' ? previousBaseline : baseline, { paused });
const version = versionSnapshotPath ? validateUploadedVersion(await readJson(resolve(versionSnapshotPath)), baseline) : null;
const deployedModules = moduleInventoryPath
	? await validateDeployedModuleInventory(resolve(configPath, '..'), await readJson(resolve(moduleInventoryPath)))
	: null;
console.log(JSON.stringify({ ok: true, configuration, modules, liveSnapshot: Boolean(liveSnapshotPath),
	liveSnapshotMode: liveSnapshotPath ? `${liveState}-${paused ? 'paused' : 'normal'}` : null,
	transition, version, deployedModules }, null, 2));
