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

Both commands operate on local state. The seed script is idempotent and does not run as part of a production deployment.

## Develop

```powershell
npm run dev
```

Astro runs against Cloudflare's local Workers runtime and the local `DB` binding. The public application reads only stories whose status is `PUBLISHED`.

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
- `src/domain/` owns publication state and editorial data types.
- `src/data/` owns the repository interface and D1 implementation.
- Routes and components depend on the repository boundary rather than issuing D1 queries directly.

The publishable MVP includes only `categories`, `stories`, and `sources`. Editorial UI, automated generation, candidate tables, generation-run tables, R2, scheduled triggers, queues, workflows, social automation, advertising vendors, and analytics vendors are intentionally out of scope.

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

Do not run `seed.sql` against production.

## Production deployment model

Production deployment configuration remains deferred until the M1 build has been validated and the Cloudflare resources exist.

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

Rejection and revision paths are explicit. Generated or draft content has no route that can publish directly. M1 contains no editorial interface or automated publishing mechanism.
