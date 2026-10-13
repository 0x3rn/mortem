# ADR-0002: Next.js 16 on OpenNext Cloudflare and Dedicated Scan Worker

- **Status:** Accepted
- **Date:** 2026-10-13
- **Issue:** `THE-170`

## Context

Mortem combines two fundamentally different workloads:

1. **Interactive web application (`apps/web`):** Serves the marketing site, URL intake API (`POST /api/scans`), SSE/polling live scan progress, interactive autopsy reports, public share links (`/s/[token]`), billing webhooks, and workspace dashboards with low latency.
2. **Asynchronous diagnostic pipeline (`workers/scan`):** Performs sitemap/internal-link discovery, dual-viewport headless Chromium rendering (`1440×900` desktop and `390×844` mobile), axe-core injection, 7-category check evaluation, CrUX/PageSpeed enrichment, and verified AI remediation synthesis over 30–60 seconds per scan.

Running multi-page headless browser captures and check evaluation inside synchronous web request handlers would cause request timeouts, starve UI responsiveness, and couple user-facing page loads to heavy crawl execution.

## Decision

We split the runtime into a **two-Worker Cloudflare topology** inside an npm workspaces monorepo (`apps/*`, `workers/*`, `packages/*`):

1. **`apps/web` (`@mortem/web`):** Next.js 16 (App Router) + React 19 + Tailwind CSS 4 deployed to Cloudflare Workers via `@opennextjs/cloudflare`. It validates intake URLs, persists scan records to Cloudflare D1, enqueues scan jobs onto Cloudflare Queues, and renders live progress and completed reports from D1 and R2.
2. **`workers/scan` (`@mortem/scan-worker`):** A dedicated Cloudflare Worker package with `fetch`, `queue`, and `scheduled` handlers. It consumes jobs from Cloudflare Queues, drives Cloudflare Browser Rendering, stores raw HTML/DOM snapshots, screenshots, and PDFs in Cloudflare R2, writes structured findings and scores to Cloudflare D1, and runs scheduled re-scans and retention cleanup via Cron Triggers.
3. **`packages/core` (`@mortem/core`):** A shared, zero-runtime-bloat TypeScript package consumed by both `apps/web` and `workers/scan` so URL normalization, category weights, rule definitions, finding schemas, and scoring formulas have a single source of truth.

## Consequences

- **Positive:** Heavy browser rendering and multi-page crawling never block `apps/web` request handling; retries and dead-letter handling are managed per stage via Cloudflare Queues.
- **Positive:** Both Workers share the exact same D1 database, R2 bucket bindings, and `@mortem/core` TypeScript contracts without cross-cloud egress fees.
- **Trade-off:** Local development and CI verify two Worker packages (`apps/web` and `workers/scan`) plus `@mortem/core`, managed uniformly through root npm workspace scripts (`typecheck`, `lint`, `test`, `build`).
