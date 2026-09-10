# M2 production onboarding

This runbook is deliberately manual. It does not authorize a production D1 migration, Cloudflare Access change, or Worker deployment. Complete each phase only after the exact values and pending changes have been reviewed.

## Runtime configuration introduced by M2

M2 reuses the existing `DB` and `ASSETS` bindings. It adds no service binding or application secret.

The editorial authentication middleware requires these non-secret Worker variables in production:

- `CF_ACCESS_TEAM_DOMAIN`: the account's Access issuer, such as `https://TEAM.cloudflareaccess.com`
- `CF_ACCESS_AUD`: the Audience tag copied from the Access application
- `EDITORIAL_ALLOWED_EMAIL`: `newsgoblin@tomorrow-ish.news`

If any value is missing or malformed, or the signed Access identity is not the allowed email, `/editorial` fails closed with HTTP 403.

## Manual Cloudflare Access setup

Do not configure Access until M2 production onboarding is explicitly authorized.

1. Open **Cloudflare Zero Trust → Access → Applications**.
2. Add a **Self-hosted** application named `Tomorrow-ish Editorial`.
3. Add both application paths on the canonical hostname:
   - domain `tomorrow-ish.news`, path `editorial`
   - domain `tomorrow-ish.news`, path `editorial/*`
4. Do not protect the apex hostname without a path. The public publication must remain accessible without authentication.
5. Create an **Allow** policy named `Tomorrow-ish editor` with an Include rule for the exact email `newsgoblin@tomorrow-ish.news`.
6. Do not add an Everyone, email-domain, or bypass policy.
7. Select the intended identity provider. Require MFA in that identity provider and verify MFA enrollment for the editor mailbox.
8. Set the Access application session duration to eight hours.
9. Save the application and copy its **Application Audience (AUD) tag**.
10. Record the account's Access team domain in the exact `https://TEAM.cloudflareaccess.com` form.
11. Add the three non-secret values to the top-level `vars` object in `wrangler.jsonc`, replacing the reviewed team domain and audience values:

    ```jsonc
    "vars": {
      "CF_ACCESS_TEAM_DOMAIN": "https://TEAM.cloudflareaccess.com",
      "CF_ACCESS_AUD": "REVIEWED_APPLICATION_AUD_TAG",
      "EDITORIAL_ALLOWED_EMAIL": "newsgoblin@tomorrow-ish.news"
    }
    ```

12. Run `npm run types`, inspect `worker-configuration.d.ts`, run the full validation gate, and commit the reviewed configuration separately before deployment.

After a separately authorized M2 deployment, verify:

- `/`, `/latest`, `/archive`, public story routes, `robots.txt`, and `sitemap.xml` remain public;
- `/editorial` and `/editorial/*` challenge an unauthenticated browser;
- the authorized mailbox can enter after MFA;
- another authenticated identity is denied;
- the Worker returns 403 if its Access assertion is removed or invalid;
- editorial responses include `Cache-Control: private, no-store` and cannot be framed.

Cloudflare Access is the sole production identity provider. The application does not maintain accounts, passwords, login callbacks, or persistent sessions.

## Reviewed production migration procedure

Migration `0002_editorial_workflow.sql` is append-only and schema-only. It creates editorial intake, source-reference, candidate, and audit tables, then adds nullable candidate provenance to `stories`. It does not alter `0001_initial.sql` and does not publish content.

From a clean checkout of the approved M2 commit:

```powershell
git switch main
git pull --ff-only origin main
git status --short --branch
git rev-parse HEAD
npx wrangler whoami
npx wrangler d1 migrations list DB --remote
Get-Content -Raw .\migrations\0002_editorial_workflow.sql
```

Confirm all of the following before proceeding:

- the checked-out commit is the separately accepted M2 commit;
- the target is binding `DB`, database `tomorrow-ish-production`;
- `0002_editorial_workflow.sql` is the only pending migration;
- the migration content matches the accepted commit;
- an explicit production-migration approval has been issued.

Apply only after that approval:

```powershell
npx wrangler d1 migrations apply DB --remote
npx wrangler d1 migrations list DB --remote
npx wrangler d1 execute DB --remote --command "SELECT name, type FROM sqlite_schema WHERE name IN ('source_intakes','source_references','satire_candidates','editorial_audit_log','idx_stories_origin_candidate_id') ORDER BY type, name"
npx wrangler d1 execute DB --remote --command "SELECT name FROM pragma_table_info('stories') WHERE name = 'origin_candidate_id'"
```

The migration command must remain separate from `npm run deploy` and Workers Builds.

## Reviewed category reference data

`Florida, Probably` is ordinary category data, not a schema rule or application special case. Review and apply it separately after migration approval:

```powershell
Get-Content -Raw .\reference-data\0002_m2_categories.sql
npx wrangler d1 execute DB --remote --file=.\reference-data\0002_m2_categories.sql
npx wrangler d1 execute DB --remote --command "SELECT id, slug, name FROM categories WHERE id = 'cat-florida-probably'"
```

The statement is idempotent. Do not add this command to deployment automation.

## Deployment remains a later authority decision

Only after Access configuration, migration, reference data, and deployment are each separately approved should the standard validation and deployment sequence be considered:

```powershell
npm ci
npm test
npm run check
npm run build
npx wrangler deploy --dry-run
git diff --check
```

The real `npx wrangler deploy` command is intentionally omitted from this M2 onboarding run. M2 publication actions become reachable only after a later reviewed deployment behind the configured Access application.
