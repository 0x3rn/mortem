# ADR 0008: Isolated Browser Run Playwright Capture for Desktop and Mobile Viewports (`THE-176`)

- **Status:** Accepted
- **Date:** 2026-10-14
- **Linear Issue:** `THE-176`

## Context

Mortem diagnoses modern websites across both desktop and mobile viewports. Many production websites rely on client-side JavaScript hydration, dynamic viewport-dependent layouts, and network requests that continue long-polling after initial render. At the same time, rendering untrusted external URLs inside a headless browser requires strict isolation, SSRF and read-only enforcement on every navigation and subresource request, and accurate detection of WAF/anti-bot challenge screens so Mortem never grades a Cloudflare or CAPTCHA interstitial as the target website.

## Decision

1. **Isolated Desktop and Mobile Contexts (`BROWSER_VIEWPORT_PROFILES` in `packages/core/src/browser-capture.ts`):**
   - Every page capture creates two fresh, isolated `BrowserContext` instances on Cloudflare Browser Run (`@cloudflare/playwright` via `env.BROWSER`):
     - `desktop`: `1440×900`, `deviceScaleFactor: 1`, `isMobile: false`, `hasTouch: false`
     - `mobile`: `390×844`, `deviceScaleFactor: 3`, `isMobile: true`, `hasTouch: true`
   - Both contexts run with `READ_ONLY_SCAN_POLICY.userAgent` (`MortemBot/1.0 (+https://mortem.dev/bot; read-only diagnostic crawler)`), `locale: "en-US"`, `timezoneId: "UTC"`, `serviceWorkers: "block"`, and empty cookies/storage.
   - Every `Page`, `BrowserContext`, and `Browser` handle is closed inside `finally` blocks regardless of whether navigation or screenshot capture succeeds or throws.

2. **Read-Only and SSRF Request Filtering (`inspectBrowserRequestSafety`):**
   - A Playwright `page.route("**/*", ...)` interceptor inspects every outgoing navigation and subresource request:
     - Blocks any non-read-only HTTP method (`POST`, `PUT`, `PATCH`, `DELETE`) so the browser never submits forms or mutates remote state.
     - Validates every HTTP(S) request URL and every redirect hop against `validateAndNormalizeIntakeUrl` (blocking `localhost`, loopback, RFC1918 private networks, link-local/cloud metadata `169.254.169.254`, IPv6 local ranges, and unsafe schemes).

3. **Bounded Wait Strategy with Partial Fallback (`captureSingleViewportInIsolatedContext`):**
   - Navigation waits for `domcontentloaded` (default `20_000` ms) followed by a bounded `networkidle` wait (default `4_000` ms) and a gentle read-only scroll pass to trigger lazy near-fold hydration.
   - If `networkidle` times out, the page is **not** dropped: Mortem captures the hydrated DOM, timings (`ttfbMs`, `domContentLoadedMs`, `loadEventMs`, `fcpMs`, `lcpMs`, `cls` via `PerformanceObserver`), console/network logs, and full-page + above-the-fold screenshots at the timeout mark and flags the capture as `partial`.

4. **WAF and Bot-Challenge Detection (`detectBotChallengeOrBlock`):**
   - Inspects HTTP status codes, `cf-mitigated` headers, page titles, and rendered DOM for Cloudflare interstitials (`Just a moment...`, `/cdn-cgi/challenge-platform/`), Cloudflare Turnstile blocks, CAPTCHA challenges, WAF `403 Access Denied` pages, and HTTP `429` rate limits.
   - Flags matching responses as `blocked` (`failureClass: "upstream_blocked"`, `dbCaptureStatus: "skipped"`) so challenge screens are never scored as site content.

## Consequences

- Client-rendered SPAs are captured with hydrated DOM, lab Core Web Vitals (`LCP`, `CLS`, `FCP`, `TTFB`), and dual-viewport screenshots.
- Pages with persistent analytics or streaming connections degrade gracefully to `partial` instead of failing the scan.
- WAF/bot challenges fail honestly with `upstream_blocked` provenance rather than producing misleading diagnostic scores.
