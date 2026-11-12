import { evaluateSecurityPageRules } from "@mortem/core";
import { describe, expect, it } from "vitest";
import {
  HTTPS_REDIRECT,
  buildContentSecurityPolicy,
  buildSecurityHeaders,
} from "./security-headers";

const asHeaderMap = (isDev: boolean) =>
  Object.fromEntries(
    buildSecurityHeaders(isDev).map((h) => [h.key.toLowerCase(), h.value]),
  );

describe("Mortem's own security headers", () => {
  it("pass every Mortem security header rule (THE-183)", () => {
    const violations = evaluateSecurityPageRules({
      pageId: "home",
      pageUrl: "https://mortem.corstack.dev/",
      finalUrl: "https://mortem.corstack.dev/",
      headers: asHeaderMap(false),
      mixedContent: [],
      evidence: { headers: "ev_headers", consoleLog: null },
    });
    expect(violations).toEqual([]);
  });

  it("allows only what the app loads and blocks framing", () => {
    const csp = buildContentSecurityPolicy(false);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain(
      "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com",
    );
    expect(csp).toContain("frame-src https://challenges.cloudflare.com");
    expect(csp).not.toContain("unsafe-eval");
    // React dev tooling needs eval; production never gets it.
    expect(buildContentSecurityPolicy(true)).toContain("'unsafe-eval'");
  });

  it("redirects plain HTTP to the same host and path over HTTPS, permanently", () => {
    expect(HTTPS_REDIRECT).toEqual({
      source: "/:path*",
      has: [
        { type: "header", key: "x-forwarded-proto", value: "http" },
        { type: "host", value: "(?<host>.+)" },
      ],
      destination: "https://:host/:path*",
      permanent: true,
    });
  });
});
