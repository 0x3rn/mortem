# Performance rule catalog (`THE-180`)

Rule version: `1.0.0` (stored as `findings.check_version`). Source: Google PageSpeed Insights v5, `category=PERFORMANCE`, `strategy=MOBILE` and `DESKTOP`. Verified against live responses from PageSpeed running **Lighthouse 13.6.0** (recorded fixtures in `packages/core/src/__fixtures__/psi/recorded-*.json`).

Every rule id below is also emitted by `@mortem/core` (`PERFORMANCE_RULE_IDS`); a test fails if a rule is added to the code without being documented here.

## How findings are produced

- One finding per rule per scan (`UNIQUE(scan_id, check_id)`), with one `finding_occurrences` row per **page + strategy** that breached the rule.
- Each occurrence cites the stored `psi_raw` artifact (`scans/{scanId}/pages/{pageId}/psi_raw_{strategy}.json`) that the numbers came from.
- Lab data (`lighthouseResult`) and real-user field data (CrUX `loadingExperience`) are **never blended**. Field data is URL-level when PageSpeed has it, otherwise origin-level, otherwise reported as unavailable.
- A rule only fires on a measured value. Missing, errored or not-applicable audits produce **no finding** and are visible as `missing` / `error` / `not_applicable` in `page_performance_results.audits_json`.
- Provisional `priority_score`: high `70`, medium `45`, low `20`. Final ranking by severity, effort and business impact belongs to `THE-191`.

## Metric rules

Rating bands follow web.dev: a value `<= good` is good, `> poor` is poor, anything between needs improvement. Needs improvement raises a `medium` finding, poor raises a `high` finding. The finding's severity is the worst across its occurrences.

| Rule id                | Source | Metric                                              | Good    | Poor    | Effort | Impact | Fix role  |
| ---------------------- | ------ | --------------------------------------------------- | ------- | ------- | ------ | ------ | --------- |
| `perf.lab.lcp`         | lab    | Largest Contentful Paint                            | 2500 ms | 4000 ms | medium | high   | developer |
| `perf.lab.cls`         | lab    | Cumulative Layout Shift                             | 0.1     | 0.25    | medium | medium | developer |
| `perf.lab.tbt`         | lab    | Total Blocking Time                                 | 200 ms  | 600 ms  | high   | high   | developer |
| `perf.lab.fcp`         | lab    | First Contentful Paint                              | 1800 ms | 3000 ms | medium | medium | developer |
| `perf.lab.speed-index` | lab    | Speed Index                                         | 3400 ms | 5800 ms | medium | medium | developer |
| `perf.lab.ttfb`        | lab    | Server response time (`server-response-time` audit) | 800 ms  | 1800 ms | medium | high   | devops    |
| `perf.field.lcp`       | field  | CrUX LCP, 75th percentile                           | 2500 ms | 4000 ms | medium | high   | developer |
| `perf.field.inp`       | field  | CrUX INP, 75th percentile                           | 200 ms  | 500 ms  | high   | high   | developer |
| `perf.field.cls`       | field  | CrUX CLS, 75th percentile                           | 0.1     | 0.25    | medium | medium | developer |

PageSpeed reports the CrUX CLS percentile multiplied by 100 (for example `5` means `0.05`); the parser divides by 100. Confirmed in every recorded response: the CLS distribution bucket bounds are `10` and `25`, i.e. `0.1` and `0.25`.

## Lighthouse audit rules

An audit fires when Lighthouse marks it as an opportunity (score below `0.9`, or a failed binary audit). Severity comes from the potential savings: `high` at `>= 1000 ms` or `>= 500 KiB`, `medium` at `>= 300 ms` or `>= 100 KiB`, otherwise `low`.

Where savings come from (Lighthouse 13): time savings from `details.overallSavingsMs`, or for insight audits the largest of `metricSavings` LCP / FCP / TBT / INP; byte savings from `details.overallSavingsBytes`, or for insight audits `details.debugData.wastedBytes`.

`dom-size-insight` is special: Lighthouse 13 sometimes scores it and sometimes reports it as informative only (the recorded CNN pages with 2,640 and 4,537 elements still had score `1`). When it is informative, Mortem applies its own threshold to the element count: more than **1,400 elements** is an opportunity (`medium`), otherwise it passes.

Occurrence excerpts cite up to three items with their wasted bytes or milliseconds. Only real `http(s)` URLs are cited as assets; when Lighthouse reports inline CSS or JavaScript (its `url` column then holds a code snippet such as `@font-face { … }`), the excerpt says `inline code on the page` instead.

| Rule id                           | Lighthouse 13 audit       | Replaces (pre-13 audit ids)                     | Effort | Impact | Fix role  |
| --------------------------------- | ------------------------- | ----------------------------------------------- | ------ | ------ | --------- |
| `perf.audit.render-blocking`      | `render-blocking-insight` | `render-blocking-resources`                     | medium | high   | developer |
| `perf.audit.image-delivery`       | `image-delivery-insight`  | `uses-optimized-images`, `modern-image-formats` | low    | medium | developer |
| `perf.audit.unused-javascript`    | `unused-javascript`       | (unchanged)                                     | medium | high   | developer |
| `perf.audit.unused-css-rules`     | `unused-css-rules`        | (unchanged)                                     | medium | medium | developer |
| `perf.audit.server-response-time` | `server-response-time`    | (unchanged)                                     | medium | high   | devops    |
| `perf.audit.dom-size`             | `dom-size-insight`        | `dom-size`                                      | high   | medium | developer |

`offscreen-images` (requested in the original issue) was removed in Lighthouse 13 with no replacement, so Mortem has no rule for it.

## When PageSpeed data is unavailable

The result row is stored with `status = 'unavailable'`, a machine-readable `unavailable_reason`, a human-readable `unavailable_message`, and **no** lab or field data. No Lighthouse score is ever estimated.

| Reason                     | Meaning                                                                                                                                                                                | Retried?         |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `api_key_missing`          | `PAGESPEED_API_KEY` not configured; PageSpeed was not called                                                                                                                           | n/a              |
| `api_key_rejected`         | HTTP 401/403 or Google rejected the key                                                                                                                                                | no               |
| `quota_exceeded`           | HTTP 429 (daily quota is not retried; per-minute limits are)                                                                                                                           | per-minute only  |
| `timeout`                  | No answer within the attempt window (up to 240 s, shrunk to what is left of the 10-minute stage budget), or the budget ran out before the call could start                             | no               |
| `network_error`            | The request could not be made or the connection dropped                                                                                                                                | yes (2 attempts) |
| `upstream_error`           | HTTP 5xx                                                                                                                                                                               | yes (2 attempts) |
| `invalid_request`          | HTTP 4xx other than the above                                                                                                                                                          | no               |
| `target_unreachable`       | Google's fetcher could not load the page (blocked or down)                                                                                                                             | no               |
| `lighthouse_runtime_error` | Lighthouse ran but reported an error on the page, either inside an HTTP 200 (`runtimeError`) or as an HTTP 4xx with reason `lighthouseUserError` (recorded live: `NO_FCP` as HTTP 400) | no               |
| `invalid_response`         | The response was not the expected PageSpeed JSON                                                                                                                                       | no               |

Field data that PageSpeed does not have (low-traffic sites) is shown as: `Not enough real-user traffic (CrUX unavailable)`.

Browser Run navigation timings captured during crawling (desktop viewport only) are stored in `navigation_timings_json` on the desktop row as supplementary context. They are labelled `source: browser_run` and are not a Lighthouse result.

## Timing

Live calls recorded for this catalog took between 7 s and 215 s, and transient failures (an HTTP 500, a connection dropped at 60 s) succeeded on a later call. So each call gets up to 240 s and one retry, at most 3 calls run at once, and all PageSpeed work in a scan's `checking` stage shares a 10-minute budget (below the 15-minute Cloudflare Queue consumer limit). Each attempt's timeout is shrunk to the time left; a call that cannot start with at least 10 s left is recorded as `timeout` without being made.

## Keeping the mapping current

If a future Lighthouse drops or renames a mapped audit, it is recorded as `missing` in `audits_json` (never treated as passed), and no finding fires for it. Re-record fixtures with `scripts/record-psi-fixtures.mjs`, then update `PSI_MAPPED_AUDIT_IDS` / `PERFORMANCE_AUDIT_RULES` and this page; a test fails if the two drift apart.
