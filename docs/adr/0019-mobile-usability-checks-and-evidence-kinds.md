# ADR 0019: Mobile Usability Checks and the 0006 Evidence-Kind Migration (`THE-184`)

- **Status:** Accepted
- **Date:** 2026-11-12
- **Issue:** `THE-184`

## Context

Mortem must show whether a site works on a phone: the viewport tag, sideways scrolling, tap targets, small text and overlays that cover the screen. Every finding must cite stored evidence: the mobile screenshot or a crop, the element's selector and its box. The measurements happen during capture, but the rules run later in the checking stage, so the raw measurements have to be stored. None of the allowed evidence kinds fits, and SQLite cannot change the `kind` CHECK constraint in place.

## Decision

1. **Measure in the mobile capture.** `MOBILE_AUDIT_SCRIPT` runs once in the 390×844 phone context, after the screenshots and axe. It only reads the page, then scrolls back to the top. It measures:
   - **the screen width** from `document.documentElement.clientWidth`, not `innerWidth`: in Chrome's mobile mode, `innerWidth` grows to the widest content when zoom is allowed, which would hide the very overflow being measured;
   - **the page width** from `<html>`'s `scrollWidth`: `overflow-x: hidden` on `body` alone does not stop a phone page from being wider, while on `html` it does;
   - **each tap target's real tap area**, by probing outward from its centre with `elementFromPoint`. This credits `::before`/`::after` hit areas, padding and stretched card links. On GitHub, box size alone reported 6 px dots that really have a ~28×33 px area. Where tap areas overlap, only the part each target owns counts;
   - **WCAG 2.5.8's exceptions:** links inside a sentence, and checkboxes or radios with a label.

   The results are stored as `mobile_raw`. Up to 5 offending elements are cropped and stored as `screenshot_element` with `source: "mobile"`. If the audit fails or times out, the reason is stored and the page is skipped, never passed.

2. **8 `mobile.*` rules** (`docs/rule-catalog/mobile.md`) run in the checking stage after security and before PageSpeed, through the shared findings writer. Each element occurrence stores its selector and box, and cites its crop, the mobile screenshot, or `mobile_raw` (in that order of preference). Without a viewport tag, only `mobile.viewport.missing` and any overlay are reported, because sizes measured on a 980 px desktop layout would only repeat that problem.

3. **Migration 0006 rebuilds `evidence_artifacts`.** It allows `mobile_raw`, plus `links_raw`, reserved for THE-185 so the rebuild only happens once. Three tables reference the evidence table:
   - `finding_occurrences` (`RESTRICT`);
   - `page_performance_results` and `reports` (`SET NULL`);
   - and `report_shares` references `reports` (`CASCADE`).

   Dropping a referenced table runs an implicit DELETE that fires those actions. With foreign keys on (D1 cannot turn them off), SQLite also rewrites child references when a parent is renamed, regardless of `legacy_alter_table`. So the migration:
   1. renames the old table aside, and its children follow;
   2. creates the new table and copies every row;
   3. rebuilds the children against it, with the same rename-aside step for `reports`;
   4. drops the old tables only once nothing references them.

   Column definitions are copied verbatim from 0002 and 0004.

4. **One deliberate schema change:** `finding_occurrences.evidence_artifact_id` becomes `ON DELETE NO ACTION` instead of `RESTRICT`. Evidence cited by a finding still cannot be deleted on its own. The check now runs at the end of the statement, so deleting a scan cascades cleanly whatever order SQLite visits child tables in. That order changed with the rebuild, and with `RESTRICT` a scan delete failed: an existing test caught it.

## Consequences

- One `mobile_raw` per page and up to 5 crops. The audit took 7–308 ms on real sites, and about 1.9 s on GitHub (111 targets probed).
- Tap-target findings report the measured tap area, not just the drawn box, so a small icon with a large hit area is not flagged.
- Migration 0006 must be applied before the new scan worker is deployed. Without it, writing `mobile_raw` would fail the capture.

## Verification

- `migration-0006.test.ts` uses real data in every referencing table and checks:
  - every row and link survives;
  - the rebuilt tables keep identical columns, keys, actions and indexes, apart from the one `NO ACTION` change;
  - nothing references a `_pre_0006` copy;
  - a scan delete cascades;
  - the new kinds are accepted and unknown kinds rejected.
- 10 mutations on the migration SQL were all caught.
- The migration also ran:
  - on a fresh local D1 through Wrangler;
  - on the **staging** database with real data: evidence 210, occurrences 201, performance 16 (16 linked) and findings 49 all identical afterwards, with a clean `foreign_key_check`.
- `mobile-checks.test.ts` (14): a passing and a failing fixture for every rule, plus boundaries, evidence choice, the occurrence cap and a catalog drift test.
- `mobile-checks-runner.test.ts` (4): uses the production evidence writer and covers skipped and failed audits and idempotency.
- `mobile-audit.browser.test.ts` (10) runs real Chromium with the production phone profile:
  - a bad page with every problem planted, and a clean page with none;
  - overflow precision (outermost element only, scroll containers, fixed elements, `html` vs `body` hiding);
  - tap-target exemptions, crowding, and real tap areas (`::before`, stretched links);
  - scroll-back, failure handling, and end to end through storage and rules.
- 33 mutations on the rules, runner and in-page script were all caught. The 11 that survived the first run each led to a new fixture, and two real measurement bugs were found that way: `innerWidth`, and `body` scroll width.
- Live (`MOBILE_LIVE=1`): mortem.corstack.dev, morrow.corstack.dev, example.com and BBC News are clean. info.cern.ch gets `mobile.viewport.missing`. GitHub's carousel dots own only 9–18×30 px each, because their enlarged tap areas overlap, so they are flagged too small. The pseudo-element hit area was confirmed by reading GitHub's computed styles.
