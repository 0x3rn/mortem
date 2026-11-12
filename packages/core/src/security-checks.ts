/**
 * Passive security checks (THE-183).
 *
 * Every rule reads evidence Mortem already stored while loading the page like a
 * normal visitor (document response headers, TLS details, Set-Cookie headers,
 * browser console and network log) plus one plain GET/HEAD of the site's
 * `http://` address. Nothing here probes for vulnerabilities, scans ports or
 * sends anything a normal browser would not.
 */

export const SECURITY_RULE_VERSION = "1.0.0";

export type SecuritySeverity = "high" | "medium" | "low";

export interface SecurityRule {
  ruleId: string;
  scope: "page" | "site";
  title: string;
  severity: SecuritySeverity;
  effort: "low" | "medium" | "high";
  impact: "low" | "medium" | "high" | "critical";
  fixRole: "developer";
  /** What a passing page looks like, stored as the finding threshold. */
  expectation: {
    operator: "lt" | "lte" | "gt" | "gte" | "eq" | "neq" | "exists";
    target: number | string | boolean;
    unit?: string;
  };
}

/** HSTS `max-age` below this (180 days) is reported as weak. */
export const SECURITY_HSTS_MIN_MAX_AGE_SECONDS = 15_552_000;
/** Certificates expiring within this many days are reported. */
export const SECURITY_CERT_EXPIRY_WARNING_DAYS = 30;
/** …and as high severity within this many days. */
export const SECURITY_CERT_EXPIRY_URGENT_DAYS = 7;
/** More redirects than this between `http://` and `https://` are reported. */
export const SECURITY_MAX_HTTPS_REDIRECT_HOPS = 2;

export const SECURITY_RULES: readonly SecurityRule[] = [
  {
    ruleId: "sec.https.not-used",
    scope: "page",
    title: "Page is served over plain HTTP",
    severity: "high",
    effort: "medium",
    impact: "critical",
    fixRole: "developer",
    expectation: { operator: "eq", target: "https" },
  },
  {
    ruleId: "sec.https.no-redirect",
    scope: "site",
    title: "The http:// address does not redirect to https://",
    severity: "high",
    effort: "low",
    impact: "high",
    fixRole: "developer",
    expectation: { operator: "eq", target: "redirects_to_https" },
  },
  {
    ruleId: "sec.https.redirect-chain",
    scope: "site",
    title: "Too many redirects from http:// to https://",
    severity: "low",
    effort: "low",
    impact: "low",
    fixRole: "developer",
    expectation: {
      operator: "lte",
      target: SECURITY_MAX_HTTPS_REDIRECT_HOPS,
      unit: "redirects",
    },
  },
  {
    ruleId: "sec.hsts.missing",
    scope: "page",
    title: "Strict-Transport-Security header is missing",
    severity: "medium",
    effort: "low",
    impact: "medium",
    fixRole: "developer",
    expectation: { operator: "exists", target: true },
  },
  {
    ruleId: "sec.hsts.weak",
    scope: "page",
    title: "Strict-Transport-Security max-age is too short",
    severity: "low",
    effort: "low",
    impact: "low",
    fixRole: "developer",
    expectation: {
      operator: "gte",
      target: SECURITY_HSTS_MIN_MAX_AGE_SECONDS,
      unit: "seconds",
    },
  },
  {
    ruleId: "sec.tls.old-protocol",
    scope: "site",
    title: "Site uses an outdated TLS version",
    severity: "high",
    effort: "medium",
    impact: "high",
    fixRole: "developer",
    expectation: { operator: "gte", target: "TLS 1.2" },
  },
  {
    ruleId: "sec.tls.cert-expiring",
    scope: "site",
    title: "TLS certificate expires soon",
    severity: "medium",
    effort: "low",
    impact: "critical",
    fixRole: "developer",
    expectation: {
      operator: "gt",
      target: SECURITY_CERT_EXPIRY_WARNING_DAYS,
      unit: "days",
    },
  },
  {
    ruleId: "sec.header.csp.missing",
    scope: "page",
    title: "Content-Security-Policy header is missing",
    severity: "medium",
    effort: "high",
    impact: "medium",
    fixRole: "developer",
    expectation: { operator: "exists", target: true },
  },
  {
    ruleId: "sec.header.clickjacking.missing",
    scope: "page",
    title:
      "Page can be framed by other sites (no X-Frame-Options or frame-ancestors)",
    severity: "medium",
    effort: "low",
    impact: "medium",
    fixRole: "developer",
    expectation: { operator: "exists", target: true },
  },
  {
    ruleId: "sec.header.nosniff.missing",
    scope: "page",
    title: "X-Content-Type-Options: nosniff is missing",
    severity: "low",
    effort: "low",
    impact: "low",
    fixRole: "developer",
    expectation: { operator: "eq", target: "nosniff" },
  },
  {
    ruleId: "sec.header.referrer-policy.missing",
    scope: "page",
    title: "Referrer-Policy is missing or leaks full URLs",
    severity: "low",
    effort: "low",
    impact: "low",
    fixRole: "developer",
    expectation: { operator: "exists", target: true },
  },
  {
    ruleId: "sec.header.permissions-policy.missing",
    scope: "page",
    title: "Permissions-Policy header is missing",
    severity: "low",
    effort: "low",
    impact: "low",
    fixRole: "developer",
    expectation: { operator: "exists", target: true },
  },
  {
    ruleId: "sec.header.version-disclosure",
    scope: "page",
    title: "Response headers reveal exact software versions",
    severity: "low",
    effort: "low",
    impact: "low",
    fixRole: "developer",
    expectation: { operator: "exists", target: false },
  },
  {
    ruleId: "sec.mixed-content.active",
    scope: "page",
    title: "Secure page loads scripts, styles or frames over HTTP",
    severity: "high",
    effort: "medium",
    impact: "high",
    fixRole: "developer",
    expectation: { operator: "eq", target: 0, unit: "requests" },
  },
  {
    ruleId: "sec.mixed-content.passive",
    scope: "page",
    title: "Secure page loads images or media over HTTP",
    severity: "medium",
    effort: "low",
    impact: "medium",
    fixRole: "developer",
    expectation: { operator: "eq", target: 0, unit: "requests" },
  },
  {
    ruleId: "sec.cookie.secure-missing",
    scope: "page",
    title: "Cookie set without the Secure flag",
    severity: "medium",
    effort: "low",
    impact: "medium",
    fixRole: "developer",
    expectation: { operator: "eq", target: 0, unit: "cookies" },
  },
  {
    ruleId: "sec.cookie.httponly-missing",
    scope: "page",
    title: "Session-like cookie readable by JavaScript (no HttpOnly)",
    severity: "medium",
    effort: "low",
    impact: "medium",
    fixRole: "developer",
    expectation: { operator: "eq", target: 0, unit: "cookies" },
  },
  {
    ruleId: "sec.cookie.samesite-missing",
    scope: "page",
    title: "Cookie set without a SameSite attribute",
    severity: "low",
    effort: "low",
    impact: "low",
    fixRole: "developer",
    expectation: { operator: "eq", target: 0, unit: "cookies" },
  },
];

// ---------------------------------------------------------------------------
// Evidence shapes
// ---------------------------------------------------------------------------

/** From Playwright `response.securityDetails()` (validFrom/validTo in Unix seconds). */
export interface CapturedTlsDetails {
  protocol: string | null;
  issuer: string | null;
  subjectName: string | null;
  validFrom: number | null;
  validTo: number | null;
}

/** A Set-Cookie header with its value removed: Mortem never stores cookie values. */
export interface ParsedSetCookie {
  name: string;
  secure: boolean;
  httpOnly: boolean;
  /** `null` when the attribute is absent. */
  sameSite: string | null;
  domain: string | null;
  path: string | null;
}

export interface CapturedInsecureRequest {
  url: string;
  resourceType: string;
}

/** Security evidence captured with the document (stored in the headers artifact). */
export interface DocumentSecurityEvidence {
  tls: CapturedTlsDetails | null;
  tlsUnavailableReason: string | null;
  setCookies: ParsedSetCookie[];
  cookiesUnavailableReason: string | null;
  insecureRequests: CapturedInsecureRequest[];
}

export interface MixedContentItem {
  url: string;
  /** What the browser called it (`script`, `stylesheet`, `element`, …) or the resource type. */
  type: string;
  active: boolean;
  source: "console" | "network";
}

export interface SecurityPageFacts {
  pageId: string;
  pageUrl: string;
  finalUrl: string;
  /** Document response headers, lower-cased names. `null` when none were stored. */
  headers: Record<string, string> | null;
  /** `undefined` when the page was captured before security evidence existed. */
  security?: DocumentSecurityEvidence;
  mixedContent: MixedContentItem[];
  evidence: {
    headers: string | null;
    consoleLog: string | null;
  };
}

export type HttpsRedirectProbeStatus =
  "redirects_to_https" | "serves_http" | "unavailable";

export interface HttpsRedirectProbe {
  status: HttpsRedirectProbeStatus;
  probedUrl: string;
  finalUrl: string | null;
  hops: number;
  reason: string | null;
  /** Page the probe is reported against (the homepage) and its stored evidence. */
  pageId: string;
  pageUrl: string;
  evidenceArtifactId: string | null;
}

export interface SecurityViolation {
  ruleId: string;
  pageId: string;
  pageUrl: string;
  severity: SecuritySeverity;
  evidenceArtifactId: string;
  excerpt: string;
  occurrenceKey?: string;
  context?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Parsers (exported for tests)
// ---------------------------------------------------------------------------

/** Parses one Set-Cookie header, dropping its value. Returns null when unnamed. */
export function parseSetCookieHeader(header: string): ParsedSetCookie | null {
  const parts = header.split(";");
  const first = parts.shift() ?? "";
  const eq = first.indexOf("=");
  const name = (eq === -1 ? "" : first.slice(0, eq)).trim();
  if (!name) return null;
  const cookie: ParsedSetCookie = {
    name,
    secure: false,
    httpOnly: false,
    sameSite: null,
    domain: null,
    path: null,
  };
  for (const part of parts) {
    const [rawKey, ...rest] = part.split("=");
    const key = (rawKey ?? "").trim().toLowerCase();
    const value = rest.join("=").trim();
    if (key === "secure") cookie.secure = true;
    else if (key === "httponly") cookie.httpOnly = true;
    else if (key === "samesite") cookie.sameSite = value || null;
    else if (key === "domain") cookie.domain = value || null;
    else if (key === "path") cookie.path = value || null;
  }
  return cookie;
}

/**
 * Playwright's `allHeaders()` joins repeated `set-cookie` headers with "\n".
 * Splits them and parses each, never keeping a value.
 */
export function parseSetCookieHeaders(
  joined: string | undefined | null,
): ParsedSetCookie[] {
  if (!joined) return [];
  return joined
    .split("\n")
    .map((line) => parseSetCookieHeader(line))
    .filter((c): c is ParsedSetCookie => c !== null);
}

export interface ParsedHsts {
  maxAge: number | null;
  includeSubDomains: boolean;
  preload: boolean;
}

export function parseHstsHeader(value: string): ParsedHsts {
  const result: ParsedHsts = {
    maxAge: null,
    includeSubDomains: false,
    preload: false,
  };
  for (const directive of value.split(";")) {
    const [rawKey, rawVal] = directive.split("=");
    const key = (rawKey ?? "").trim().toLowerCase();
    if (key === "max-age") {
      const n = Number((rawVal ?? "").trim().replace(/^"|"$/g, ""));
      result.maxAge = Number.isFinite(n) ? n : null;
    } else if (key === "includesubdomains") result.includeSubDomains = true;
    else if (key === "preload") result.preload = true;
  }
  return result;
}

/** True when a CSP sets `frame-ancestors`, which also protects against clickjacking. */
export function cspHasFrameAncestors(csp: string | undefined): boolean {
  return Boolean(
    csp &&
    csp
      .split(";")
      .some((d) => d.trim().toLowerCase().startsWith("frame-ancestors")),
  );
}

/** Headers that commonly name the server software. */
export const VERSION_DISCLOSURE_HEADERS = [
  "server",
  "x-powered-by",
  "x-aspnet-version",
  "x-aspnetmvc-version",
] as const;

/** True when a header value names an exact version such as `nginx/1.18.0` or `PHP/8.1`. */
export function disclosesVersion(value: string): boolean {
  return /\d+\.\d+/.test(value);
}

const MIXED_CONTENT_PATTERN =
  /Mixed Content: The page at '([^']*)' was loaded over HTTPS, but requested an insecure ([A-Za-z][A-Za-z ]*?) '([^']+)'/;

/** Types Chrome loads (or upgrades) instead of blocking: images, audio and video. */
const PASSIVE_MIXED_TYPES = new Set([
  "element",
  "image",
  "img",
  "video",
  "audio",
  "media",
  "favicon",
]);

/** Parses Chrome's "Mixed Content: …" console message. */
export function parseMixedContentConsoleMessage(
  text: string,
): MixedContentItem | null {
  const match = MIXED_CONTENT_PATTERN.exec(text);
  if (!match) return null;
  const type = match[2]!.trim().toLowerCase();
  return {
    url: match[3]!,
    type,
    active: !PASSIVE_MIXED_TYPES.has(type),
    source: "console",
  };
}

export function mixedContentFromInsecureRequest(
  request: CapturedInsecureRequest,
): MixedContentItem {
  const type = request.resourceType.toLowerCase();
  return {
    url: request.url,
    type,
    active: !PASSIVE_MIXED_TYPES.has(type),
    source: "network",
  };
}

/** Cookie names that usually carry a login or session (CSRF tokens excluded on purpose). */
const SESSION_COOKIE_PATTERN = /(sess|sid|auth|token|jwt|login|remember)/i;

export function looksLikeSessionCookie(name: string): boolean {
  return SESSION_COOKIE_PATTERN.test(name) && !/(csrf|xsrf)/i.test(name);
}

function isHttpsUrl(url: string): boolean {
  return url.toLowerCase().startsWith("https://");
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/** Rules for one page. Pages without a headers artifact are skipped by the runner. */
export function evaluateSecurityPageRules(
  facts: SecurityPageFacts,
): SecurityViolation[] {
  const out: SecurityViolation[] = [];
  const headersEvidence = facts.evidence.headers;
  if (!headersEvidence) return out;

  const base = {
    pageId: facts.pageId,
    pageUrl: facts.pageUrl,
    evidenceArtifactId: headersEvidence,
  };

  if (!isHttpsUrl(facts.finalUrl)) {
    // Header rules for HTTPS do not apply to a plain-HTTP page.
    out.push({
      ...base,
      ruleId: "sec.https.not-used",
      severity: "high",
      excerpt: `Final URL: ${facts.finalUrl}`,
      context: { finalUrl: facts.finalUrl },
    });
    return out;
  }

  const headers = facts.headers ?? {};
  const header = (name: string) => headers[name]?.trim();

  const hsts = header("strict-transport-security");
  if (!hsts) {
    out.push({
      ...base,
      ruleId: "sec.hsts.missing",
      severity: "medium",
      excerpt: "No Strict-Transport-Security header on the HTTPS response.",
    });
  } else {
    const parsed = parseHstsHeader(hsts);
    if (
      parsed.maxAge === null ||
      parsed.maxAge < SECURITY_HSTS_MIN_MAX_AGE_SECONDS
    ) {
      out.push({
        ...base,
        ruleId: "sec.hsts.weak",
        severity: "low",
        excerpt: `Strict-Transport-Security: ${hsts}`,
        context: { maxAge: parsed.maxAge },
      });
    }
  }

  const csp = header("content-security-policy");
  if (!csp) {
    out.push({
      ...base,
      ruleId: "sec.header.csp.missing",
      severity: "medium",
      excerpt: header("content-security-policy-report-only")
        ? "Only Content-Security-Policy-Report-Only is set; it does not block anything."
        : "No Content-Security-Policy header.",
    });
  }

  const xfo = header("x-frame-options")?.toUpperCase();
  const xfoProtects =
    xfo === "DENY" ||
    xfo === "SAMEORIGIN" ||
    Boolean(xfo?.startsWith("ALLOW-FROM"));
  if (!xfoProtects && !cspHasFrameAncestors(csp)) {
    out.push({
      ...base,
      ruleId: "sec.header.clickjacking.missing",
      severity: "medium",
      excerpt: xfo
        ? `X-Frame-Options: ${header("x-frame-options")} (not a valid value) and no CSP frame-ancestors.`
        : "No X-Frame-Options header and no CSP frame-ancestors directive.",
    });
  }

  if (header("x-content-type-options")?.toLowerCase() !== "nosniff") {
    out.push({
      ...base,
      ruleId: "sec.header.nosniff.missing",
      severity: "low",
      excerpt: header("x-content-type-options")
        ? `X-Content-Type-Options: ${header("x-content-type-options")}`
        : "No X-Content-Type-Options header.",
    });
  }

  const referrer = header("referrer-policy");
  const referrerLeaks = Boolean(
    referrer &&
    referrer
      .toLowerCase()
      .split(",")
      .map((p) => p.trim())
      .pop() === "unsafe-url",
  );
  if (!referrer || referrerLeaks) {
    out.push({
      ...base,
      ruleId: "sec.header.referrer-policy.missing",
      severity: "low",
      excerpt: referrer
        ? `Referrer-Policy: ${referrer} sends the full URL to every site.`
        : "No Referrer-Policy header.",
    });
  }

  if (!header("permissions-policy")) {
    out.push({
      ...base,
      ruleId: "sec.header.permissions-policy.missing",
      severity: "low",
      excerpt: "No Permissions-Policy header.",
    });
  }

  const disclosed = VERSION_DISCLOSURE_HEADERS.filter((name) => {
    const v = header(name);
    return Boolean(v && disclosesVersion(v));
  });
  if (disclosed.length > 0) {
    out.push({
      ...base,
      ruleId: "sec.header.version-disclosure",
      severity: "low",
      excerpt: disclosed.map((n) => `${n}: ${header(n)}`).join("; "),
      context: Object.fromEntries(disclosed.map((n) => [n, header(n)])),
    });
  }

  const active = facts.mixedContent.filter((m) => m.active);
  const passive = facts.mixedContent.filter((m) => !m.active);
  for (const [ruleId, items, severity] of [
    ["sec.mixed-content.active", active, "high"],
    ["sec.mixed-content.passive", passive, "medium"],
  ] as const) {
    if (items.length === 0) continue;
    const fromConsole = items.some((m) => m.source === "console");
    const evidenceArtifactId =
      fromConsole && facts.evidence.consoleLog
        ? facts.evidence.consoleLog
        : headersEvidence;
    const urls = [...new Set(items.map((m) => m.url))];
    out.push({
      ...base,
      evidenceArtifactId,
      ruleId,
      severity,
      excerpt: urls
        .slice(0, 5)
        .map((u) => `${items.find((m) => m.url === u)!.type}: ${u}`)
        .join("\n"),
      context: { count: urls.length, urls: urls.slice(0, 20) },
    });
  }

  const cookies = facts.security?.setCookies ?? [];
  const insecure = cookies.filter((c) => !c.secure);
  if (insecure.length > 0) {
    out.push({
      ...base,
      ruleId: "sec.cookie.secure-missing",
      severity: "medium",
      excerpt: `Set-Cookie without Secure: ${insecure.map((c) => c.name).join(", ")}`,
      context: { cookies: insecure.map((c) => c.name) },
    });
  }
  const readable = cookies.filter(
    (c) => !c.httpOnly && looksLikeSessionCookie(c.name),
  );
  if (readable.length > 0) {
    out.push({
      ...base,
      ruleId: "sec.cookie.httponly-missing",
      severity: "medium",
      excerpt: `Session-like cookie without HttpOnly: ${readable.map((c) => c.name).join(", ")}`,
      context: { cookies: readable.map((c) => c.name) },
    });
  }
  const noSameSite = cookies.filter((c) => !c.sameSite);
  if (noSameSite.length > 0) {
    out.push({
      ...base,
      ruleId: "sec.cookie.samesite-missing",
      severity: "low",
      excerpt: `Set-Cookie without SameSite: ${noSameSite.map((c) => c.name).join(", ")}`,
      context: { cookies: noSameSite.map((c) => c.name) },
    });
  }

  return out;
}

/** TLS rules, once per host (the first captured HTTPS page of each host). */
export function evaluateSecurityTlsRules(
  pages: readonly SecurityPageFacts[],
  nowMs: number,
): SecurityViolation[] {
  const out: SecurityViolation[] = [];
  const seenHosts = new Set<string>();
  for (const facts of pages) {
    const tls = facts.security?.tls;
    const host = hostOf(facts.finalUrl);
    if (!tls || !host || !isHttpsUrl(facts.finalUrl) || !facts.evidence.headers)
      continue;
    if (seenHosts.has(host)) continue;
    seenHosts.add(host);
    const base = {
      pageId: facts.pageId,
      pageUrl: facts.pageUrl,
      evidenceArtifactId: facts.evidence.headers,
      occurrenceKey: host,
    };

    const protocol = tls.protocol ?? "";
    if (/^(SSL|TLS 1\.0|TLS 1\.1)\b/i.test(protocol.trim())) {
      out.push({
        ...base,
        ruleId: "sec.tls.old-protocol",
        severity: "high",
        excerpt: `${host} negotiated ${protocol}.`,
        context: { host, protocol },
      });
    }

    if (typeof tls.validTo === "number" && Number.isFinite(tls.validTo)) {
      const daysRemaining = Math.floor(
        (tls.validTo * 1000 - nowMs) / 86_400_000,
      );
      if (daysRemaining <= SECURITY_CERT_EXPIRY_WARNING_DAYS) {
        out.push({
          ...base,
          ruleId: "sec.tls.cert-expiring",
          severity:
            daysRemaining <= SECURITY_CERT_EXPIRY_URGENT_DAYS
              ? "high"
              : "medium",
          excerpt: `Certificate for ${host} (issuer: ${tls.issuer ?? "unknown"}) expires ${new Date(tls.validTo * 1000).toISOString().slice(0, 10)}, in ${daysRemaining} day(s).`,
          context: {
            host,
            issuer: tls.issuer,
            validTo: new Date(tls.validTo * 1000).toISOString(),
            daysRemaining,
          },
        });
      }
    }
  }
  return out;
}

/** HTTP → HTTPS redirect rules from the probe. An unavailable probe reports nothing. */
export function evaluateHttpsRedirectProbe(
  probe: HttpsRedirectProbe | null,
): SecurityViolation[] {
  if (!probe || !probe.evidenceArtifactId) return [];
  const base = {
    pageId: probe.pageId,
    pageUrl: probe.pageUrl,
    evidenceArtifactId: probe.evidenceArtifactId,
  };
  if (probe.status === "serves_http") {
    return [
      {
        ...base,
        ruleId: "sec.https.no-redirect",
        severity: "high",
        excerpt: `${probe.probedUrl} answered without redirecting to HTTPS (final URL ${probe.finalUrl}).`,
        context: { probedUrl: probe.probedUrl, finalUrl: probe.finalUrl },
      },
    ];
  }
  if (
    probe.status === "redirects_to_https" &&
    probe.hops > SECURITY_MAX_HTTPS_REDIRECT_HOPS
  ) {
    return [
      {
        ...base,
        ruleId: "sec.https.redirect-chain",
        severity: "low",
        excerpt: `${probe.probedUrl} took ${probe.hops} redirects to reach ${probe.finalUrl}.`,
        context: { hops: probe.hops, finalUrl: probe.finalUrl },
      },
    ];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

export const SECURITY_PROVISIONAL_PRIORITY: Readonly<
  Record<SecuritySeverity, number>
> = {
  high: 75,
  medium: 45,
  low: 20,
};

const SEVERITY_RANK: Readonly<Record<SecuritySeverity, number>> = {
  low: 0,
  medium: 1,
  high: 2,
};

export interface SecurityFindingCandidate {
  ruleId: string;
  ruleVersion: string;
  category: "security";
  severity: SecuritySeverity;
  effort: SecurityRule["effort"];
  impact: SecurityRule["impact"];
  priorityScore: number;
  title: string;
  measured: {
    metric: string;
    value: number;
    unit: string;
    rawContext: Record<string, unknown>;
  };
  threshold: SecurityRule["expectation"];
  fixRole: SecurityRule["fixRole"];
  occurrences: SecurityViolation[];
}

/** One finding per fired rule, in catalog order. */
export function buildSecurityFindingCandidates(
  violations: readonly SecurityViolation[],
): SecurityFindingCandidate[] {
  const candidates: SecurityFindingCandidate[] = [];
  for (const rule of SECURITY_RULES) {
    const occurrences = violations.filter((v) => v.ruleId === rule.ruleId);
    if (occurrences.length === 0) continue;
    const severity = occurrences.reduce<SecuritySeverity>(
      (worst, v) =>
        SEVERITY_RANK[v.severity] > SEVERITY_RANK[worst] ? v.severity : worst,
      "low",
    );
    candidates.push({
      ruleId: rule.ruleId,
      ruleVersion: SECURITY_RULE_VERSION,
      category: "security",
      severity,
      effort: rule.effort,
      impact: rule.impact,
      priorityScore: SECURITY_PROVISIONAL_PRIORITY[severity],
      title: rule.title,
      measured: {
        metric: rule.ruleId,
        value: new Set(occurrences.map((v) => v.pageId)).size,
        unit: "pages",
        rawContext: {
          affectedUrls: [...new Set(occurrences.map((v) => v.pageUrl))],
          details: occurrences
            .map((v) => v.context)
            .filter((c): c is Record<string, unknown> => c !== undefined),
        },
      },
      threshold: rule.expectation,
      fixRole: rule.fixRole,
      occurrences,
    });
  }
  return candidates;
}

export function evaluateSecurityRules(params: {
  pages: readonly SecurityPageFacts[];
  probe: HttpsRedirectProbe | null;
  nowMs: number;
}): SecurityFindingCandidate[] {
  return buildSecurityFindingCandidates([
    ...params.pages.flatMap((p) => evaluateSecurityPageRules(p)),
    ...evaluateSecurityTlsRules(params.pages, params.nowMs),
    ...evaluateHttpsRedirectProbe(params.probe),
  ]);
}
