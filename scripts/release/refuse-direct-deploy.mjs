console.error('Direct deployment is disabled. Run npm run release:prepare, then follow docs/production-deployment.md.');
console.error('Production upload, inspection, activation, Cron changes, and rollback are separate authorized operations.');
process.exitCode = 1;
