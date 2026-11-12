# Security rule catalog (`THE-183`)

Rule version: `1.0.0` (stored as `findings.check_version`). Every rule id below is emitted by `@mortem/core` (`SECURITY_RULES`); a test fails if a rule is added to the code without being documented here.

## Passive only

Mortem never probes for vulnerabilities, scans ports, fuzzes inputs or signs in. The rules read evidence Mortem already stored while loading each page like a normal visitor:

- the document's response headers;
- the TLS details Chromium negotiated (`response.securityDetails()`);
- the `Set-Cookie` headers on the document (`response.allHeaders()`), stored **without their values**;
- `http://` requests the page made, and Chrome's "Mixed Content" console messages.

On top of that, the checking stage makes one ordinary request to the homepage's `http://` address. It uses `HEAD`, falling back to `GET`, and follows at most 5 redirects. Every hop goes through the same SSRF and DNS checks as scan intake. The result is stored as a scan-level `headers` artifact (`reports/headers_http_probe.json`).

## How findings are produced

- **One finding per rule per scan**, with one `finding_occurrences` row per affected page. TLS rules have one row per host.
- **Evidence:** each occurrence cites the page's `headers` artifact. Mixed content reported by Chrome cites the `console_log` artifact. Redirect rules cite the probe artifact.
- **Severity and priority:** severity is the worst across occurrences. Provisional `priority_score`: high `75`, medium `45`, low `20`; final ranking belongs to `THE-191`.
- **Missing evidence:** nothing is invented. A page with no stored headers is skipped. Pages captured before this release have no TLS, cookie or insecure-request evidence, so those rules don't run on them. If Chromium reported no TLS details, the TLS rules report nothing for that host. If the `http://` probe could not complete (connection refused, blocked by the SSRF guard, a timeout, or the target blocking bots), no redirect finding is made, and the reason is stored in the probe artifact.
- **Plain-HTTP pages:** a page served over plain HTTP only gets `sec.https.not-used`. The HTTPS header rules don't apply to it.

## Transport rules

| Rule id                    | Fires when                                                                                                                  | Severity      | Fix role  |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------- | --------- |
| `sec.https.not-used`       | A captured page's final URL is `http://`.                                                                                   | high          | developer |
| `sec.https.no-redirect`    | The homepage's `http://` address answers without ending on `https://`.                                                      | high          | developer |
| `sec.https.redirect-chain` | Reaching `https://` from `http://` takes more than 2 redirects.                                                             | low           | developer |
| `sec.hsts.missing`         | An HTTPS page has no `Strict-Transport-Security` header.                                                                    | medium        | developer |
| `sec.hsts.weak`            | `Strict-Transport-Security` has no valid `max-age`, or one under 15,552,000 seconds (180 days).                             | low           | developer |
| `sec.tls.old-protocol`     | Chromium negotiated SSL, TLS 1.0 or TLS 1.1. TLS 1.2, TLS 1.3 and QUIC pass.                                                | high          | developer |
| `sec.tls.cert-expiring`    | The certificate expires within 30 days. High severity within 7 days. The issuer, expiry date and days remaining are stored. | medium / high | developer |

## Header rules (HTTPS pages)

| Rule id                                 | Fires when                                                                                                                                                           | Severity | Fix role  |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------- |
| `sec.header.csp.missing`                | No `Content-Security-Policy`. `Content-Security-Policy-Report-Only` does not count, because it blocks nothing.                                                       | medium   | developer |
| `sec.header.clickjacking.missing`       | No valid `X-Frame-Options` (`DENY`, `SAMEORIGIN`) and no CSP `frame-ancestors`.                                                                                      | medium   | developer |
| `sec.header.nosniff.missing`            | `X-Content-Type-Options` is missing or is not `nosniff`.                                                                                                             | low      | developer |
| `sec.header.referrer-policy.missing`    | No `Referrer-Policy`, or the effective (last) policy is `unsafe-url`.                                                                                                | low      | developer |
| `sec.header.permissions-policy.missing` | No `Permissions-Policy`.                                                                                                                                             | low      | developer |
| `sec.header.version-disclosure`         | `Server`, `X-Powered-By`, `X-AspNet-Version` or `X-AspNetMvc-Version` contains a version number (for example `nginx/1.18.0`, `PHP/8.1`). A bare product name passes. | low      | developer |

## Mixed content

| Rule id                     | Fires when                                                                                                                                       | Severity | Fix role  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | --------- |
| `sec.mixed-content.active`  | An HTTPS page requested a script, stylesheet, frame, font, XHR/fetch or WebSocket over HTTP. Chrome blocks these, so part of the page is broken. | high     | developer |
| `sec.mixed-content.passive` | An HTTPS page requested an image, audio or video over HTTP. Chrome upgrades or loads these, but the page is not fully secure.                    | medium   | developer |

The sources are Chrome's `Mixed Content: … requested an insecure <type> '<url>'` console messages, plus any `http:`/`ws:` request seen while loading the page. `element`, `image`, `video`, `audio` and `favicon` count as passive; everything else counts as active.

## Cookies (`Set-Cookie` on the document response)

| Rule id                       | Fires when                                                                                                                                                                                          | Severity | Fix role  |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------- |
| `sec.cookie.secure-missing`   | A cookie set on an HTTPS page has no `Secure` flag.                                                                                                                                                 | medium   | developer |
| `sec.cookie.httponly-missing` | A cookie whose name looks like a session or login (`sess`, `sid`, `auth`, `token`, `jwt`, `login`, `remember`) has no `HttpOnly`. CSRF/XSRF tokens are excluded, because JavaScript must read them. | medium   | developer |
| `sec.cookie.samesite-missing` | A cookie has no `SameSite` attribute.                                                                                                                                                               | low      | developer |

Cookies set by JavaScript or on redirect responses are not checked. Only the server's `Set-Cookie` on the final document response is.
