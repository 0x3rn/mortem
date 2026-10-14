# ADR 0005: Evidence-Backed Findings and Provenance-Backed Scores on Cloudflare D1

- **Status:** Accepted
- **Date:** 2026-10-14
- **Issue:** `THE-172`

## Context

Mortem diagnoses websites across 7 clinical categories (`performance`, `conversion`, `seo`, `accessibility`, `mobile`, `security`, `links_assets`) and generates AI-narrated remediation reports. Without strict database-level invariants, two failure modes commonly corrupt audit products:

1. **Unverified or hallucinated findings:** A diagnostic rule or LLM narration emits a finding that cannot be traced back to a specific crawled page, check rule, and captured artifact (HTML, screenshot, headers, PageSpeed payload, or `axe-core` result).
2. **Fabricated fallback scores on partial scans:** When an upstream dependency (such as Google PageSpeed Insights or a specific viewport capture) times out, naive implementations substitute a default score (`0`, `50`, or `100`), skewing the overall score and misleading users.

## Decision

We enforce evidence provenance at both the Cloudflare D1 SQLite schema layer (`0002_scans_evidence_findings_reports.sql`) and the shared TypeScript domain layer (`@mortem/core`, `packages/core/src/schema/scans.ts`):

1. **Normalized `findings` + `finding_occurrences` with `ON DELETE RESTRICT` evidence links:**
   - `findings` records the scan-level rule violation (`scan_id`, `check_id`, `check_version`, `category`, `severity`, `effort`, `impact`, `priority_score`, `measured_value_json`, `threshold_json`, `fix_role`).
   - `finding_occurrences` links every concrete instance of a finding to:
     - `finding_id NOT NULL REFERENCES findings(id) ON DELETE CASCADE`
     - `page_id NOT NULL REFERENCES pages(id) ON DELETE CASCADE`
     - `evidence_artifact_id NOT NULL REFERENCES evidence_artifacts(id) ON DELETE RESTRICT`
   - `evidence_artifacts` stores the R2 object key (`r2_key`), `byte_size`, and 64-character hex `sha256` digest.

2. **Provenance-enforced `scores` table for complete and partial scans:**
   - The `scores` table includes a table-level SQL `CHECK` constraint:
     ```sql
     CHECK (
       (included = 1 AND score IS NOT NULL AND exclusion_reason IS NULL)
       OR (
         included = 0
         AND score IS NULL
         AND exclusion_reason IS NOT NULL
         AND length(trim(exclusion_reason)) > 0
       )
     )
     ```
   - `validateCategoryScoreInput()` and `computeWeightedOverallScore()` in `@mortem/core` validate every category score before persistence and re-normalize category weights across `included = true` categories when a scan completes in `partial` status.

## Consequences

- No finding occurrence can exist in D1 without referencing a real captured `page_id` and `evidence_artifact_id`.
- Partial scans never store fabricated numeric scores for unmeasured categories; missing categories explicitly record `included = false`, `score = null`, and a human-readable `exclusion_reason`.
