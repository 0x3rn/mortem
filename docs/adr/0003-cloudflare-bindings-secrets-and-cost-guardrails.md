# ADR-0003: Cloudflare Bindings, Secrets, and Cost Guardrails

- **Status:** Accepted
- **Date:** 2026-10-14
- **Issue:** `THE-213`

## Context

Mortem runs entirely on the owner's self-hosted Cloudflare account (`mortem-web` via `@opennextjs/cloudflare` and `mortem-scan` via Wrangler) with zero runtime dependency on third-party PaaS wrappers. Both Workers bind to shared Cloudflare primitives (`DB`, `EVIDENCE`, `SCAN_QUEUE`, `SCAN_DLQ`, and `BROWSER`).

Without explicit binding contracts and unit-cost guardrails, a missing binding could cause silent fallback behavior, or an unbounded crawl could drive unexpected Browser Rendering or R2/D1 usage.

## Decision

### 1. Required Cloudflare Bindings

- **`DB` (Cloudflare D1):** Relational SQLite database (`mortem-db` in dev/prod, `mortem-db-staging` in staging) storing users, workspaces, sites, scans, pages, findings, scores, reports, and `_platform_smoke_runs`. Migrations live in `packages/core/migrations/`.
- **`EVIDENCE` (Cloudflare R2):** Private object storage bucket (`mortem-evidence` / `mortem-evidence-staging`) storing screenshots, rendered HTML snapshots, network logs, and generated PDFs under `scans/{scanId}/...`.
- **`SCAN_QUEUE` & `SCAN_DLQ` (Cloudflare Queues):** `mortem-web` produces scan jobs onto `SCAN_QUEUE` (`mortem-scans`); `mortem-scan` consumes batches (`max_batch_size: 5`, `max_retries: 3`) and routes exhausted jobs to `SCAN_DLQ` (`mortem-scans-dlq`).
- **`BROWSER` (Cloudflare Browser Rendering):** Bound on `mortem-scan` for `@cloudflare/playwright` desktop (`1440×900`) and mobile (`390×844`) capture inside isolated `BrowserContext` instances.

### 2. Fail-Closed Binding Resolution

Both Workers validate their bindings at request/batch entry using `requireWebBindings` and `requireScanWorkerBindings` from `@mortem/core`. If any required binding is missing or if D1, R2, Queue, or Browser Rendering throws a runtime/quota error, Mortem throws a typed `PlatformBindingError` (`MISSING_BINDING`, `DATABASE_QUERY_FAILED`, `STORAGE_WRITE_FAILED`, `QUEUE_SEND_FAILED`, `BROWSER_RENDER_FAILED`) and returns an explicit `503 Service Unavailable` or retries the queue message — never falling back to mocked or fabricated report data.

### 3. Required Worker Secrets

Stored via `wrangler secret put <NAME>` (and `.dev.vars` locally, never committed):

- `CLOUDFLARE_API_TOKEN` & `CLOUDFLARE_ACCOUNT_ID` (GitHub Actions CI deployment)
- `MORTEM_ADMIN_SECRET` (gates `/api/internal/platform-smoke` in production)
- `BETTER_AUTH_SECRET` & `BETTER_AUTH_URL` (Milestone `01` — `THE-171`)
- `GOOGLE_PAGESPEED_API_KEY` (Milestone `03` — `THE-180`)
- `AI_GATEWAY_TOKEN` / `OPENAI_API_KEY` (Milestone `05` — `THE-191`)
- `STRIPE_SECRET_KEY` & `STRIPE_WEBHOOK_SECRET` (Milestone `08` — `THE-203`)
- `RESEND_API_KEY` (Milestone `10` — `THE-210`)

### 4. Unit Cost Notes & Guardrails

- **Browser Rendering (`BROWSER`):** Billed by browser compute duration and concurrent sessions. Every scan enforces a strict page cap (5 pages on Free Preview, 15 on Single Autopsy, 25–50 on paid plans), a per-page navigation timeout (`25s`), and guaranteed `context.close()` + `browser.close()` in `finally`.
- **R2 (`EVIDENCE`):** Zero egress fees; billed on GB-month storage and Class A (`PUT`) / Class B (`GET`/`HEAD`) operations. Artifacts are written once per captured page and pruned by retention cron jobs.
- **D1 (`DB`):** Billed on rows read and written. All queries on `scans`, `scan_pages`, `findings`, and `_platform_smoke_runs` are indexed to avoid full-table scans.
- **Queues (`SCAN_QUEUE`):** Billed per message operation (write, read, delete). Each scan enqueues one orchestration message with bounded retries (`max_retries: 3`).
