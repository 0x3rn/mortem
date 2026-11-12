# ADR 0018: Passive Security Checks from Captured Evidence (`THE-183`)

- **Status:** Accepted
- **Date:** 2026-11-12
- **Issue:** `THE-183`

## Context

Mortem must show a business owner the visible security weaknesses of their site: HTTPS, TLS, security headers, mixed content and cookie flags. It must do this without behaving like an attacker: no vulnerability probing, port scanning, fuzzing or signing in. Every finding has to point at stored evidence, and nothing may be guessed when the browser cannot report something.

## Decision

1. **Capture records the evidence.** While each page loads, capture also records (`collectDocumentSecurity`):
   - the TLS details Chromium negotiated (`response.securityDetails()`): protocol, issuer, subject, valid-from and valid-to;
   - the document's `Set-Cookie` headers (`response.allHeaders()`), parsed into name plus flags. **Cookie values are never stored.**
   - any `http:`/`ws:` request made by an HTTPS page.

   When the browser can't report TLS or cookies, the reason is stored instead. This goes into the existing `headers` artifact under `security`. Chrome's "Mixed Content" console messages were already stored in `console_log`. No migration is needed: the artifact kinds are fixed by a database constraint, and these fit the existing `headers` kind.

2. **One plain request for the HTTPS redirect.** The checking stage requests the homepage's `http://` address once, reusing the intake preflight: `HEAD` (with `GET` as fallback), at most 5 redirects, SSRF and DNS checks on every hop, and a 10 s timeout per request. The result is stored as a scan-level `headers` artifact (`reports/headers_http_probe.json`). If the request can't complete, the finding is not made and the reason is stored. Tests never make this request.

3. **18 versioned `sec.*` rules** (`docs/rule-catalog/security.md`), run in the checking stage after SEO and accessibility and before PageSpeed. They are written with the shared `replaceFindingsByPrefix`, so a redelivered stage replaces only `sec.*` findings.
   - One finding per rule, with one occurrence per page. TLS rules have one occurrence per host.
   - Header rules apply only to HTTPS pages. A plain-HTTP page gets `sec.https.not-used` only.

4. **No invented values.** Rules that depend on TLS details, cookies or insecure requests don't run for pages captured before this change, or where the browser reported nothing. The checking-stage metadata counts those pages.

## Consequences

- No new database tables or artifact kinds, and one extra `HEAD` request per scan.
- Chrome blocks active mixed content before any request is sent, and it treats `127.0.0.1` and `localhost` as trusted. So mixed content is read mainly from Chrome's own console message. A real-Chromium test pins that message's format, using a mapped hostname.
- Cookies set by JavaScript or on redirect responses are out of scope. Only the server's `Set-Cookie` on the final document is checked.
- `HttpOnly` is only required for session-like cookie names. Analytics and preference cookies would be noise, and CSRF tokens must stay readable by JavaScript.

## Verification

- `security-checks.test.ts` (23 tests): a passing and a failing fixture for every rule, the parsers, boundaries, missing evidence, and a catalog drift test.
- `security-checks-runner.test.ts` (7 tests): uses the production evidence writer and covers the evidence cited, every probe outcome, skipped pages, older captures and idempotency.
- `security-capture.browser.test.ts`: real Chromium against local HTTP and HTTPS servers, covering TLS details, the `\n`-joined `set-cookie`, Chrome's exact mixed-content message and no cookie values. Worker test: the checking stage writes `sec.*` findings.
- 33 mutations across the rules, runner, collector and evidence writer were all caught; the 3 that survived the first run each led to a stronger test.
- Live (`SECURITY_LIVE=1`) on mortem.corstack.dev, morrow.corstack.dev, example.com, github.com and info.cern.ch. Each result was checked independently with `curl`:
  - the plain-HTTP addresses of mortem, morrow and example.com answer `200` without redirecting;
  - GitHub redirects in 1 hop and is missing only `Permissions-Policy`;
  - info.cern.ch is plain HTTP.
- Staging scan of morrow.corstack.dev (`scan_36b4752887446e4699a0`) ended `complete`. All 6 pages were checked, all with security evidence, and 7 security findings were written: 6 header rules on every page, plus `sec.https.no-redirect` from the `http://` check run inside the Worker.
