# ADR 0012: PageSpeed Insights Integration and Honest Performance Data (`THE-180`)

- **Status:** Accepted
- **Date:** 2026-10-14
- **Issue:** `THE-180`

## Context

Lighthouse cannot run inside Cloudflare Workers, but Mortem must report lab performance and real-user Core Web Vitals. Google PageSpeed Insights (PSI) v5 provides both: a Lighthouse run (`lighthouseResult`) and CrUX field data (`loadingExperience`, `originLoadingExperience`). PSI is slow (live calls recorded for this ADR took 7 s to 215 s), quota-limited, occasionally fails transiently (an HTTP 500, a connection dropped at 60 s, both of which succeeded on a later call), and sometimes cannot load a target at all. Mortem's non-negotiable is honest data: a missing measurement must be shown as unavailable, never estimated.

## Decision

1. **PSI is called from the `checking` stage of `mortem-scan`** (`runPerformanceChecks` in `@mortem/core`, wired in `workers/scan/src/index.ts`), once per strategy (`MOBILE`, `DESKTOP`, `category=PERFORMANCE`) on prioritized pages only: the homepage first, then one page per remaining template type in priority order, capped at 3 pages (`PSI_MAX_PAGES_PER_SCAN`) to protect quota and cost. Concurrency is capped at 3 (`PSI_DEFAULT_CONCURRENCY`).

2. **HTTP is injected, parsing is pure.** `fetchPageSpeedInsights` takes `fetchFn`/`sleep`; `parsePsiResponse` and `evaluatePerformanceRules` are deterministic. Unit tests run against fixtures with no network.

3. **Timeouts, retries and a stage budget** (`fetchPageSpeedInsights`, `runPerformanceChecks`): each call may take up to 240 s (`PSI_DEFAULT_TIMEOUT_MS`; 215 s was observed live) and gets one retry (2 attempts) with a 1 s backoff, honouring `Retry-After` capped at 30 s, for network errors, HTTP 5xx and per-minute 429s only. Never retried: daily quota exhaustion (the recorded response says "Queries per day"), rejected keys (Google answers an invalid key with HTTP 400 "API key not valid"), bad requests, unreachable targets, Lighthouse errors on the page (recorded live as HTTP 400 `lighthouseUserError`, e.g. `NO_FCP`) and timeouts. All PSI work in one `checking` stage shares a 10-minute budget (`PSI_STAGE_BUDGET_MS`, below the 15-minute Queue consumer limit): each attempt's timeout shrinks to the time left, and a call that cannot start with at least 10 s left is recorded as `timeout` without being made. Every attempt counts toward `scans.usage_json.psiCalls`.

4. **Lab and field are stored separately** in a new table `page_performance_results` (migration `0004`), one row per `(page_id, strategy)`. A SQL `CHECK` makes it impossible to store lab or field data on an `unavailable` row, or to store an `ok` row without them. Unavailable rows carry a machine-readable reason and a human message. CrUX with no data is `{ available: false, message: "Not enough real-user traffic (CrUX unavailable)" }`.

5. **Raw responses are evidence.** The verbatim PSI body is written to R2 as `psi_raw` (`scans/{scanId}/pages/{pageId}/psi_raw_{strategy}.json`) with a SHA-256 in `evidence_artifacts`, including when Lighthouse reports a runtime error, because that body explains why there is no data.

6. **Findings are derived, evidence-backed and rebuildable.** Threshold breaches and Lighthouse opportunities become `perf.*` findings (see `docs/rule-catalog/performance.md`), each occurrence citing the `psi_raw` artifact and specific asset URLs. On every run all `perf.*` findings of the scan are deleted and re-inserted in one D1 `batch` (a single transaction), so queue redelivery cannot duplicate or leave stale rows. Other categories' findings are untouched.

7. **Missing PSI data does not end the scan.** The `checking` stage returns `continue` with `performance.partial = true` and the per-result reasons in the `scan_events` metadata. Scoring (`THE-190`) is expected to exclude the performance category with a stated reason when no lab data exists. Infrastructure failures (D1/R2) throw `PlatformBindingError` and use the existing retry classification; a missing `EVIDENCE` binding fails the scan explicitly (non-retryable) rather than skipping silently.

8. **Browser Run timings are supplementary.** Capture-time timings (desktop viewport only) are copied to `navigation_timings_json` on the desktop row, labelled `source: browser_run`. They never populate a Lighthouse score.

9. **Audit mapping follows Lighthouse 13.** Live responses (Lighthouse 13.6.0) showed that `render-blocking-resources`, `uses-optimized-images`, `modern-image-formats` and `dom-size` no longer exist and `offscreen-images` was removed without a replacement. Mortem maps the six audits PSI actually returns: `render-blocking-insight`, `image-delivery-insight` (replaces the two image audits), `unused-javascript`, `unused-css-rules`, `server-response-time` and `dom-size-insight`. Insight savings are read from `metricSavings` (time) and `details.debugData.wastedBytes` (bytes). Lighthouse 13 sometimes reports DOM size as informative only, so Mortem applies its own documented 1,400-element threshold in that case. Inline CSS/JS rows (whose `url` column holds a code snippet) are cited as "inline code on the page", never as an asset URL. There is no `offscreen-images` rule.

10. **Secret handling.** The key is the Worker secret `PAGESPEED_API_KEY` (set with `wrangler secret put`; `.dev.vars` locally). PSI requires it as a query parameter, so the request URL is never logged, and every returned error message is passed through `redactPsiSecrets`. Tests assert the key never appears in D1 or R2 keys. Without a key, PSI is not called and results are `api_key_missing`. (ADR-0003 originally named it `GOOGLE_PAGESPEED_API_KEY`; renamed to match the issue.)

## Consequences

- A scan with PSI enabled makes up to 6 PSI calls (3 pages × 2 strategies), bounded by the 10-minute stage budget. That time is I/O wait inside a queue consumer, not CPU. `maxWallTimeMs` (300 s since ADR 0015) applies to crawling only.
- If a future Lighthouse drops or renames a mapped audit, it is recorded as `missing` in `audits_json` and no finding fires — never a false "pass". Re-record fixtures and update the mapping; a test keeps the code and `docs/rule-catalog/performance.md` in sync.
- Migration `0004` must be applied before this `mortem-scan` build is deployed (done on remote `mortem-db` on 2026-11-10).

## Verification

- Fixtures named `recorded-*` in `packages/core/src/__fixtures__/psi/` are real PSI responses (Lighthouse 13.6.0) for cnn.com (mobile + desktop), web.dev (mobile + desktop), info.cern.ch (mobile + desktop) and httpbin.org (a real CrUX origin fallback), plus real error bodies: daily quota (429), invalid key (400) and Lighthouse `NO_FCP` (400). Screenshots and the raw network log are trimmed (listed in each file's `_mortemFixture.trimmed`); production stores the full response in R2.
- Confirmed against live data: the CrUX CLS percentile is ×100 (distribution bounds 10 and 25), `details.items` shapes for every mapped audit, origin fallback, and errored audits.
- Two fixtures remain `synthetic-*` because no live site produced the case: a page with no CrUX data at all, and an HTTP 200 carrying a `runtimeError`.
- `src/pagespeed.live.test.ts` runs the real orchestrator against the real API end to end when `PAGESPEED_API_KEY` is set (skipped otherwise, so CI spends no quota).
