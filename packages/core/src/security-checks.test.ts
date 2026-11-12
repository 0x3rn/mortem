import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SECURITY_CERT_EXPIRY_URGENT_DAYS,
  SECURITY_CERT_EXPIRY_WARNING_DAYS,
  SECURITY_HSTS_MIN_MAX_AGE_SECONDS,
  SECURITY_RULES,
  cspHasFrameAncestors,
  disclosesVersion,
  evaluateHttpsRedirectProbe,
  evaluateSecurityPageRules,
  evaluateSecurityRules,
  evaluateSecurityTlsRules,
  looksLikeSessionCookie,
  mixedContentFromInsecureRequest,
  parseHstsHeader,
  parseMixedContentConsoleMessage,
  parseSetCookieHeader,
  parseSetCookieHeaders,
  type HttpsRedirectProbe,
  type SecurityPageFacts,
} from "./security-checks";

const NOW = Date.UTC(2026, 10, 12);
const DAY_S = 86_400;

/** Headers that pass every header rule. */
const GOOD_HEADERS: Record<string, string> = {
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=()",
  server: "cloudflare",
};

function facts(overrides: Partial<SecurityPageFacts> = {}): SecurityPageFacts {
  return {
    pageId: "page_1",
    pageUrl: "https://shop.example.test/",
    finalUrl: "https://shop.example.test/",
    headers: { ...GOOD_HEADERS },
    security: {
      tls: {
        protocol: "TLS 1.3",
        issuer: "R11",
        subjectName: "shop.example.test",
        validFrom: NOW / 1000 - 30 * DAY_S,
        validTo: NOW / 1000 + 60 * DAY_S,
      },
      tlsUnavailableReason: null,
      setCookies: [],
      cookiesUnavailableReason: null,
      insecureRequests: [],
    },
    mixedContent: [],
    evidence: { headers: "ev_headers", consoleLog: "ev_console" },
    ...overrides,
  };
}

const withHeaders = (patch: Record<string, string | undefined>) => {
  const headers: Record<string, string> = { ...GOOD_HEADERS };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete headers[k];
    else headers[k] = v;
  }
  return facts({ headers });
};

const ruleIds = (f: SecurityPageFacts) =>
  evaluateSecurityPageRules(f).map((v) => v.ruleId);

describe("security parsers", () => {
  it("parses Set-Cookie attributes and never keeps the value", () => {
    const c = parseSetCookieHeader(
      "session_id=SECRET-VALUE-123; Path=/; Domain=.shop.example.test; Secure; HttpOnly; SameSite=Lax",
    );
    expect(c).toEqual({
      name: "session_id",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
      domain: ".shop.example.test",
      path: "/",
    });
    expect(JSON.stringify(c)).not.toContain("SECRET-VALUE-123");
    expect(parseSetCookieHeader("theme=dark")).toMatchObject({
      name: "theme",
      secure: false,
      httpOnly: false,
      sameSite: null,
    });
    expect(parseSetCookieHeader("=novalue; Secure")).toBeNull();
    expect(parseSetCookieHeader("garbage")).toBeNull();
    // Playwright joins repeated set-cookie headers with "\n".
    expect(
      parseSetCookieHeaders("a=1; Secure\nb=2; HttpOnly\n\n").map(
        (c) => c.name,
      ),
    ).toEqual(["a", "b"]);
    expect(parseSetCookieHeaders(undefined)).toEqual([]);
  });

  it("parses HSTS, frame-ancestors and version disclosure", () => {
    expect(
      parseHstsHeader("max-age=63072000; includeSubDomains; preload"),
    ).toEqual({
      maxAge: 63_072_000,
      includeSubDomains: true,
      preload: true,
    });
    expect(parseHstsHeader('max-age="300"').maxAge).toBe(300);
    expect(parseHstsHeader("includeSubDomains").maxAge).toBeNull();
    expect(parseHstsHeader("max-age=abc").maxAge).toBeNull();
    expect(
      cspHasFrameAncestors("default-src 'self'; frame-ancestors 'self'"),
    ).toBe(true);
    expect(cspHasFrameAncestors("default-src 'self'")).toBe(false);
    expect(cspHasFrameAncestors(undefined)).toBe(false);
    expect(disclosesVersion("nginx/1.18.0")).toBe(true);
    expect(disclosesVersion("PHP/8.1")).toBe(true);
    expect(disclosesVersion("4.0.30319")).toBe(true);
    expect(disclosesVersion("cloudflare")).toBe(false);
    expect(disclosesVersion("Next.js")).toBe(false);
    expect(disclosesVersion("Apache")).toBe(false);
  });

  it("parses Chrome's mixed-content console messages", () => {
    expect(
      parseMixedContentConsoleMessage(
        "Mixed Content: The page at 'https://shop.example.test/' was loaded over HTTPS, but requested an insecure script 'http://cdn.example.test/app.js'. This request has been blocked; the content must be served over HTTPS.",
      ),
    ).toEqual({
      url: "http://cdn.example.test/app.js",
      type: "script",
      active: true,
      source: "console",
    });
    expect(
      parseMixedContentConsoleMessage(
        "Mixed Content: The page at 'https://shop.example.test/' was loaded over HTTPS, but requested an insecure element 'http://img.example.test/a.png'. This request was automatically upgraded to HTTPS, For more information see https://blog.chromium.org/2019/10/no-more-mixed-messages-about-https.html",
      ),
    ).toMatchObject({ type: "element", active: false });
    expect(
      parseMixedContentConsoleMessage(
        "Mixed Content: The page at 'https://a/' was loaded over HTTPS, but requested an insecure XMLHttpRequest endpoint 'http://api.example.test/x'. This request has been blocked.",
      ),
    ).toMatchObject({ type: "xmlhttprequest endpoint", active: true });
    expect(
      parseMixedContentConsoleMessage("Uncaught TypeError: x is undefined"),
    ).toBeNull();
    expect(
      mixedContentFromInsecureRequest({
        url: "http://a/x.png",
        resourceType: "image",
      }),
    ).toMatchObject({ active: false, source: "network" });
    expect(
      mixedContentFromInsecureRequest({
        url: "ws://a/socket",
        resourceType: "websocket",
      }),
    ).toMatchObject({ active: true });
  });

  it("recognises session-like cookie names but not CSRF tokens", () => {
    for (const n of [
      "session_id",
      "PHPSESSID",
      "connect.sid",
      "auth_token",
      "jwt",
      "remember_me",
      "laravel_session",
    ]) {
      expect(looksLikeSessionCookie(n), n).toBe(true);
    }
    for (const n of ["theme", "_ga", "csrftoken", "XSRF-TOKEN", "consent"]) {
      expect(looksLikeSessionCookie(n), n).toBe(false);
    }
  });
});

describe("security page rules: passing and failing fixtures", () => {
  it("a well-configured HTTPS page passes every page rule", () => {
    expect(ruleIds(facts())).toEqual([]);
  });

  it("sec.https.not-used fires for a plain-HTTP page and skips HTTPS-only rules", () => {
    expect(
      ruleIds(facts({ finalUrl: "http://shop.example.test/", headers: {} })),
    ).toEqual(["sec.https.not-used"]);
  });

  it("sec.hsts.missing / sec.hsts.weak", () => {
    expect(
      ruleIds(withHeaders({ "strict-transport-security": undefined })),
    ).toEqual(["sec.hsts.missing"]);
    expect(
      ruleIds(
        withHeaders({
          "strict-transport-security": `max-age=${SECURITY_HSTS_MIN_MAX_AGE_SECONDS - 1}`,
        }),
      ),
    ).toEqual(["sec.hsts.weak"]);
    expect(
      ruleIds(
        withHeaders({
          "strict-transport-security": `max-age=${SECURITY_HSTS_MIN_MAX_AGE_SECONDS}`,
        }),
      ),
    ).toEqual([]);
    expect(
      ruleIds(
        withHeaders({ "strict-transport-security": "includeSubDomains" }),
      ),
    ).toEqual(["sec.hsts.weak"]);
  });

  it("sec.header.csp.missing, including report-only", () => {
    const v = evaluateSecurityPageRules(
      withHeaders({
        "content-security-policy": undefined,
        "content-security-policy-report-only": "default-src 'self'",
      }),
    );
    expect(v.map((x) => x.ruleId)).toEqual(["sec.header.csp.missing"]);
    expect(v[0]!.excerpt).toContain("Report-Only");
  });

  it("sec.header.clickjacking.missing: X-Frame-Options or frame-ancestors each protect", () => {
    expect(
      ruleIds(
        withHeaders({
          "x-frame-options": undefined,
          "content-security-policy": "default-src 'self'",
        }),
      ),
    ).toEqual(["sec.header.clickjacking.missing"]);
    expect(ruleIds(withHeaders({ "x-frame-options": undefined }))).toEqual([]);
    expect(
      ruleIds(
        withHeaders({
          "x-frame-options": "sameorigin",
          "content-security-policy": "default-src 'self'",
        }),
      ),
    ).toEqual([]);
    expect(
      ruleIds(
        withHeaders({
          "x-frame-options": "ALLOWALL",
          "content-security-policy": "default-src 'self'",
        }),
      ),
    ).toEqual(["sec.header.clickjacking.missing"]);
  });

  it("sec.header.nosniff.missing", () => {
    expect(
      ruleIds(withHeaders({ "x-content-type-options": undefined })),
    ).toEqual(["sec.header.nosniff.missing"]);
    expect(ruleIds(withHeaders({ "x-content-type-options": "sniff" }))).toEqual(
      ["sec.header.nosniff.missing"],
    );
    expect(
      ruleIds(withHeaders({ "x-content-type-options": "NoSniff" })),
    ).toEqual([]);
  });

  it("sec.header.referrer-policy.missing, including unsafe-url", () => {
    expect(ruleIds(withHeaders({ "referrer-policy": undefined }))).toEqual([
      "sec.header.referrer-policy.missing",
    ]);
    expect(ruleIds(withHeaders({ "referrer-policy": "unsafe-url" }))).toEqual([
      "sec.header.referrer-policy.missing",
    ]);
    // The last valid token wins in a fallback list.
    expect(
      ruleIds(withHeaders({ "referrer-policy": "unsafe-url, no-referrer" })),
    ).toEqual([]);
  });

  it("sec.header.permissions-policy.missing", () => {
    expect(ruleIds(withHeaders({ "permissions-policy": undefined }))).toEqual([
      "sec.header.permissions-policy.missing",
    ]);
  });

  it("sec.header.version-disclosure names each header with a version", () => {
    const v = evaluateSecurityPageRules(
      withHeaders({
        server: "nginx/1.18.0",
        "x-powered-by": "PHP/8.1.2",
        "x-aspnet-version": "4.0.30319",
      }),
    );
    expect(v.map((x) => x.ruleId)).toEqual(["sec.header.version-disclosure"]);
    expect(v[0]!.excerpt).toBe(
      "server: nginx/1.18.0; x-powered-by: PHP/8.1.2; x-aspnet-version: 4.0.30319",
    );
    expect(
      ruleIds(withHeaders({ server: "Apache", "x-powered-by": "Express" })),
    ).toEqual([]);
  });

  it("sec.mixed-content.active / .passive, citing console evidence when the browser reported it", () => {
    const v = evaluateSecurityPageRules(
      facts({
        mixedContent: [
          {
            url: "http://cdn.example.test/app.js",
            type: "script",
            active: true,
            source: "console",
          },
          {
            url: "http://img.example.test/a.png",
            type: "image",
            active: false,
            source: "network",
          },
        ],
      }),
    );
    expect(v.map((x) => x.ruleId)).toEqual([
      "sec.mixed-content.active",
      "sec.mixed-content.passive",
    ]);
    expect(v[0]!.evidenceArtifactId).toBe("ev_console");
    expect(v[1]!.evidenceArtifactId).toBe("ev_headers");
    expect(v[0]!.excerpt).toBe("script: http://cdn.example.test/app.js");
  });

  it("cookie rules: Secure, HttpOnly on session-like cookies, SameSite", () => {
    const cookie = (name: string, attrs: string) =>
      parseSetCookieHeader(`${name}=v; ${attrs}`)!;
    const base = facts();
    const v = evaluateSecurityPageRules({
      ...base,
      security: {
        ...base.security!,
        setCookies: [
          cookie("session_id", "Path=/; SameSite=Lax"), // no Secure, no HttpOnly
          cookie("theme", "Secure; SameSite=Lax"), // fine: not session-like
          cookie("prefs", "Secure; HttpOnly"), // no SameSite
          cookie("auth", "Secure; HttpOnly; SameSite=Strict"), // fine
        ],
      },
    });
    expect(v.map((x) => [x.ruleId, x.context])).toEqual([
      ["sec.cookie.secure-missing", { cookies: ["session_id"] }],
      ["sec.cookie.httponly-missing", { cookies: ["session_id"] }],
      ["sec.cookie.samesite-missing", { cookies: ["prefs"] }],
    ]);
  });

  it("reports nothing it has no evidence for", () => {
    // Bad headers, but no stored headers artifact to cite: nothing is reported.
    expect(
      evaluateSecurityPageRules({
        ...withHeaders({
          "strict-transport-security": undefined,
          "x-content-type-options": undefined,
        }),
        evidence: { headers: null, consoleLog: null },
      }),
    ).toEqual([]);
    // Captured before security evidence existed: header rules still run, cookie/TLS rules do not.
    expect(ruleIds(facts({ security: undefined }))).toEqual([]);
    expect(
      evaluateSecurityTlsRules([facts({ security: undefined })], NOW),
    ).toEqual([]);
  });
});

describe("security TLS rules", () => {
  const tlsFacts = (
    tls: Partial<NonNullable<SecurityPageFacts["security"]>["tls"]>,
    extra: Partial<SecurityPageFacts> = {},
  ) => {
    const base = facts(extra);
    return {
      ...base,
      security: { ...base.security!, tls: { ...base.security!.tls!, ...tls } },
    };
  };

  it("sec.tls.old-protocol fires for TLS 1.0/1.1 only", () => {
    expect(
      evaluateSecurityTlsRules([tlsFacts({ protocol: "TLS 1.1" })], NOW).map(
        (v) => v.ruleId,
      ),
    ).toEqual(["sec.tls.old-protocol"]);
    for (const protocol of ["TLS 1.2", "TLS 1.3", "QUIC"]) {
      expect(
        evaluateSecurityTlsRules([tlsFacts({ protocol })], NOW),
        protocol,
      ).toEqual([]);
    }
  });

  it("sec.tls.cert-expiring: medium within 30 days, high within 7, nothing beyond", () => {
    const at = (days: number) =>
      evaluateSecurityTlsRules(
        [tlsFacts({ validTo: NOW / 1000 + days * DAY_S })],
        NOW,
      );
    expect(at(SECURITY_CERT_EXPIRY_WARNING_DAYS + 1)).toEqual([]);
    expect(at(SECURITY_CERT_EXPIRY_WARNING_DAYS)[0]).toMatchObject({
      ruleId: "sec.tls.cert-expiring",
      severity: "medium",
    });
    expect(at(SECURITY_CERT_EXPIRY_URGENT_DAYS)[0]!.severity).toBe("high");
    expect(at(SECURITY_CERT_EXPIRY_URGENT_DAYS)[0]!.context).toMatchObject({
      daysRemaining: SECURITY_CERT_EXPIRY_URGENT_DAYS,
      issuer: "R11",
    });
  });

  it("checks each host once, and never invents missing TLS details", () => {
    const expiring = { validTo: NOW / 1000 + 3 * DAY_S };
    const v = evaluateSecurityTlsRules(
      [
        tlsFacts(expiring, { pageId: "a" }),
        tlsFacts(expiring, {
          pageId: "b",
          finalUrl: "https://shop.example.test/pricing",
        }),
        tlsFacts(expiring, {
          pageId: "c",
          finalUrl: "https://www.example.test/",
        }),
      ],
      NOW,
    );
    expect(v.map((x) => x.pageId)).toEqual(["a", "c"]);
    expect(
      evaluateSecurityTlsRules(
        [tlsFacts({ validTo: null, protocol: null })],
        NOW,
      ),
    ).toEqual([]);
    const noTls = facts();
    expect(
      evaluateSecurityTlsRules(
        [{ ...noTls, security: { ...noTls.security!, tls: null } }],
        NOW,
      ),
    ).toEqual([]);
  });
});

describe("security HTTPS redirect probe rules", () => {
  const probe = (p: Partial<HttpsRedirectProbe>): HttpsRedirectProbe => ({
    status: "redirects_to_https",
    probedUrl: "http://shop.example.test/",
    finalUrl: "https://shop.example.test/",
    hops: 1,
    reason: null,
    pageId: "page_1",
    pageUrl: "https://shop.example.test/",
    evidenceArtifactId: "ev_probe",
    ...p,
  });

  it("passes a short redirect, flags no redirect and long chains", () => {
    expect(evaluateHttpsRedirectProbe(probe({}))).toEqual([]);
    expect(evaluateHttpsRedirectProbe(probe({ hops: 2 }))).toEqual([]);
    expect(evaluateHttpsRedirectProbe(probe({ hops: 3 }))[0]).toMatchObject({
      ruleId: "sec.https.redirect-chain",
      evidenceArtifactId: "ev_probe",
    });
    expect(
      evaluateHttpsRedirectProbe(
        probe({
          status: "serves_http",
          finalUrl: "http://shop.example.test/",
          hops: 0,
        }),
      )[0],
    ).toMatchObject({ ruleId: "sec.https.no-redirect", severity: "high" });
  });

  it("reports nothing when the probe was unavailable or not stored", () => {
    expect(
      evaluateHttpsRedirectProbe(
        probe({ status: "unavailable", reason: "connection refused" }),
      ),
    ).toEqual([]);
    expect(
      evaluateHttpsRedirectProbe(
        probe({ status: "serves_http", evidenceArtifactId: null }),
      ),
    ).toEqual([]);
    expect(evaluateHttpsRedirectProbe(null)).toEqual([]);
  });
});

describe("security findings", () => {
  it("groups violations into one finding per rule with the worst severity", () => {
    // A different host: TLS is checked once per host.
    const expiring = facts({
      pageId: "page_3",
      pageUrl: "https://www.example.test/",
      finalUrl: "https://www.example.test/",
    });
    const candidates = evaluateSecurityRules({
      pages: [
        withHeaders({ "x-content-type-options": undefined }),
        {
          ...withHeaders({ "x-content-type-options": undefined }),
          pageId: "page_2",
          pageUrl: "https://shop.example.test/a",
        },
        {
          ...expiring,
          security: {
            ...expiring.security!,
            tls: {
              ...expiring.security!.tls!,
              validTo: NOW / 1000 + 2 * DAY_S,
            },
          },
        },
      ],
      probe: null,
      nowMs: NOW,
    });
    expect(
      candidates.map((c) => [c.ruleId, c.severity, c.measured.value]),
    ).toEqual([
      ["sec.tls.cert-expiring", "high", 1],
      ["sec.header.nosniff.missing", "low", 2],
    ]);
    expect(candidates[1]!.category).toBe("security");
    expect(candidates[1]!.threshold).toEqual({
      operator: "eq",
      target: "nosniff",
    });
  });
});

describe("security rule catalog documentation stays in sync with the code", () => {
  it("documents every rule id", () => {
    const doc = readFileSync(
      resolve(__dirname, "../../../docs/rule-catalog/security.md"),
      "utf8",
    );
    for (const rule of SECURITY_RULES) {
      expect(
        doc,
        `${rule.ruleId} missing from docs/rule-catalog/security.md`,
      ).toContain(`\`${rule.ruleId}\``);
    }
  });
});
