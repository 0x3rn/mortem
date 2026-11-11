# ADR 0015: Scan Budgets Across Queue Redeliveries, and Checking Partial Captures

- **Status:** Accepted
- **Date:** 2026-11-11
- **Issue:** follow-up to `THE-179` and `THE-182` (budget incident found while verifying THE-182)

## Context

A production scan of morrow.corstack.dev (`scan_c564687761dd38109099`, free plan) ended `failed` with "0 pages captured" even though two pages had been captured. The scan events showed what happened:

- The capture stage captured `/` at +9.8 s and `/login` at +35.4 s.
- The queue then redelivered the capture stage. The new run started at +61.3 s, found the 60 s wall-clock budget already spent, and skipped `/register`.
- That run counted only its own captures (0), so it failed the scan. `usage_json.browserMs` was also 0, because browser time was kept only in memory.
- Had it counted the two pages, the old code still ended the scan as `partial` straight from the capture stage, so no SEO, accessibility or performance checks would have run.

Three causes:

1. **Budgets were too tight.** The intake wrote `maxWallClockMs: 60_000` into every scan's `budgets_json`, overriding the 90 s default. With axe-core now running in each viewport (ADR 0014), two pages took about 35 s.
2. **Budgets and counts were per attempt.** A redelivered stage starts a fresh Worker invocation with a fresh `CrawlBudgetEnforcer`. Pages and browser time from earlier attempts were invisible.
3. **A partial capture was terminal.** A budget overrun returned `outcome: "partial"`, which ends the pipeline.

## Decision

1. **Raise the defaults and stop overriding them at intake.** `DEFAULT_SCAN_BUDGETS.maxWallTimeMs` is 300 s and `maxBrowserMs` is 240 s. The intake no longer writes a wall-clock budget, so the defaults apply. The plan page caps (free 5, single 10, ...) still bound cost. The 15-minute queue consumer limit still applies per stage.

2. **Count across attempts.** `CrawlBudgetEnforcer` takes `prior: { browserMs, pagesCaptured }`. The capture stage seeds it from D1:
   - `browserMs` from `scans.usage_json`;
   - `pagesCaptured` from `pages` rows with `capture_status IN ('captured','partial')`.

   Each captured page's browser time is added to `usage_json` straight away, so a run that dies mid-stage still leaves its usage behind. The stage result counts captured pages from D1, not from the current run.

3. **Check partial captures, then end `partial`.** When a budget runs out after at least one page was captured, the capture stage returns `outcome: "continue"` with `partialCoverage: { failureClass: "budget_exceeded", reason }`. The pipeline stores the marker in the stage event's `metadata_json`. When the last stage finishes, `advanceScanStageInD1` looks for a recorded marker (`findRecordedPartialCoverage`). If one exists, the scan ends `partial` with that class and reason instead of `complete`. A capture with zero pages still fails.

## Consequences

- A budget-limited scan is now diagnosed. Its captured pages get SEO, accessibility and performance findings, and the scan is clearly marked `partial` with the reason.
- Budgets now cover the whole scan, not each attempt. A redelivery can no longer reset the browser budget, and it can no longer forget pages already captured.
- Scans can take up to 5 minutes of crawling. Capture cost is still bounded by the plan page caps and `maxBrowserMs`.
- The partial marker is stored in event metadata rather than in a new column, so no migration is needed. An event with malformed metadata is treated as having no marker.

## Verification

- `packages/core/src/crawl-budgets.test.ts`: covers prior-usage seeding, clamping, new usage adding on top of prior usage, and the new defaults.
- `workers/scan/src/index.test.ts`:
  - replays the production incident: a redelivered capture after the wall budget ran out, with 2 pages already captured, now ends `partial`, analyses both pages and records `pagesCaptured: 2`;
  - prior browser time blocks new captures once `maxBrowserMs` is used;
  - prior captured pages count towards `maxPages`;
  - the THE-179 test now drives the scan through checking to a `partial` end.
- 15 mutations across the worker, the pipeline and the enforcer were all caught. Each one reintroduces a cause above or removes part of the fix; the one that survived the first run led to the `maxPages` test.
