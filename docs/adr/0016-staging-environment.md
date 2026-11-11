# ADR 0016: Staging Environment on Its Own Cloudflare Resources

- **Status:** Accepted
- **Date:** 2026-11-11
- **Issue:** follows `THE-213` (staging was configured there but never provisioned)

## Context

Live checks were blocked on production. Starting a scan needs a signed-in account, and test accounts must not be created on the production site. The `staging` sections in `apps/web/wrangler.jsonc` and `workers/scan/wrangler.jsonc` had never been deployed:

- they pointed at a placeholder D1 id;
- the web app's staging env shared the production OpenNext cache bucket;
- `npm run d1:migrate:staging` looked up a database named `mortem-db`, which does not exist under `--env staging`.

## Decision

1. **Separate resources for everything that holds data.**

   | Resource | Name                                                         |
   | -------- | ------------------------------------------------------------ |
   | D1       | `mortem-db-staging` (`6d79ded8-ce32-4b83-b7f6-a604b2f79769`) |
   | R2       | `mortem-evidence-staging`, `mortem-opennext-cache-staging`   |
   | Queues   | `mortem-scans-staging`, `mortem-scans-dlq-staging`           |
   | Workers  | `mortem-staging` (web), `mortem-scan-staging`                |

   Browser Run is per account and is shared.

2. **Address:** `https://staging.mortem.corstack.dev`, a Workers custom domain. `BETTER_AUTH_URL` matches it. The scan worker stays at `mortem-scan-staging.somtochukwu-ike.workers.dev`.

3. **Its own secrets.** `BETTER_AUTH_SECRET` is newly generated, so sessions never cross between environments. `PAGESPEED_API_KEY` is the same key as production.

   Staging deliberately has no `TURNSTILE_SECRET_KEY` and no `RESEND_API_KEY`:
   - Turnstile is skipped.
   - Sign-up codes are not emailed.
   - Test accounts use `@mortem.test` addresses. Outside production, the app returns their one-time code in the response (`devTestOtpCode`). This path already existed for E2E tests and is disabled when `ENVIRONMENT` is `production`.

4. **No cron on staging.** The account is on the Workers Free plan, which allows 5 cron triggers, and other projects already use them. `scheduled()` does no work yet, so staging overrides `triggers.crons` to `[]`. Revisit this when the cron starts doing work, such as a stalled-scan sweeper.

5. **Fixed the migrate script.** `d1:migrate:staging` now applies migrations to `mortem-db-staging`. All 6 migrations are applied.

## Consequences

- Scans, accounts and evidence on staging never touch production data.
- Deploys to staging:
  - scan worker: `npx wrangler deploy --env staging` in `workers/scan`;
  - web app: `npm --workspace @mortem/web run deploy:staging`.

  The CI `deploy-staging` job runs the same commands once `ENABLE_CLOUDFLARE_DEPLOY` is enabled.

- Staging has no bot protection on sign-up. It is a test site; intake rate limits and the read-only crawl policy still apply.
- Data sits in Cloudflare resources that cost money once usage exceeds the free allowances.
