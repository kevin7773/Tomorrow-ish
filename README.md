# Tomorrow-ish

Tomorrow-ish is a lightweight satirical newspaper that publishes tomorrow's fictional headlines today.

The publication uses Astro 7, TypeScript, Cloudflare Workers with Static Assets, and Cloudflare D1. It does not create or depend on a Cloudflare Pages project.

## Requirements

- Node.js 22.12 or newer
- npm
- A Cloudflare account is required only when production infrastructure is configured

## Install

```powershell
npm install
```

## Local database

Wrangler stores the local D1 database under `.wrangler/`. The local database is separate from every remote D1 database.

Apply the conventional D1 migration set:

```powershell
npm run db:migrate:local
```

Load the clearly fictional sample edition:

```powershell
npm run db:seed:local
```

The seed also adds `Florida, Probably` as ordinary category reference data. Production reference data remains a separate reviewed action.

Both commands operate on local state. The seed script is idempotent and does not run as part of a production deployment.

## Develop

```powershell
npm run dev
```

Astro runs against Cloudflare's local Workers runtime and the local `DB` binding. The public application reads only stories whose status is `PUBLISHED`.

The private editorial workspace is available at `http://localhost:4321/editorial`. Localhost uses a fixed development-only editor identity; non-local requests always require a valid Cloudflare Access assertion and complete Access configuration.

M3 adds a governed, manual normalization and candidate-generation path. In local development, the normalization and generation screens use a deterministic fake provider that requires no network access, API key, or new Cloudflare binding:

```text
source intake
  -> model normalization proposal
  -> editor-accepted immutable normalized-event version
  -> five model-authored DRAFT candidates
  -> existing human review and publication workflow
```

Open an intake and choose **Normalize event**. The fake provider is used only in development. The production OpenAI adapter is implemented but remains disabled by `MODEL_GENERATION_ENABLED=false`; builds and fake-provider tests require no API key.

## Validate

```powershell
npm test
npm run check
npm run build
npm audit
```

To exercise the production-style Worker locally after a build:

```powershell
npm run preview
```

## Security status

The project is pinned to Astro 7.3.2 and the matching official Cloudflare adapter. Run `npm audit` with the validation suite and review any new findings before production deployment.

## Data layout

- `migrations/` contains append-only, schema-only D1 migrations using Wrangler's default convention.
- `seed.sql` contains development-only fictional sample records.
- `src/domain/` owns publication and candidate state plus editorial data types.
- `src/data/` owns the repository interface and D1 implementation.
- Routes and components depend on the repository boundary rather than issuing D1 queries directly.

M2 adds protected source intake, normalized source references, human-reviewed satire candidates, immutable candidate-to-story provenance, and an append-only audit log. M3 adds immutable normalized-event versions, assertion-level source provenance, model-run cost/usage records, and idempotent DRAFT-candidate generation behind a narrow repository boundary. Candidate conversion creates only a `DRAFT` story. `publishStory()` is the sole operation that can assign `PUBLISHED`, and it atomically records the authenticated editor and publication time.

Automated discovery/ingestion, scraping, production model enablement, full-article generation, R2, scheduled triggers, queues, workflows, social automation, advertising vendors, analytics vendors, public accounts, comments, and submissions remain intentionally out of scope.

## Production D1 migrations

Production migrations are an explicit reviewed operation. They must not be added to the automatic Worker deployment command or Workers Builds configuration.

When production infrastructure is authorized and configured:

1. Create the production D1 database explicitly.
2. Replace the local placeholder `database_id` in `wrangler.jsonc` with the returned production database ID. Configure a distinct preview database before enabling branch previews.
3. Review every unapplied file in `migrations/` and confirm the target database name.
4. Inspect pending migration state:

   ```powershell
   npx wrangler d1 migrations list tomorrow-ish --remote
   ```

5. Apply the reviewed migration set as a separate operator action:

   ```powershell
   npx wrangler d1 migrations apply tomorrow-ish --remote
   ```

6. Verify the applied migrations before deploying application code.

`seed.sql` may be loaded into production only as the explicitly reviewed optional demo-content step in the production runbook. Never include it in an automatic build, migration, or deployment command.

## Production deployment model

Production deployment configuration remains deferred until the M1 build has been validated and the Cloudflare resources exist.

Follow the reviewed [production deployment runbook](./docs/production-deployment.md) to verify the bound production D1 database, apply migrations explicitly, configure domains and redirects, and perform the first deployment. The production database UUID is recorded in `wrangler.jsonc`; migrations and deployment remain separate reviewed actions.

The [M2 production onboarding runbook](./docs/m2-production-onboarding.md) records the explicit Cloudflare Access, `0002` migration, and category reference-data procedure. None of those production actions run during local development or deployment builds.

Migration `0003_governed_generation.sql` is not applied by deployment. Before any future M3 production rollout, review the migration, confirm `0001` and `0002` are already applied and `0003` is the only pending migration, back up/verify production data, then use the same explicit `wrangler d1 migrations apply DB --remote` operator action. Do not configure or deploy a production model adapter as part of that schema action.

The [M3 provider runbook](./docs/m3-provider-review.md) records the prepared OpenAI adapter, request contract, budget, secret command, and separately reviewed enablement steps. Production generation remains disabled, and `OPENAI_API_KEY` must never be committed.

When configured, connect the existing GitHub repository to **Cloudflare Workers Builds**:

- Use `main` as the production branch.
- Use non-production branch builds for previews when a separate preview D1 binding is available.
- Run `npm run build` and deploy the generated Worker plus static assets with Wrangler.
- Keep production D1 migration commands out of build and deploy steps.
- Attach `tomorrow-ish.news` as the canonical custom domain.
- Configure Cloudflare hostname redirects from `tomorrow-ish.com` and any public preview hostname to the canonical `.news` hostname while preserving paths and query strings.

## Publication boundary

The domain model recognizes these states:

```text
DRAFT → REVIEW → APPROVED → PUBLISHED → ARCHIVED
```

Rejection and revision paths are explicit. Generated or draft content has no route that can publish directly.

M2 preserves the same transition validity but narrows authority: generic story updates and transitions reject `PUBLISHED`; candidate state has no `PUBLISHED` value; conversion inserts a literal `DRAFT`; only the explicit, confirmed publication service can perform `APPROVED → PUBLISHED` with its audit entry in the same D1 transaction.
