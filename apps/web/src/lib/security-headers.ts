/**
 * Security headers and the HTTP → HTTPS redirect for Mortem's own site.
 *
 * Mortem's security checks (THE-183) found that mortem.corstack.dev answered on
 * http:// without redirecting and sent none of these headers. The values below
 * pass every `sec.header.*` / `sec.hsts.*` rule (see the unit test).
 *
 * CSP without nonces (Next.js "Without Nonces" pattern), so pages can stay
 * statically rendered: Next.js needs inline scripts and styles. The only
 * third-party origin is Cloudflare Turnstile (script + iframe); Cloudflare Web
 * Analytics is allowed in case it is enabled on the zone.
 */

const TURNSTILE = "https://challenges.cloudflare.com";
const CF_INSIGHTS_SCRIPT = "https://static.cloudflareinsights.com";
const CF_INSIGHTS_BEACON = "https://cloudflareinsights.com";

export function buildContentSecurityPolicy(isDev: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""} ${TURNSTILE} ${CF_INSIGHTS_SCRIPT}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    `connect-src 'self' ${TURNSTILE} ${CF_INSIGHTS_BEACON}`,
    `frame-src ${TURNSTILE}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
}

export interface HeaderEntry {
  key: string;
  value: string;
}

export function buildSecurityHeaders(isDev: boolean): HeaderEntry[] {
  return [
    {
      key: "Strict-Transport-Security",
      value: "max-age=31536000; includeSubDomains",
    },
    {
      key: "Content-Security-Policy",
      value: buildContentSecurityPolicy(isDev),
    },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    {
      key: "Permissions-Policy",
      value:
        "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
    },
  ];
}

/**
 * Cloudflare marks the original scheme in `X-Forwarded-Proto`. A plain-HTTP
 * request is sent to the same host and path over HTTPS (308 keeps the method).
 */
export const HTTPS_REDIRECT = {
  source: "/:path*",
  has: [
    { type: "header" as const, key: "x-forwarded-proto", value: "http" },
    { type: "host" as const, value: "(?<host>.+)" },
  ],
  destination: "https://:host/:path*",
  permanent: true,
};
