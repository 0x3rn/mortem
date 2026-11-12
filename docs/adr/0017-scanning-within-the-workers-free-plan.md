# ADR 0017: Scanning Within the Workers Free Plan

- **Status:** Accepted
- **Date:** 2026-11-12
- **Issue:** follow-up to `THE-179` and ADR 0015, found by the first scans on staging (ADR 0016)

## Context

The owner chose to keep the Cloudflare account on **Workers Free**. The first real scans on staging both ended `failed`. Logs recorded with `wrangler tail` showed why:

- A capture run that captured several pages ended with `exceededCpu`, at 64 ms of CPU. The queue then redelivered the stage. This is the likely cause of the production redelivery behind ADR 0015.
- The retries failed with `Unable to create new browser: code: 429: message: Rate limit exceeded`. Cloudflare's Browser Run limits for Workers Free are:
  - 3 concurrent browsers;
  - **1 new browser every 20 seconds**;
  - **10 minutes of browser time per day**, reported as "Browser time limit exceeded for today".
- Any error on one page escaped the whole capture stage. Every retry hit the same page, and after 3 retries the dead-letter handler marked the scan `failed`, discarding pages that were already captured.
- The 429 was recorded as `navigation_timeout`, which hid the real cause.

## Decision

1. **One page per capture run.** The capture stage captures at most `CAPTURE_PAGES_PER_RUN` (1) page and then returns the new stage outcome `requeue`. The pipeline sends the same stage again with `delaySeconds: 20`, matching the Free rate of one new browser every 20 seconds. A requeue writes no stage event and keeps the stage's idempotency key, so the next run is not skipped. The stage records its event once, after the last page. Each run re-reads the budgets and counts pages from D1 (ADR 0015), so budgets still cover the whole scan.

2. **Browser Run refusals are recognised** by `classifyBrowserRunLimitError`:
   - **Rate limited:** the page stays `pending` and the stage runs again after 30 s, with no queue retry used up.
   - **Daily limit:** the remaining pages are marked `skipped` with `BROWSER_DAILY_LIMIT_REASON`. The scan continues and ends `partial` (`budget_exceeded`), or `failed` if nothing was captured.

3. **A page that fails does not sink the scan.** Navigation and browser errors mark that page `failed`, with `<failure class>: <message>` as its reason, and capture moves on. Infrastructure errors (`internal_error`) still go to the queue for a retry. If any page failed, the scan ends `partial` with "N of M page(s) could not be captured". If every page failed, it ends `failed` with that reason instead of being reported as a WAF block.

4. **A dead-lettered capture stage keeps its pages.** This covers a page whose run keeps exceeding the CPU limit, which can't be caught in code. If any page was captured, the dead-letter consumer:
   - marks the pages still pending `failed` with `DEAD_LETTERED_CAPTURE_PAGE_REASON`;
   - records the capture event with a `partialCoverage` marker (`internal_error`);
   - sends the scan on to checking.

   With nothing captured, the scan fails as before.

5. **A repeated run with nothing pending captures nothing.** The single-target fallback now applies only to scans that never recorded a page. Before, a repeated run would have re-captured the homepage.

## Consequences

- A 6-page scan takes about 6 minutes instead of 1–2, because the gaps between pages are deliberate.
- Browser time is the scarce resource: about 15 s per page, so 10 minutes per day is roughly 40 pages a day across production and staging, which share the account. When it runs out, scans end `partial` or `failed` with a clear reason, not a misleading one.
- CPU enforcement on Free is not strictly applied per run. On staging, one-page runs used 184–688 ms of CPU and completed, while an earlier multi-page run was stopped at 64 ms. The dead-letter path above is the safety net.
- Moving to Workers Paid only needs `CAPTURE_PAGES_PER_RUN` and the delays raised; nothing else depends on the plan.

## Verification

- `workers/scan/src/index.test.ts` covers:
  - one page per run, 20 s apart, with the same idempotency key;
  - a failing page ends the scan `partial`, and all pages failing ends it `failed`;
  - a Browser Run 429 leaves the page pending and retries after 30 s;
  - the daily limit ends the scan `partial`;
  - a repeated run with no pending pages captures nothing;
  - dead-letter recovery with and without captured pages.
- `packages/core/src/crawl-budgets.test.ts` covers the classifier, using the real staging message.
- 21 mutations across the worker, the pipeline and the classifier were all caught.
- On staging, a real scan of morrow.corstack.dev completed: 6/6 pages, 7 SEO, 4 accessibility and 6 performance findings, with no exceptions in the logs. A second staging scan, with its browser budget tightened to 15 s, ended `partial` (`budget_exceeded`). It captured 2/6 pages, checked both, and marked the other 4 `skipped`. Browser time added up across the two separate runs (29.7 s).
