# Production deployment runbook

This runbook prepares the existing Astro application for its first Cloudflare Workers deployment. It does not authorize a deployment or a production database migration. Run each remote command only after reviewing its target and output.

## Production topology

- Worker: `tomorrow-ish`
- Canonical custom domain: `https://tomorrow-ish.news`
- Production D1 database: `tomorrow-ish-production`
- D1 binding exposed to the Worker: `DB`
- Static asset binding: `ASSETS`
- Secondary and `www` hostnames: Cloudflare edge redirects, not additional application origins
- `workers.dev`: disabled for the production Worker
- Preview URLs: disabled until a separate preview D1 database and preview Worker configuration are reviewed

Wrangler's `--local` mode stores D1 state under `.wrangler/` and never contacts the production database. The production UUID is recorded in `wrangler.jsonc`; remote access still requires an explicit `--remote` command.

## One-time Cloudflare prerequisites

Complete these account-level steps in the Cloudflare dashboard:

1. Add both `tomorrow-ish.news` and `tomorrow-ish.com` as active Cloudflare zones and complete their registrar nameserver changes.
2. Confirm both zones are in the same Cloudflare account that will own the Worker and D1 database.
3. Confirm Universal SSL is active for both zones and there are no conflicting Worker routes or DNS records for the hostnames in this runbook.
4. Authenticate Wrangler locally with `npx wrangler login`, or use a narrowly scoped Cloudflare API token in the deployment environment. This credential is deployment infrastructure, not an application runtime secret.

## Create and bind production D1

Current status: `tomorrow-ish-production` has been created and its UUID is bound to `DB` in `wrangler.jsonc`. Do not run the create command again for the current production environment.

The one-time creation command used from the repository root was:

```powershell
npx wrangler d1 create tomorrow-ish-production
```

Wrangler returns a `database_id` UUID and may offer to edit the configuration. If the database ever has to be recreated in a different Cloudflare account, decline the automatic edit because the `DB` binding already exists, then replace the existing UUID manually and review the diff.

```jsonc
"database_id": "96f4a86d-1d60-47b1-a240-86552d001191"
```

Do not change the binding name `DB` or the database name `tomorrow-ish-production`. Review the resulting diff and confirm that `database_id` is the only value populated from the command output.

Local development remains separate and uses the same binding name:

```powershell
npm run db:migrate:local
npm run db:seed:local
npm run dev
```

Every local database command includes `--local`; never remove that flag from the local scripts.

## Review and apply production migrations

For M2, use the additional approval gates and exact commands in [m2-production-onboarding.md](./m2-production-onboarding.md). In particular, do not apply `0002_editorial_workflow.sql`, its category reference data, Cloudflare Access settings, or an M2 deployment merely because this baseline runbook describes the general production process.

Inspect the migration files and the remote target before applying anything:

```powershell
git diff --exit-code
npx wrangler d1 migrations list DB --remote
Get-Content -Raw .\migrations\0001_initial.sql
```

After explicit approval, apply the reviewed migration set as its own operator action:

```powershell
npx wrangler d1 migrations apply DB --remote
```

Verify the schema and migration ledger:

```powershell
npx wrangler d1 migrations list DB --remote
npx wrangler d1 execute DB --remote --command "SELECT name, type FROM sqlite_schema WHERE type IN ('table', 'index') ORDER BY type, name"
```

Production migrations must not be added to `npm run deploy`, Workers Builds, or another automatic deployment step.

## Optional fictional demo content

The application can launch with an empty edition. To load the current fictional sample content only after the schema is verified:

```powershell
Get-Content -Raw .\seed.sql
npx wrangler d1 execute DB --remote --file=.\seed.sql
```

The seed is idempotent. It creates four public `PUBLISHED` stories plus one `DRAFT`, one `REVIEW`, and one `APPROVED` boundary fixture. Public repository queries render only `PUBLISHED` records. Do not run the seed if production should launch empty.

Verify the resulting status counts without exposing story bodies:

```powershell
npx wrangler d1 execute DB --remote --command "SELECT status, COUNT(*) AS story_count FROM stories GROUP BY status ORDER BY status"
```

## Supported production release procedure

`npm run deploy` is intentionally blocked. Plain `wrangler deploy`, using `src/worker.ts` from the root configuration, is not a supported release path because it can omit Astro-generated chunks. A release must treat `dist/server/wrangler.json`, `entry.mjs`, every generated module, and `dist/client` as one immutable artifact.

The reviewed production identity and non-secret configuration are frozen in `release/production-baseline.json`. Changing that file is a production configuration change and requires separate review. Runtime secret values are never exported; the validator checks only that the required secret binding names remain attached.

### 1. Local release gate

Start from clean local and remote `main` at the exact approved commit:

```powershell
$env:CLOUDFLARE_ACCOUNT_ID = '13fbf38daabf893cddf8e7214957bfce'
npm ci
npm test
npm run check
npm run release:prepare -- --commit <approved-commit-sha>
git diff --check
git status --short --branch
```

`release:prepare` performs the production Astro build, validates the generated configuration, runs `wrangler versions upload --dry-run` against `dist/server/wrangler.json`, recursively follows local imports from `entry.mjs`, and compares every generated JavaScript module with the dry-run package under `.release/wrangler-dry-run`. A missing entrypoint, chunk, binding, route, gate, or safety setting stops the release.

For an uncommitted local checkpoint only, `npm run release:prepare -- --local-checkpoint` may exercise packaging. Its report says `releaseEligible: false`; it must never be uploaded.

### 2. Read-only production preflight

Before any remote mutation, capture a reviewed JSON snapshot containing:

```json
{
  "capturedAt": "<current RFC3339 timestamp; snapshots older than ten minutes fail closed>",
  "accountId": "13fbf38daabf893cddf8e7214957bfce",
  "workerName": "tomorrow-ish",
  "d1": [{ "binding": "DB", "database_name": "tomorrow-ish-production", "database_id": "96f4a86d-1d60-47b1-a240-86552d001191" }],
  "r2": [{ "binding": "IMAGE_ASSETS", "bucket_name": "tomorrow-ish-images" }],
  "assets": { "binding": "ASSETS", "directory": "../client" },
  "workersDev": false,
  "previewUrls": false,
  "routes": [{ "pattern": "tomorrow-ish.news", "custom_domain": true }],
  "crons": ["0 13 * * *", "0 21 * * *", "*/5 * * * *"],
  "secretNames": ["CLOUDFLARE_AI_API_TOKEN", "IMAGE_WEBHOOK_SECRET", "OPENAI_API_KEY"],
  "vars": {
    "CF_ACCESS_TEAM_DOMAIN": "https://jolly-glitter-da93.cloudflareaccess.com",
    "CF_ACCESS_AUD": "d7990901bf79388de024fee36a5a8abcd4452ff4c908acfa19189b37856fb30b",
    "EDITORIAL_ALLOWED_EMAIL": "klsmallwood73@gmail.com",
    "MODEL_PROVIDER": "openai",
    "MODEL_NAME": "gpt-5.6-terra",
    "MODEL_GENERATION_ENABLED": "false",
    "MODEL_BUDGET_ADMISSION_ENABLED": "false",
    "MODEL_NORMALIZE_MAX_COST_MICRO_USD": "50000",
    "MODEL_CANDIDATES_MAX_COST_MICRO_USD": "50000",
    "MODEL_ARTICLE_BODY_MAX_COST_MICRO_USD": "60000",
    "MODEL_ITEM_BUDGET_MICRO_USD": "150000",
    "MODEL_DAILY_BUDGET_MICRO_USD": "150000",
    "EDITORIAL_WORKFLOW_GENERATION_ENABLED": "false",
    "EDITORIAL_WORKFLOW_SMOKE_BATCH_ID": "b24b69e8-0816-4c13-90fe-0925feecac00",
    "EDITORIAL_WORKFLOW_SMOKE_INTAKE_ID": "2c7f63bc-a733-4952-84f3-3bc6048290cb",
    "EDITORIAL_IMAGE_SMOKE_ATTEMPT_KEY": "",
    "AUTOMATION_ENABLED": "true",
    "AUTOMATION_SOURCE_URL": "https://tomorrow-ish.news/api/automation/source-feed",
    "AUTOMATION_MAX_ITEMS_PER_RUN": "3",
    "AUTOMATION_ACTOR_EMAIL": "automation@tomorrow-ish.news",
    "IMAGE_PROVIDER": "cloudflare-ai-gateway",
    "IMAGE_MODEL": "openai/gpt-image-2",
    "IMAGE_GENERATION_ENABLED": "false",
    "CLOUDFLARE_ACCOUNT_ID": "13fbf38daabf893cddf8e7214957bfce",
    "CLOUDFLARE_AI_GATEWAY_ID": "tomorrow-ish",
    "IMAGE_WEBHOOK_ORIGIN": "https://tomorrow-ish.news",
    "REVIEW_NOTIFICATION_WEBHOOK_URL": "https://tomorrow-ish.news/api/internal/review-notifications",
    "ADS_ENABLED": "false",
    "ADSENSE_ARTICLE_INLINE_1_SLOT": "",
    "ADSENSE_ARTICLE_INLINE_2_SLOT": "",
    "ADSENSE_DESKTOP_SIDEBAR_SLOT": ""
  }
}
```

Populate it from authenticated `wrangler whoami --account ... --json`, Worker settings/version reads, the Workers routes and custom-domain APIs, the schedules API, D1 identity, and `wrangler secret list`. Do not infer `workers.dev` or preview settings from an HTTP redirect. Validate it locally:

```powershell
npm run release:validate -- --live-snapshot .release/live-before.json
```

The completed Phase 4H variable-only state is frozen as `production-baseline.pre-resend-secrets.json`; its historical transition remains recorded in `resend-email-baseline-transition.json`. Do not validate that historical target against a newly built Phase 4I artifact, because the new artifact intentionally declares seven required secret names.

The next reviewed transition is secret-name-only. While production contains the exact three-secret baseline, validate the generated seven-secret target against the frozen previous state with:

```powershell
$secretTransition = @(
  '--transition-from-baseline', 'release/production-baseline.pre-resend-secrets.json',
  '--transition-contract', 'release/resend-secret-baseline-transition.json'
)
npm run release:validate -- @secretTransition --live-state previous --live-snapshot .release/live-before-secrets.json
```

Provision those values only through `scripts/release/provision-resend-secrets.ps1`. The script uses protected prompts, passes the exact four-value JSON object over standard input, creates an inactive version with `wrangler versions secret bulk`, and inspects all bindings and disabled gates. It never calls `versions deploy`, never writes plaintext values to a file, and will not overwrite existing evidence. A possible-but-unconfirmed version is an investigation stop, not permission to repeat the operation.

Operator prerequisites are: a separately approved and pushed commit; clean local/remote `main`; a completed build and strict package dry run; an authenticated production account with `CLOUDFLARE_ACCOUNT_ID` explicitly set; a fresh normal-mode live snapshot matching the three-secret previous baseline; an existing evidence directory; a dedicated Tomorrow-ish Resend API key (never a key from another application); the verified Resend webhook signing secret; the approved editor destination; and a freshly generated bearer token of at least 32 characters. Secret values must be entered only at the protected prompts.

Activation is intentionally absent from the provisioning script. A separately authorized window must identify the inspected inactive version in the non-secret evidence, capture a fresh target snapshot, validate the version again, and explicitly invoke the ordinary activation contract. A requested activation version that differs from the inspected version is rejected.

Also capture Time Travel, exports, current deployment/version, module inventory, D1 counts, and provider/audit baselines required by the approved change. A multi-account login is fail-closed unless `CLOUDFLARE_ACCOUNT_ID` is explicitly set to the production account.

### 3. Pause Cron without redeploying application code

Generate a complete sibling configuration in `dist/server`; the tool proves that only `triggers.crons` differs:

```powershell
npm run release:cron:pause-config
npm run release:operator -- cron-pause --execute --commit <approved-commit-sha> --live-snapshot .release/live-before.json
```

This uses `wrangler triggers deploy` with the complete Astro-generated configuration. Immediately reread schedules, routes, custom domain, `workers.dev`, preview URLs, and bindings. The pause is valid only when schedules are empty and every other value matches the baseline.

Capture that fresh paused state and explicitly validate it in paused mode before upload:

```powershell
npm run release:validate -- --paused --live-snapshot .release/live-paused.json
```

### 4. Upload, inspect, and activate a version

Upload creates a version but does not activate it:

```powershell
npm run release:operator -- upload --execute --commit <approved-commit-sha> --live-snapshot .release/live-paused.json --tag <reviewed-tag> --message "<reviewed-message>"
npx wrangler versions view <new-version-id> --name tomorrow-ish --json > .release/version.json
```

Obtain the version-specific multipart module inventory through the authenticated Workers API and normalize its part names as `{ "modules": ["entry.mjs", "chunks/...mjs"] }` in `.release/module-inventory.json`. Then validate the actual uploaded bindings and every generated module before activation:

```powershell
npm run release:validate -- --paused --live-snapshot .release/live-paused.json --version-snapshot .release/version.json --module-inventory .release/module-inventory.json
npm run release:operator -- activate --execute --commit <approved-commit-sha> --live-snapshot .release/live-paused.json --version <new-version-id> --version-snapshot .release/version.json --module-inventory .release/module-inventory.json --message "<reviewed-activation-message>"
```

Activation is blocked if the inspected version ID, handlers, compatibility settings, variables, D1/R2/assets bindings, secret references, or module inventory differ from the reviewed artifact.

### 5. Restore schedules and verify

```powershell
npm run release:cron:restore-config
npm run release:operator -- cron-restore --execute --commit <approved-commit-sha> --live-snapshot .release/live-paused.json
```

Capture `.release/live-after.json` with a fresh `capturedAt` and rerun normal-mode validation (omit `--paused`):

```powershell
npm run release:validate -- --live-snapshot .release/live-after.json
```

The release is incomplete until all three original schedules are restored exactly once, the custom domain and Access boundary are healthy, the intended version is at 100%, a five-minute Cron window completes with one owner, and before/after data/provider invariants pass. Normal mode rejects zero, partial, or unexpected schedules; paused mode requires exactly zero schedules.

### 6. Safe rollback

Before activation, inspect and retain a known-good version whose version snapshot passes both the complete production binding/configuration checks and the all-generation-disabled checks. Rollback changes only the active version; it does not improvise migration rollback or alter data:

```powershell
npm run release:operator -- rollback --execute --commit <approved-commit-sha> --live-snapshot .release/live-after.json --version <disabled-version-id> --version-snapshot .release/disabled-version.json --message "Disable generation and restore verified Worker"
```

After rollback, repeat effective-configuration, routes/domain, health, schedules, Cron-ownership, and provider-activity verification. If an additive migration was already applied, leave it in place unless a separately reviewed data recovery procedure says otherwise.

During a future Phase 4I secret-binding activation, retain and inspect the active three-secret, all-disabled Worker. Supply the secret transition files and `--rollback-to-previous`; this makes the operator validate that rollback version against the frozen previous baseline rather than the seven-secret target baseline:

```powershell
npm run release:operator -- rollback --execute --commit <approved-commit-sha> --live-snapshot .release/live-after.json --transition-from-baseline release/production-baseline.pre-resend-secrets.json --transition-contract release/resend-secret-baseline-transition.json --rollback-to-previous --version <three-secret-disabled-version-id> --version-snapshot .release/previous-version.json --message "Restore three-secret fully disabled Worker"
```

After a separately authorized activation, capture a fresh live snapshot and validate it with `--live-state target`. All seven capability gates remain explicitly false in both baselines. The only Phase 4I target changes are the four reviewed secret binding names; their values never appear in release evidence.

The configured Custom Domain sends all paths on `tomorrow-ish.news` to this Worker. Cloudflare creates the required DNS record and managed certificate when the Custom Domain is attached. If the first deployment cannot attach the domain, use **Workers & Pages → tomorrow-ish → Settings → Domains & Routes → Add → Custom Domain**, enter `tomorrow-ish.news`, and resolve any conflicting DNS record before retrying.

## Canonical redirects

Create an account-level Bulk Redirect List named `tomorrow-ish-canonical-hosts`, then add these three entries:

| Source URL | Target URL | Status | Subpath matching | Preserve path suffix | Preserve query string | Include subdomains |
| --- | --- | --- | --- | --- | --- | --- |
| `tomorrow-ish.com` | `https://tomorrow-ish.news` | `301` | On | On | On | Off |
| `www.tomorrow-ish.com` | `https://tomorrow-ish.news` | `301` | On | On | On | Off |
| `www.tomorrow-ish.news` | `https://tomorrow-ish.news` | `301` | On | On | On | Off |

Omitting the source scheme matches both HTTP and HTTPS. These settings transform, for example, `http://www.tomorrow-ish.com/archive?year=2026` into `https://tomorrow-ish.news/archive?year=2026`.

Create and enable one Bulk Redirect Rule for the list. Bulk Redirects require proxied Cloudflare DNS for every source hostname. If the dashboard prompts for records and no origin exists, create proxied placeholder records for the redirect-only hostnames; do not point them at the application Worker. Keep `tomorrow-ish.news` reserved for the Worker Custom Domain.

After certificates are active, verify all six HTTP/HTTPS source-host combinations with a path and query string. Each should return a single permanent redirect to the canonical HTTPS hostname with the path and query unchanged.

## `workers.dev` and preview policy

`workers_dev: false` prevents the production Worker from creating a second public origin that could compete with canonical indexing. `preview_urls: false` also disables public version preview URLs for this Worker.

Do not redirect `workers.dev`; disable it. A redirect still leaves a public alternate hostname and requires application logic that the canonical site does not need. If branch previews are introduced later, first create a separate preview D1 database and a separate preview Worker configuration, then protect or explicitly enable preview URLs there. Never bind a non-production branch preview to `tomorrow-ish-production`.

## Workers Builds after the first reviewed deployment

In **Workers & Pages → tomorrow-ish → Settings → Builds**:

1. Connect the existing GitHub repository.
2. Set the root directory to the repository root.
3. Set the production branch to `main`.
4. Use `npm run build` as the build command only for artifact validation.
5. Do not configure automatic production deployment. The supported path requires reviewed version upload, inspection, explicit activation, and Cron verification; `npx wrangler deploy` is intentionally unsupported.
6. Do not include D1 migration or seed commands in either field.
7. Leave non-production branch builds disabled until a separate preview D1 binding is configured. When that exists, use `npx wrangler versions upload` for non-production branches and confirm previews cannot access production D1.
8. Review the generated Workers Builds API token. The M1 application needs no build variables, runtime variables, or secrets.

## Post-deployment verification

After a separately authorized deployment:

```powershell
$routes = @(
  'https://tomorrow-ish.news/',
  'https://tomorrow-ish.news/latest',
  'https://tomorrow-ish.news/archive',
  'https://tomorrow-ish.news/about',
  'https://tomorrow-ish.news/contact',
  'https://tomorrow-ish.news/privacy',
  'https://tomorrow-ish.news/terms',
  'https://tomorrow-ish.news/robots.txt',
  'https://tomorrow-ish.news/sitemap.xml',
  'https://tomorrow-ish.news/ads.txt'
)
$routes | ForEach-Object { Invoke-WebRequest -Uri $_ -Method Head -MaximumRedirection 0 }
```

Also verify a published story, an unknown route, all redirect hosts, certificate status, and that the production `workers.dev` route and Preview URLs are disabled.

The application emits fixed canonical, Open Graph, JSON-LD, robots, and sitemap URLs under `https://tomorrow-ish.news`. The configured trailing-slash policy redirects non-root trailing-slash requests to the corresponding slashless URL. Runtime secret values stay in Cloudflare; release validation checks that their binding names are present without exporting their values.

## Cloudflare references

- [D1 Wrangler commands](https://developers.cloudflare.com/d1/wrangler-commands/)
- [Workers Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- [Disable the workers.dev route](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)
- [Create Bulk Redirects in the dashboard](https://developers.cloudflare.com/rules/url-forwarding/bulk-redirects/create-dashboard/)
- [Workers Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)
