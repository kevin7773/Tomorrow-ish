import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createCronConfiguration, readJson } from './release-safety.mjs';

const action = process.argv[2];
if (action !== 'pause' && action !== 'restore') throw new Error('Usage: cron-config.mjs <pause|restore>');
const config = await readJson(resolve('dist/server/wrangler.json'));
const baseline = await readJson(resolve('release/production-baseline.json'));
const target = resolve(`dist/server/wrangler.${action}.json`);
await writeFile(target, `${JSON.stringify(createCronConfiguration(config, baseline, action === 'pause'), null, 2)}\n`, 'utf8');
console.log(target);
