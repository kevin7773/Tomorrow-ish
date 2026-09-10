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

## First production deployment

Run the complete local gate from a clean `main` checkout after confirming the committed D1 UUID:

```powershell
npm ci
npm test
npm run check
npm run build
npx wrangler deploy --dry-run
git diff --check
git status --short --branch
```

Review the dry-run binding table. It must list only `env.DB (tomorrow-ish-production)` and `env.ASSETS`.

After the production migration has been applied and deployment is explicitly approved:

```powershell
npm run deploy
```

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
4. Use `npm run build` as the build command.
5. Use `npx wrangler deploy` as the production deploy command.
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
  'https://tomorrow-ish.news/privacy',
  'https://tomorrow-ish.news/terms',
  'https://tomorrow-ish.news/robots.txt',
  'https://tomorrow-ish.news/sitemap.xml'
)
$routes | ForEach-Object { Invoke-WebRequest -Uri $_ -Method Head -MaximumRedirection 0 }
```

Also verify a published story, an unknown route, all redirect hosts, certificate status, and that the production `workers.dev` route and Preview URLs are disabled.

The application emits fixed canonical, Open Graph, JSON-LD, robots, and sitemap URLs under `https://tomorrow-ish.news`. The configured trailing-slash policy redirects non-root trailing-slash requests to the corresponding slashless URL. No production application secrets are required: M1 reads only the `DB` and `ASSETS` bindings.

## Cloudflare references

- [D1 Wrangler commands](https://developers.cloudflare.com/d1/wrangler-commands/)
- [Workers Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- [Disable the workers.dev route](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)
- [Create Bulk Redirects in the dashboard](https://developers.cloudflare.com/rules/url-forwarding/bulk-redirects/create-dashboard/)
- [Workers Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)
