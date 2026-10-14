# ADR 0006: Two-Layer URL Intake SSRF Defense (DNS-over-HTTPS + Manual Redirect Inspection) and D1 Abuse Guards

- **Status:** Accepted
- **Date:** 2026-10-14
- **Issue:** `THE-173`

## Context

Mortem accepts arbitrary user-supplied website URLs and renders them inside Cloudflare Workers and Cloudflare Browser Rendering (`@cloudflare/playwright`). Accepting untrusted URLs introduces two primary threat vectors:

1. **Server-Side Request Forgery (SSRF):** An attacker submits `localhost`, `127.0.0.1`, RFC1918 private ranges (`10/8`, `172.16/12`, `192.168/16`), link-local / cloud metadata (`169.254.169.254`, `fe80::/10`), CGNAT (`100.64.0.0/10`), IPv6 Unique Local (`fc00::/7`), internal DNS suffixes (`.local`, `.internal`, `.localhost`), non-standard ports (`:8080`, `:22`), a public domain with an `A`/`AAAA`/`CNAME` record pointing to an internal IP, or a public URL that `302`-redirects to an internal IP.
2. **Resource / Cost Amplification Abuse:** Because each scan triggers multi-page headless browser captures, PageSpeed Insights requests, and AI token synthesis, unthrottled or duplicate submissions can exhaust Cloudflare budgets or overwhelm a third-party origin.

Because Cloudflare Workers `fetch()` does not expose raw socket IP binding, SSRF protection must verify both the URL syntax and the resolved DNS records before any HTTP request is issued and on every redirect hop.

## Decision

1. **Canonical URL Normalization (`validateAndNormalizeIntakeUrl` in `@mortem/core`):**
   - Defaults to `https://` when no scheme is provided, lowercases and Punycode-normalizes the hostname, canonicalizes the root slash, strips `#hash` fragments, and removes marketing/tracking query parameters (`utm_*`, `gclid`, `fbclid`, `msclkid`, `mc_cid`, `mc_eid`, `_ga`, `_gl`) so equivalent URLs map to the same canonical `normalized_url`.
   - Permits only `http:` and `https:` on ports `80` and `443`.
   - Rejects embedded credentials, IPv4/IPv6 literals (including integer/hex/octal encodings), `localhost`, and `.local` / `.internal` / `.localhost` / `.home.arpa` / `.corp` / `.lan` suffixes with `ScanIntakeError("ssrf_blocked")`.

2. **DNS-over-HTTPS (`1.1.1.1`) Resolution + Multi-Hop Manual Redirect Validation (`resolveAndValidateHostDns` & `preflightAndValidateTargetUrl`):**
   - Queries `https://cloudflare-dns.com/dns-query` (`application/dns-json`) for `A` and `AAAA` records.
   - Verifies that at least one public IP resolves (`dns_failed` otherwise) and that **every** resolved `A`, `AAAA`, and `CNAME` record passes `isBlockedIpAddress` / `isBlockedHostname` (`ssrf_blocked` otherwise).
   - Performs a lightweight `HEAD` reachability pre-check (falling back to `GET` on `405`/`501`) with `redirect: "manual"` up to `5` hops, re-validating URL syntax and DoH DNS on **every redirect hop** before following or enqueueing the final URL.
   - Classifies failures into `invalid_url`, `ssrf_blocked`, `dns_failed`, `unreachable`, `tls_error`, and `bot_blocked`.

3. **D1-Backed Rate Limits, Duplicate In-Flight Detection & Turnstile Hook (`submitScanIntake`):**
   - Tracks intake events in `scan_intake_events` (`0003_intake_rate_limits.sql`) indexed by `(workspace_id, created_at)`, `(ip_hash, created_at)`, and `(target_host, created_at)` to enforce per-workspace, per-IP (SHA-256 hashed), and per-target-host rate limits.
   - Rejects duplicate in-flight scans (`status IN ('queued', 'discovering', 'capturing', 'checking', 'scoring', 'generating_report')`) for the same `(workspace_id, normalized_url)` with `409 Conflict` (`duplicate_in_flight`).
   - Verifies Cloudflare Turnstile tokens (`https://challenges.cloudflare.com/turnstile/v0/siteverify`) for anonymous preview scans when `TURNSTILE_SECRET_KEY` is configured.
