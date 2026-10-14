# ADR 0011: Crawl Budgets, Retry Classification, and Leak-Free Browser Cleanup (`THE-179`)

- **Status:** Accepted
- **Date:** 2026-10-14
- **Issue:** `THE-179`

## Context

Cloudflare Workers and Cloudflare Browser Rendering enforce strict CPU, memory, and concurrent browser session limits. A hostile or misconfigured target site (for example, an infinite sitemap, a `>10 MB` single-page HTML document, slow-loris responses, or repeated transient `429`/`503` errors) could exhaust Worker execution limits, leak headless Chromium contexts, or waste queue retry attempts on permanent errors (`404`, `ssrf_blocked`, invalid TLS, redirect loops). Furthermore, if a multi-page scan hits its wall-clock or browser budget after already capturing one or more pages, discarding the entire scan deprives the user of valuable partial diagnostics.

## Decision

1. **Hard Per-Scan Crawl Budgets (`CrawlBudgetEnforcer`):**
   - `resolveScanBudgets` merges workspace plan defaults (`single` = 1 page, `pro`/`agency` = 5 pages) with per-scan `scans.budgets_json` and `scans.options_json` overrides:
     - `maxWallTimeMs` (default `90,000ms`)
     - `maxBrowserMs` (default `60,000ms`)
     - `maxPages` (plan-bounded)
     - `maxBytesPerPage` (default `10,485,760` bytes / `10 MB`)
     - `maxExternalLinkChecks` (default `50`)
     - `perFetchTimeoutMs` (default `10,000ms` via `AbortSignal.timeout`)
     - `perPageTimeoutMs` (default `25,000ms`)
   - Before each page capture in `workers/scan`, `budgetEnforcer.checkBeforeNextPage(nowMs)` checks `maxPages`, `maxBrowserMs`, and `maxWallTimeMs`.
   - If a budget is exceeded after at least one page has been captured, remaining `pending` pages in D1 are marked `capture_status = 'skipped'` with the budget reason, and the scan completes as `status = 'partial'` with `failure_class = 'budget_exceeded'` while preserving all captured pages and R2 evidence.
   - If a rendered DOM snapshot exceeds `maxBytesPerPage`, `enforceHtmlPayloadBudget` deterministically truncates the UTF-8 HTML payload to `maxBytesPerPage`, appends `<!-- [MORTEM_TRUNCATED: HTML exceeded maxBytesPerPage budget] -->`, and marks the capture `partial` (`failure_class = 'budget_exceeded'`).

2. **Transient vs. Permanent Error Classification (`classifyScanErrorForRetry`):**
   - Queue stage errors are inspected before deciding whether to call `message.retry()`:
     - **Permanent (`retryable: false`):** `SsrfBlockedError` (`ssrf_blocked`), DNS `ENOTFOUND`/`NXDOMAIN` (`dns_resolution_failed`), `robots_disallowed`, TLS certificate errors (`ERR_CERT_*`), redirect loops (`ERR_TOO_MANY_REDIRECTS`), and permanent HTTP `404`/`410` target failures immediately transition the scan to `status = 'failed'` via `handleDeadLetterScanMessageInD1` and acknowledge (`message.ack()`) the message without wasting retries.
     - **Transient (`retryable: true`):** Browser Rendering capacity limits (`429`), upstream `502`/`503`/`504`, and navigation timeouts call `message.retry({ delaySeconds: computeRetryBackoffSeconds(attempt) })`.

3. **Leak-Free Browser Session Pool (`createBrowserSessionPool`):**
   - `createBrowserSessionPool` wraps `Browser`, `BrowserContext`, and `Page` lifecycles with reference-counted tracking (`activeBrowsers`, `activeContexts`, `activePages`, `totalContextsOpened`, `totalContextsClosed`, `totalPagesOpened`, `totalPagesClosed`), enforces `maxConcurrentBrowsers`, and guarantees `page.close()`, `context.close()`, and `browser.close()` in `finally` blocks even when navigation or screenshot capture throws mid-flight.

4. **Cost & Usage Telemetry (`updateScanUsageInD1`):**
   - Every scan updates `scans.usage_json` with `browserMs`, `browserDurationMs`, `r2BytesWritten`, `psiCalls`, `psiRequests`, `pagesDiscovered`, and `pagesCaptured`.
