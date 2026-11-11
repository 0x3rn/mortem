# ADR 0014: axe-core Accessibility Audit inside Browser Run (`THE-182`)

- **Status:** Accepted
- **Date:** 2026-11-11
- **Issue:** `THE-182`

## Context

Mortem must show which accessibility barriers a site has, who they affect, and the exact elements involved, without ever presenting an automated scan as WCAG conformance. axe-core needs a live DOM, so it has to run while the page is open in Browser Run during capture; findings, like the other check families, are produced later in the `checking` stage from stored evidence.

## Decision

1. **Run axe during capture, per viewport.** `runAxeInPage` (`packages/core/src/axe-runner.ts`) runs after each viewport's screenshots inside `captureSingleViewportInIsolatedContext`, with tags `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa`, `best-practice` and `resultTypes: ["violations"]`. Bot-challenge screens are not audited.

2. **Inject with `page.evaluate(source)`, not `addScriptTag`.** DevTools evaluation is not subject to the page's Content-Security-Policy; a `<script>` tag is. Verified in Chromium against a page with `script-src 'none'`. This departs from the issue text on purpose.

3. **Never fail a capture because of axe.** A 20 s timeout per viewport; errors, timeouts and a missing source return a status and reason that are stored as the `axe_raw` artifact, so the reason is evidence too.

4. **Evidence.** `axe_raw` (per viewport) holds the full axe result plus each flagged element's document-coordinate bounding box. Up to 5 crops per viewport (most severe first; empty, off-page and page-sized boxes skipped) are taken with a clipped full-page screenshot and stored as `screenshot_element` with `source: "axe"`, rule, selector and box.

5. **Findings from stored evidence.** `runAccessibilityChecks` reads `axe_raw` back from R2, maps it (`accessibility-checks.ts`) and writes `a11y.<axe rule>` findings through the shared findings writer: one finding per rule across pages and viewports, occurrences with selector, HTML snippet, reason, bounding box, and the crop when one exists. WCAG criteria come from a table of all 87 WCAG 2.2 criteria; best-practice-only rules are labelled as such. Who is affected comes from axe's category tags. The coverage note is attached to every finding and to the stage metadata.

6. **Bundling.** The Worker imports axe's minified browser build as a **string** through a Wrangler `Text` rule with the glob `**/axe.min.js`. A dry-run bundle showed that more specific globs (`**/node_modules/axe-core/axe.min.js`) silently fall back to bundling axe as executable JavaScript, which would have made every production audit fail; a test now guards the rule. Vitest loads the same file as a string through a matching plugin, and a test checks the worker's `AXE_SOURCE` equals the file byte for byte.

7. **Order in the `checking` stage:** SEO, then accessibility (both read stored evidence and take seconds), then PageSpeed (minutes).

## Consequences

- axe adds browser time to every capture: measured 0.4–0.8 s per viewport on small pages and 1.3–2.8 s on bbc.com/news. That time counts toward `maxBrowserMs`. Scans already fail with `budget_exceeded` under the intake's 60 s wall-clock budget (seen in production for morrow.corstack.dev before this change), so the crawl budgets should be revisited.
- The Worker bundle grows by axe's minified build (upload 4.91 MB, 1.05 MB gzipped, from 4.25 MB / 0.87 MB).
- Pages captured before this release have no `axe_raw`; they are reported as `not_captured`, never as passing.
- Verified with real Chromium: planted violations, WCAG tags, bounding boxes and crops at 1× and 3× scale (`axe-runner.browser.test.ts`), and live end to end on mortem.corstack.dev (0 violations, 2 needs-review rules), info.cern.ch (missing `lang` 3.1.1, target size 2.5.8) and bbc.com/news (unnamed button 4.1.2, untitled iframe) via `A11Y_LIVE=1 npx vitest run src/accessibility-checks.live.test.ts`.
