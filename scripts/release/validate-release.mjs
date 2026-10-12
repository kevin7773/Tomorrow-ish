import { resolve } from 'node:path';
import { readJson, validateDeployedModuleInventory, validateDryRunPackage, validateGeneratedConfiguration,
	validateLiveSnapshot, validateUploadedVersion } from './release-safety.mjs';

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
const paused = process.argv.includes('--paused');
if (paused && !liveSnapshotPath) throw new Error('--paused requires --live-snapshot so the observed zero-schedule state can be verified.');
const config = await readJson(configPath);
const baseline = await readJson(baselinePath);
const configuration = validateGeneratedConfiguration(config, baseline);
const modules = packageDirectory
	? await validateDryRunPackage(resolve(configPath, '..'), resolve(packageDirectory), config)
	: null;
if (liveSnapshotPath) validateLiveSnapshot(await readJson(resolve(liveSnapshotPath)), baseline, { paused });
const version = versionSnapshotPath ? validateUploadedVersion(await readJson(resolve(versionSnapshotPath)), baseline) : null;
const deployedModules = moduleInventoryPath
	? await validateDeployedModuleInventory(resolve(configPath, '..'), await readJson(resolve(moduleInventoryPath)))
	: null;
console.log(JSON.stringify({ ok: true, configuration, modules, liveSnapshot: Boolean(liveSnapshotPath),
	liveSnapshotMode: liveSnapshotPath ? (paused ? 'paused' : 'normal') : null, version, deployedModules }, null, 2));
