# ADR 0013: Deterministic SEO Checks over Captured Evidence (`THE-181`)

- **Status:** Accepted
- **Date:** 2026-11-11
- **Issue:** `THE-181`

## Context

Mortem must report on-page SEO problems (titles, descriptions, headings, canonicals, indexability, language tags, social tags, structured data, image alt text) and problems that only show up across pages (duplicate titles, canonical loops). The capture stage already stores each page's rendered HTML and response headers in R2. Findings must be evidence-backed and deterministic, and re-running a queue stage must not duplicate them.

## Decision

1. **Rules run over stored evidence, not a new fetch.** `runSeoChecks` (`packages/core/src/seo-checks-runner.ts`) reads each captured page's `html` and `headers` artifacts back from R2 and runs pure functions (`extractSeoFacts`, `evaluateSeoRules` in `seo-checks.ts`) built on Cheerio. The rules therefore see the rendered DOM (after JavaScript), the same snapshot the evidence viewer shows. No request is made to the target site.

2. **27 versioned rules** (`seo.*`, rule version `1.0.0`): 23 per-page and 4 cross-page, documented in `docs/rule-catalog/seo.md`. Thresholds are constants in code (`SEO_TITLE_MIN_CHARS` …) and a test keeps the catalog and the code identical. Title length is measured in characters; pixel width is not estimated.

3. **Evidence per occurrence.** Each occurrence cites the `html` artifact, or the `headers` artifact when the violation comes from `X-Robots-Tag`. Cross-page duplicates store every affected URL and each page's exact text.

4. **Honest limits.**
   - A page with no stored HTML (or an object missing from R2) is skipped with a stated reason in the stage metadata, never scored.
   - On a truncated snapshot, `seo.h1.missing` is not claimed.
   - Cross-page rules only reason about pages in the scan: an `hreflang` alternate that was not scanned is not claimed as missing a return link.
   - `X-Robots-Tag` directives addressed to other named crawlers are ignored; `googlebot` and unnamed directives apply.

5. **Sitemap membership is persisted.** Migration `0005` adds `pages.discovery_sources_json` (default `'[]'`); `persistDiscoveredPagesInD1` now stores how each page was found. `seo.indexability.sitemap-conflict` fires only for pages discovery actually found in the sitemap. Pages discovered before the migration are never claimed.

6. **One findings writer for all check families.** `replaceFindingsByPrefix` (`findings-store.ts`) deletes and re-inserts one family's findings (`perf.` or `seo.`) in a single D1 batch. It refuses a rule outside the family and any prefix that is not `lowercase.`, so one family can never delete another's findings. The performance checks were moved onto it with no behaviour change (their tests pass unchanged).

7. **SEO runs before PageSpeed in the `checking` stage.** SEO only reads R2 and takes seconds; PageSpeed can take minutes. A missing or unreadable `EVIDENCE` binding fails the scan explicitly (non-retryable) instead of silently skipping checks.

## Consequences

- Migration `0005` must be applied before this build is deployed: the Drizzle `pages` model now includes the new column, and the discovery stage writes it.
- Rules see the rendered DOM rather than the server HTML. A site whose server HTML is fine but whose JavaScript removes a tag is reported on what visitors' browsers end up with.
- Verified on real pages (web.dev, cnn.com, info.cern.ch, example.com, developer.mozilla.org, bbc.com/news) with an opt-in live test (`src/seo-checks.live.test.ts`, `SEO_LIVE=1`): no parser crashes, and no false positives were seen (for example BBC's two identical canonicals and its `noodp`/`noydir` robots tokens are correctly not flagged).
