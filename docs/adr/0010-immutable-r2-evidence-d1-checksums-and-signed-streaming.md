# ADR 0010: Immutable R2 Evidence Persistence, D1 SHA-256 Metadata, and Signed Streaming (`THE-178`)

- **Status:** Accepted
- **Date:** 2026-10-14
- **Issue:** `THE-178`

## Context

Every finding and score Mortem produces must be grounded in verifiable raw evidence captured during the `capturing` stage so that diagnostic checks and reports can inspect or re-score a scan without re-crawling the live website. Because Cloudflare D1 is optimized for relational queries rather than multi-megabyte screenshots or full DOM snapshots, and because raw evidence belongs to private customer workspaces, we need a clear separation between binary storage, relational metadata, and authenticated delivery.

## Decision

1. **Immutable R2 Object Keys (`env.EVIDENCE`):**
   - Raw payloads are stored in the private `mortem-evidence` R2 bucket under deterministic keys (`scans/{scanId}/pages/{pageId}/{kind}.{ext}` for page-scoped artifacts and `scans/{scanId}/reports/{kind}.{ext}` for report-scoped artifacts).
   - Every captured page persists six core artifacts:
     - `html` (`scans/{scanId}/pages/{pageId}/html.html`, `text/html; charset=utf-8`)
     - `headers` (`scans/{scanId}/pages/{pageId}/headers.json`, `application/json; charset=utf-8`)
     - `screenshot_desktop` (`scans/{scanId}/pages/{pageId}/screenshot_desktop.png`, plus `screenshot_desktop_above_fold.png`)
     - `screenshot_mobile` (`scans/{scanId}/pages/{pageId}/screenshot_mobile.png`, plus `screenshot_mobile_above_fold.png`)
     - `network_log` (`scans/{scanId}/pages/{pageId}/network_log.json`, `application/json; charset=utf-8`)
     - `console_log` (`scans/{scanId}/pages/{pageId}/console_log.json`, `application/json; charset=utf-8`)
   - Element-scoped screenshots (`screenshot_element`) are supported under `scans/{scanId}/pages/{pageId}/screenshot_element_{suffix}.{ext}`.

2. **D1 Metadata & SHA-256 Integrity (`evidence_artifacts`):**
   - Before writing to R2, `writeEvidenceArtifactToR2AndD1` computes a 64-character lowercase SHA-256 hex digest using Web Crypto (`crypto.subtle.digest("SHA-256", bytes)`).
   - D1 `evidence_artifacts` stores only `id`, `scan_id`, `page_id`, `kind`, `r2_key`, `byte_size`, `sha256`, `metadata_json` (including `contentType`, viewport dimensions, and above-the-fold references), and `created_at`.
   - Total bytes written are accumulated in `scans.usage_json.r2BytesWritten`.

3. **Authenticated & Signed Streaming Route (`GET /api/evidence/[artifactId]`):**
   - Because `env.EVIDENCE` is a private R2 binding, `apps/web` serves artifacts through `/api/evidence/[artifactId]`.
   - Access is granted only when at least one of the following succeeds:
     1. **Short-lived HMAC-SHA256 Token (`?token={expiresAtMs}.{sig}`):** Verified with constant-time signature comparison over `v1:{artifactId}:{scanId}:{workspaceId}:{expiresAtMs}`.
     2. **Report Share Token (`?shareToken=...`):** Verified against `report_shares` joined with `reports` for the artifact's `scan_id` (ensuring `revoked_at IS NULL` and `expires_at` is in the future).
     3. **Workspace Session Membership:** Verified via `requireWorkspaceAccess(d1, userId, workspaceId, "viewer")`.
   - Unauthenticated or cross-workspace requests return `403 Forbidden`; missing artifacts return `404 Not Found`.
   - Valid responses stream with `Cache-Control: private, max-age=3600`, `ETag: "{sha256}"` (supporting `304 Not Modified` via `If-None-Match`), `X-Content-Type-Options: nosniff`, and a strict sandboxed `Content-Security-Policy`.
