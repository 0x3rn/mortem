import type { D1DatabaseLike, QueueLike } from "./cloudflare";
import { READ_ONLY_SCAN_POLICY } from "./index";
import type { RedirectHop, ScanOptionsJson } from "./schema/scans";

export const SCAN_INTAKE_ERROR_CODES = [
  "invalid_url",
  "ssrf_blocked",
  "dns_failed",
  "unreachable",
  "tls_error",
  "bot_blocked",
  "rate_limited",
  "duplicate_in_flight",
  "turnstile_failed",
] as const;

export type ScanIntakeErrorCode = (typeof SCAN_INTAKE_ERROR_CODES)[number];

export class ScanIntakeError extends Error {
  readonly code: ScanIntakeErrorCode;
  readonly status: 400 | 403 | 409 | 422 | 429 | 502;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ScanIntakeErrorCode,
    message: string,
    status: 400 | 403 | 409 | 422 | 429 | 502 = 400,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ScanIntakeError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const TRACKING_QUERY_PARAM_EXACT = new Set([
  "gclid",
  "fbclid",
  "msclkid",
  "twclid",
  "ttclid",
  "yclid",
  "mc_cid",
  "mc_eid",
  "_ga",
  "_gl",
  "ref_src",
]);

const BLOCKED_HOSTNAME_SUFFIXES = [
  ".local",
  ".internal",
  ".localhost",
  ".home.arpa",
  ".corp",
  ".lan",
] as const;

export function isTrackingQueryParam(paramName: string): boolean {
  const lower = paramName.trim().toLowerCase();
  return lower.startsWith("utm_") || TRACKING_QUERY_PARAM_EXACT.has(lower);
}

/**
 * Parses a standard dotted-quad IPv4 string into its 4 octets `[0..255]`, or returns `null`.
 */
export function parseIpv4Octets(
  ip: string,
): [number, number, number, number] | null {
  const trimmed = ip.trim();
  const parts = trimmed.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    if (part.length > 1 && part.startsWith("0")) return null;
    const num = Number(part);
    if (!Number.isInteger(num) || num < 0 || num > 255) return null;
    octets.push(num);
  }
  return octets as [number, number, number, number];
}

/**
 * Detects whether a hostname is an IPv4 or IPv6 literal (including bracketed IPv6,
 * dotted-quad IPv4, integer/hex/octal IPv4 encodings).
 */
export function isIpLiteralHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  if (!host) return false;
  if (host.startsWith("[") || host.includes(":")) {
    return true;
  }
  if (parseIpv4Octets(host) !== null) {
    return true;
  }
  // Numeric/hex/octal IPv4 literals (e.g., 2130706433, 0x7f000001, 0177.0.0.1)
  if (/^(0x[0-9a-f]+|\d+)(\.(0x[0-9a-f]+|\d+)){0,3}$/i.test(host)) {
    return true;
  }
  return false;
}

/**
 * Checks whether an IPv4 address falls inside any reserved, loopback, private (RFC1918),
 * link-local / cloud metadata (`169.254.0.0/16`), CGNAT (`100.64.0.0/10`), multicast,
 * documentation, or broadcast range.
 */
export function isBlockedIpv4(ip: string): boolean {
  const octets = parseIpv4Octets(ip);
  if (!octets) return true;
  const [a, b, c] = octets;

  // 0.0.0.0/8 ("this" network)
  if (a === 0) return true;
  // 10.0.0.0/8 (RFC1918)
  if (a === 10) return true;
  // 100.64.0.0/10 (RFC6598 CGNAT: 100.64.0.0 - 100.127.255.255)
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 127.0.0.0/8 (Loopback)
  if (a === 127) return true;
  // 169.254.0.0/16 (Link-local & cloud metadata 169.254.169.254)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12 (RFC1918: 172.16.0.0 - 172.31.255.255)
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.0.0.0/24 (IETF protocol assignments)
  if (a === 192 && b === 0 && c === 0) return true;
  // 192.0.2.0/24 (TEST-NET-1)
  if (a === 192 && b === 0 && c === 2) return true;
  // 192.88.99.0/24 (6to4 relay anycast)
  if (a === 192 && b === 88 && c === 99) return true;
  // 192.168.0.0/16 (RFC1918)
  if (a === 192 && b === 168) return true;
  // 198.18.0.0/15 (Benchmarking: 198.18.0.0 - 198.19.255.255)
  if (a === 198 && (b === 18 || b === 19)) return true;
  // 198.51.100.0/24 (TEST-NET-2)
  if (a === 198 && b === 51 && c === 100) return true;
  // 203.0.113.0/24 (TEST-NET-3)
  if (a === 203 && b === 0 && c === 113) return true;
  // 224.0.0.0/4 (Multicast) & 240.0.0.0/4 (Reserved / Broadcast)
  if (a >= 224) return true;

  return false;
}

/**
 * Expands an IPv6 address into 8 16-bit unsigned integer groups (`[0..0xffff]`), or returns `null`.
 */
export function expandIpv6Groups(rawIp: string): number[] | null {
  let ip = rawIp.trim().toLowerCase();
  if (ip.startsWith("[") && ip.endsWith("]")) {
    ip = ip.slice(1, -1);
  }
  const zoneIndex = ip.indexOf("%");
  if (zoneIndex !== -1) {
    ip = ip.slice(0, zoneIndex);
  }
  if (!ip || !ip.includes(":")) return null;

  // Handle embedded IPv4 tail (e.g. ::ffff:127.0.0.1)
  const lastColon = ip.lastIndexOf(":");
  const tail = ip.slice(lastColon + 1);
  if (tail.includes(".")) {
    const octets = parseIpv4Octets(tail);
    if (!octets) return null;
    const high = ((octets[0] << 8) | octets[1]).toString(16);
    const low = ((octets[2] << 8) | octets[3]).toString(16);
    ip = `${ip.slice(0, lastColon)}:${high}:${low}`;
  }

  const doubleColonParts = ip.split("::");
  if (doubleColonParts.length > 2) return null;

  const parseSegmentList = (segmentStr: string): number[] | null => {
    if (!segmentStr) return [];
    const parts = segmentStr.split(":");
    const nums: number[] = [];
    for (const part of parts) {
      if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
      nums.push(Number.parseInt(part, 16));
    }
    return nums;
  };

  if (doubleColonParts.length === 2) {
    const left = parseSegmentList(doubleColonParts[0] ?? "");
    const right = parseSegmentList(doubleColonParts[1] ?? "");
    if (!left || !right) return null;
    const missing = 8 - (left.length + right.length);
    if (missing < 1) return null;
    return [...left, ...new Array<number>(missing).fill(0), ...right];
  }

  const full = parseSegmentList(ip);
  if (!full || full.length !== 8) return null;
  return full;
}

/**
 * Checks whether an IPv6 address is loopback (`::1`), unspecified (`::`),
 * IPv4-mapped (`::ffff:0:0/96`), Unique Local (`fc00::/7`), Link-Local (`fe80::/10`),
 * Multicast (`ff00::/8`), Documentation (`2001:db8::/32`), or Discard-Only (`100::/64`).
 */
export function isBlockedIpv6(rawIp: string): boolean {
  const groups = expandIpv6Groups(rawIp);
  if (!groups || groups.length !== 8) return true;

  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] =
    groups;

  // ::/128 (Unspecified) and ::1/128 (Loopback)
  if (
    g0 === 0 &&
    g1 === 0 &&
    g2 === 0 &&
    g3 === 0 &&
    g4 === 0 &&
    g5 === 0 &&
    g6 === 0 &&
    (g7 === 0 || g7 === 1)
  ) {
    return true;
  }

  // ::ffff:0:0/96 (IPv4-mapped IPv6) or ::0:0/96 (IPv4-compatible)
  if (
    g0 === 0 &&
    g1 === 0 &&
    g2 === 0 &&
    g3 === 0 &&
    g4 === 0 &&
    (g5 === 0xffff || g5 === 0)
  ) {
    const ipv4 = `${(g6 >> 8) & 0xff}.${g6 & 0xff}.${(g7 >> 8) & 0xff}.${g7 & 0xff}`;
    return isBlockedIpv4(ipv4);
  }

  // 64:ff9b::/96 or 64:ff9b:1::/48 (NAT64 translation)
  if (g0 === 0x0064 && g1 === 0xff9b) {
    const ipv4 = `${(g6 >> 8) & 0xff}.${g6 & 0xff}.${(g7 >> 8) & 0xff}.${g7 & 0xff}`;
    return isBlockedIpv4(ipv4);
  }

  // 100::/64 (Discard-Only)
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) {
    return true;
  }

  // 2001:db8::/32 (Documentation)
  if (g0 === 0x2001 && g1 === 0x0db8) {
    return true;
  }

  // fc00::/7 (Unique Local Address: fc00:: - fdff::)
  if ((g0 & 0xfe00) === 0xfc00) {
    return true;
  }

  // fe80::/10 (Link-Local: fe80:: - febf::)
  if ((g0 & 0xffc0) === 0xfe80) {
    return true;
  }

  // ff00::/8 (Multicast)
  if ((g0 & 0xff00) === 0xff00) {
    return true;
  }

  return false;
}

export function isBlockedIpAddress(ip: string): boolean {
  const trimmed = ip.trim();
  if (!trimmed) return true;
  if (trimmed.includes(":") || trimmed.startsWith("[")) {
    return isBlockedIpv6(trimmed);
  }
  return isBlockedIpv4(trimmed);
}

export function isBlockedHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!host) return true;
  if (host === "localhost") return true;
  for (const suffix of BLOCKED_HOSTNAME_SUFFIXES) {
    if (host.endsWith(suffix)) return true;
  }
  if (isIpLiteralHostname(host)) {
    return true;
  }
  return false;
}

export interface ValidatedIntakeUrl {
  normalizedUrl: string;
  origin: string;
  hostname: string;
  protocol: "http:" | "https:";
}

/**
 * Validates and canonicalizes a user-supplied URL for Mortem scan intake:
 * - Defaults to `https://` when scheme is omitted
 * - Allows only `http:` and `https:` on ports 80 and 443
 * - Rejects credentials (`user:pass@host`)
 * - Rejects IP literals, `localhost`, `.local`, `.internal`, `.localhost` (`ssrf_blocked`)
 * - Lowercases and Punycode-normalizes hostnames
 * - Strips `#hash` fragments and tracking query params (`utm_*`, `gclid`, `fbclid`, etc.)
 * - Canonicalizes root slash (`https://example.com/`)
 */
export function validateAndNormalizeIntakeUrl(raw: string): ValidatedIntakeUrl {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new ScanIntakeError(
      "invalid_url",
      "Enter a website URL to examine.",
      400,
    );
  }

  const hasExplicitScheme = /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(trimmed);
  if (hasExplicitScheme && !/^https?:\/\//i.test(trimmed)) {
    throw new ScanIntakeError(
      "invalid_url",
      "Only HTTP and HTTPS website URLs are supported.",
      400,
    );
  }

  const candidate = hasExplicitScheme ? trimmed : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new ScanIntakeError(
      "invalid_url",
      "Enter a valid website domain or URL (for example, stripe.com).",
      400,
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ScanIntakeError(
      "invalid_url",
      "Only HTTP and HTTPS website URLs are supported.",
      400,
    );
  }

  if (parsed.username || parsed.password) {
    throw new ScanIntakeError(
      "invalid_url",
      "URLs containing embedded credentials are not permitted.",
      400,
    );
  }

  // Only allow default ports 80 and 443
  if (parsed.port && parsed.port !== "80" && parsed.port !== "443") {
    throw new ScanIntakeError(
      "ssrf_blocked",
      `Port ${parsed.port} is blocked. Mortem only scans standard HTTP (80) and HTTPS (443) ports.`,
      422,
    );
  }
  if (
    (parsed.protocol === "http:" && parsed.port === "80") ||
    (parsed.protocol === "https:" && parsed.port === "443")
  ) {
    parsed.port = "";
  }

  const host = parsed.hostname.toLowerCase();
  if (!host) {
    throw new ScanIntakeError(
      "invalid_url",
      "Enter a valid website domain or URL.",
      400,
    );
  }

  // Check SSRF hostname/IP literal blocklist BEFORE general TLD checks so `localhost` and `[::1]`
  // return `ssrf_blocked` with a clear explanation.
  if (isBlockedHostname(host)) {
    throw new ScanIntakeError(
      "ssrf_blocked",
      `Scanning private, loopback, internal, or IP-literal host '${host}' is blocked by SSRF policy.`,
      422,
      { hostname: host },
    );
  }

  if (!host.includes(".") || host.startsWith(".") || host.endsWith(".")) {
    throw new ScanIntakeError(
      "invalid_url",
      "Enter a valid public domain name (for example, acme-cloud.io).",
      400,
    );
  }

  const labels = host.split(".");
  if (labels.some((label) => !label)) {
    throw new ScanIntakeError(
      "invalid_url",
      "Domain name contains empty labels.",
      400,
    );
  }
  const tld = labels[labels.length - 1];
  if (!tld || tld.length < 2 || /^\d+$/.test(tld)) {
    throw new ScanIntakeError(
      "invalid_url",
      "Domain name must have a valid public top-level domain.",
      400,
    );
  }

  // Strip fragment and tracking query parameters
  parsed.hash = "";
  const keysToDelete: string[] = [];
  parsed.searchParams.forEach((_value, key) => {
    if (isTrackingQueryParam(key)) {
      keysToDelete.push(key);
    }
  });
  for (const key of keysToDelete) {
    parsed.searchParams.delete(key);
  }

  if (!parsed.pathname) {
    parsed.pathname = "/";
  }

  return {
    normalizedUrl: parsed.toString(),
    origin: parsed.origin,
    hostname: host,
    protocol: parsed.protocol,
  };
}

export interface DohDnsAnswer {
  name?: string;
  type: number;
  TTL?: number;
  data: string;
}

export interface DohDnsResponse {
  Status: number;
  Answer?: DohDnsAnswer[];
}

export type DohResolverFn = (
  hostname: string,
  recordType: "A" | "AAAA",
) => Promise<DohDnsResponse>;

const CLOUDFLARE_DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";

export const defaultCloudflareDohResolver: DohResolverFn = async (
  hostname,
  recordType,
) => {
  const url = `${CLOUDFLARE_DOH_ENDPOINT}?name=${encodeURIComponent(hostname)}&type=${recordType}`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      accept: "application/dns-json",
    },
  });
  if (!response.ok) {
    throw new ScanIntakeError(
      "dns_failed",
      `DNS resolution request failed for '${hostname}' (HTTP ${response.status}).`,
      422,
    );
  }
  return (await response.json()) as DohDnsResponse;
};

export interface ValidatedHostDnsResult {
  hostname: string;
  ips: string[];
  cnames: string[];
}

/**
 * Resolves `A` and `AAAA` records via DNS-over-HTTPS (`1.1.1.1`) and verifies that:
 * 1. At least one public IP address resolves (`dns_failed` otherwise)
 * 2. Every CNAME target and every resolved `A`/`AAAA` IP passes the SSRF blocklist (`ssrf_blocked` otherwise)
 */
export async function resolveAndValidateHostDns(
  hostname: string,
  dohResolver: DohResolverFn = defaultCloudflareDohResolver,
): Promise<ValidatedHostDnsResult> {
  if (isBlockedHostname(hostname)) {
    throw new ScanIntakeError(
      "ssrf_blocked",
      `Host '${hostname}' is blocked by SSRF policy.`,
      422,
      { hostname },
    );
  }

  let aResponse: DohDnsResponse;
  let aaaaResponse: DohDnsResponse;
  try {
    [aResponse, aaaaResponse] = await Promise.all([
      dohResolver(hostname, "A"),
      dohResolver(hostname, "AAAA"),
    ]);
  } catch (err) {
    if (err instanceof ScanIntakeError) {
      throw err;
    }
    throw new ScanIntakeError(
      "dns_failed",
      `Unable to resolve DNS records for '${hostname}'.`,
      422,
    );
  }

  const answers = [...(aResponse.Answer ?? []), ...(aaaaResponse.Answer ?? [])];
  const ips: string[] = [];
  const cnames: string[] = [];

  for (const ans of answers) {
    const data = ans.data.trim().replace(/\.$/, "");
    if (!data) continue;

    // Type 5 = CNAME
    if (ans.type === 5) {
      cnames.push(data.toLowerCase());
      if (isBlockedHostname(data)) {
        throw new ScanIntakeError(
          "ssrf_blocked",
          `Host '${hostname}' aliases via CNAME to blocked internal host '${data}'.`,
          422,
          { hostname, cname: data },
        );
      }
      continue;
    }

    // Type 1 = A, Type 28 = AAAA
    if (ans.type === 1 || ans.type === 28) {
      if (isBlockedIpAddress(data)) {
        throw new ScanIntakeError(
          "ssrf_blocked",
          `Host '${hostname}' resolves to blocked private or reserved IP address '${data}'.`,
          422,
          { hostname, ip: data },
        );
      }
      if (!ips.includes(data)) {
        ips.push(data);
      }
    }
  }

  if (ips.length === 0) {
    throw new ScanIntakeError(
      "dns_failed",
      `Domain '${hostname}' did not resolve to any valid A or AAAA records.`,
      422,
      { hostname },
    );
  }

  return { hostname, ips, cnames };
}

export interface PreflightScanTargetOptions {
  maxRedirects?: number;
  dohResolver?: DohResolverFn;
  fetchFn?: typeof fetch;
}

export interface PreflightScanTargetResult {
  initialUrl: string;
  finalUrl: string;
  origin: string;
  hostname: string;
  statusCode: number;
  redirectChain: RedirectHop[];
  resolvedIps: string[];
}

function classifyFetchError(error: unknown, hostname: string): ScanIntakeError {
  const message =
    error instanceof Error ? error.message : String(error ?? "Unknown error");
  const lower = message.toLowerCase();

  if (
    lower.includes("ssl") ||
    lower.includes("tls") ||
    lower.includes("cert") ||
    lower.includes("handshake") ||
    lower.includes("alpn")
  ) {
    return new ScanIntakeError(
      "tls_error",
      `TLS/SSL certificate validation failed when connecting to '${hostname}'.`,
      422,
      { hostname, reason: message },
    );
  }

  return new ScanIntakeError(
    "unreachable",
    `Could not reach '${hostname}'. Verify the site is online and publicly accessible.`,
    422,
    { hostname, reason: message },
  );
}

function isBotBlockedResponse(response: Response): boolean {
  const cfMitigated = response.headers.get("cf-mitigated")?.toLowerCase() ?? "";
  if (cfMitigated.includes("challenge") || cfMitigated.includes("block")) {
    return true;
  }
  const server = response.headers.get("server")?.toLowerCase() ?? "";
  if (
    (response.status === 403 ||
      response.status === 429 ||
      response.status === 503) &&
    (cfMitigated.length > 0 ||
      response.headers.has("x-datadome") ||
      response.headers.has("x-px-block") ||
      server.includes("cloudflare") ||
      server.includes("akamai") ||
      server.includes("cloudfront"))
  ) {
    return true;
  }
  return false;
}

/**
 * Validates the initial URL and follows up to `maxRedirects` (default `5`) hops
 * with `redirect: "manual"`, re-running URL normalization, port/host SSRF checks,
 * and DNS-over-HTTPS resolution on every hop before following.
 */
export async function preflightAndValidateTargetUrl(
  rawUrl: string,
  options: PreflightScanTargetOptions = {},
): Promise<PreflightScanTargetResult> {
  const maxRedirects = options.maxRedirects ?? 5;
  const dohResolver = options.dohResolver ?? defaultCloudflareDohResolver;
  const fetchFn = options.fetchFn ?? fetch;

  const initialValidated = validateAndNormalizeIntakeUrl(rawUrl);
  let current = initialValidated;
  const redirectChain: RedirectHop[] = [];
  let lastDns: ValidatedHostDnsResult | null = null;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    lastDns = await resolveAndValidateHostDns(current.hostname, dohResolver);

    const requestHeaders = {
      "user-agent": READ_ONLY_SCAN_POLICY.userAgent,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    };

    let response: Response;
    try {
      response = await fetchFn(current.normalizedUrl, {
        method: "HEAD",
        redirect: "manual",
        headers: requestHeaders,
      });

      if (response.status === 405 || response.status === 501) {
        response = await fetchFn(current.normalizedUrl, {
          method: "GET",
          redirect: "manual",
          headers: requestHeaders,
        });
      }
    } catch (err) {
      throw classifyFetchError(err, current.hostname);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location")?.trim();
      if (!location) {
        throw new ScanIntakeError(
          "unreachable",
          `Redirect response (${response.status}) from '${current.hostname}' did not include a Location header.`,
          422,
        );
      }

      if (hop === maxRedirects) {
        throw new ScanIntakeError(
          "unreachable",
          `Target URL exceeded maximum redirect depth (${maxRedirects} hops).`,
          422,
          { redirectChain },
        );
      }

      let resolvedNextUrl: string;
      try {
        resolvedNextUrl = new URL(location, current.normalizedUrl).toString();
      } catch {
        throw new ScanIntakeError(
          "invalid_url",
          `Redirect target '${location}' is not a valid URL.`,
          422,
        );
      }

      const nextValidated = validateAndNormalizeIntakeUrl(resolvedNextUrl);
      redirectChain.push({
        fromUrl: current.normalizedUrl,
        toUrl: nextValidated.normalizedUrl,
        statusCode: response.status,
      });
      current = nextValidated;
      continue;
    }

    if (isBotBlockedResponse(response)) {
      throw new ScanIntakeError(
        "bot_blocked",
        `Target website '${current.hostname}' blocked automated inspection (HTTP ${response.status}).`,
        422,
        { hostname: current.hostname, statusCode: response.status },
      );
    }

    if (response.status >= 500) {
      throw new ScanIntakeError(
        "unreachable",
        `Target website '${current.hostname}' returned server error HTTP ${response.status}.`,
        422,
        { hostname: current.hostname, statusCode: response.status },
      );
    }

    return {
      initialUrl: initialValidated.normalizedUrl,
      finalUrl: current.normalizedUrl,
      origin: current.origin,
      hostname: current.hostname,
      statusCode: response.status,
      redirectChain,
      resolvedIps: lastDns.ips,
    };
  }

  throw new ScanIntakeError(
    "unreachable",
    `Target URL exceeded maximum redirect depth (${maxRedirects} hops).`,
    422,
  );
}

export interface ScanIntakeRateLimitConfig {
  windowMs?: number;
  maxPerWorkspace?: number;
  maxPerIp?: number;
  maxPerTargetHost?: number;
}

const DEFAULT_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_MAX_PER_WORKSPACE = 10;
const DEFAULT_MAX_PER_IP = 15;
const DEFAULT_MAX_PER_TARGET_HOST = 5;

export async function hashClientIp(clientIp: string): Promise<string> {
  const normalized = (clientIp || "127.0.0.1").trim().toLowerCase();
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`mortem-ip:${normalized}`),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function findDuplicateInFlightScan(
  d1: D1DatabaseLike,
  workspaceId: string,
  normalizedUrl: string,
): Promise<{ id: string; status: string } | null> {
  return d1
    .prepare(
      `SELECT id, status
       FROM scans
       WHERE workspace_id = ?
         AND normalized_url = ?
         AND status IN ('queued', 'discovering', 'capturing', 'checking', 'scoring', 'generating_report')
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .bind(workspaceId, normalizedUrl)
    .first<{ id: string; status: string }>();
}

export async function enforceScanIntakeRateLimits(
  d1: D1DatabaseLike,
  params: {
    workspaceId: string;
    ipHash: string;
    targetHost: string;
    nowMs?: number;
    config?: ScanIntakeRateLimitConfig;
  },
): Promise<void> {
  const nowMs = params.nowMs ?? Date.now();
  const windowMs = params.config?.windowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS;
  const maxPerWorkspace =
    params.config?.maxPerWorkspace ?? DEFAULT_MAX_PER_WORKSPACE;
  const maxPerIp = params.config?.maxPerIp ?? DEFAULT_MAX_PER_IP;
  const maxPerTargetHost =
    params.config?.maxPerTargetHost ?? DEFAULT_MAX_PER_TARGET_HOST;
  const cutoffMs = nowMs - windowMs;

  const [wsRow, ipRow, hostRow] = await Promise.all([
    d1
      .prepare(
        `SELECT COUNT(*) AS count
         FROM scan_intake_events
         WHERE workspace_id = ? AND created_at >= ?`,
      )
      .bind(params.workspaceId, cutoffMs)
      .first<{ count: number }>(),
    d1
      .prepare(
        `SELECT COUNT(*) AS count
         FROM scan_intake_events
         WHERE ip_hash = ? AND created_at >= ?`,
      )
      .bind(params.ipHash, cutoffMs)
      .first<{ count: number }>(),
    d1
      .prepare(
        `SELECT COUNT(*) AS count
         FROM scan_intake_events
         WHERE target_host = ? AND created_at >= ?`,
      )
      .bind(params.targetHost, cutoffMs)
      .first<{ count: number }>(),
  ]);

  if (Number(wsRow?.count ?? 0) >= maxPerWorkspace) {
    throw new ScanIntakeError(
      "rate_limited",
      `Workspace scan limit reached (${maxPerWorkspace} scans per 10 minutes). Wait a moment before starting another scan.`,
      429,
      { scope: "workspace", limit: maxPerWorkspace },
    );
  }

  if (Number(ipRow?.count ?? 0) >= maxPerIp) {
    throw new ScanIntakeError(
      "rate_limited",
      `Too many scan requests from this IP address (${maxPerIp} per 10 minutes).`,
      429,
      { scope: "ip", limit: maxPerIp },
    );
  }

  if (Number(hostRow?.count ?? 0) >= maxPerTargetHost) {
    throw new ScanIntakeError(
      "rate_limited",
      `Target host '${params.targetHost}' was scanned too recently (${maxPerTargetHost} scans per 10 minutes).`,
      429,
      {
        scope: "target_host",
        limit: maxPerTargetHost,
        host: params.targetHost,
      },
    );
  }
}

export type TurnstileVerifierFn = (
  token: string,
  secretKey: string,
  remoteIp?: string,
) => Promise<boolean>;

export const defaultCloudflareTurnstileVerifier: TurnstileVerifierFn = async (
  token,
  secretKey,
  remoteIp,
) => {
  const form = new URLSearchParams();
  form.set("secret", secretKey);
  form.set("response", token);
  if (remoteIp) {
    form.set("remoteip", remoteIp);
  }
  const response = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    },
  );
  if (!response.ok) return false;
  const payload = (await response.json()) as { success?: boolean };
  return payload.success === true;
};

function generateIntakeId(prefix: string): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${prefix}_${hex}`;
}

export interface SubmitScanIntakeOptions {
  d1: D1DatabaseLike;
  scanQueue: QueueLike;
  workspaceId: string;
  rawUrl: string;
  clientIp?: string;
  options?: ScanOptionsJson;
  isAnonymousPreview?: boolean;
  turnstileToken?: string;
  turnstileSecretKey?: string;
  turnstileVerifier?: TurnstileVerifierFn;
  dohResolver?: DohResolverFn;
  fetchFn?: typeof fetch;
  rateLimitConfig?: ScanIntakeRateLimitConfig;
  nowMs?: number;
}

export interface SubmitScanIntakeResult {
  scanId: string;
  siteId: string;
  workspaceId: string;
  targetUrl: string;
  normalizedUrl: string;
  origin: string;
  hostname: string;
  status: "queued";
  redirectChain: RedirectHop[];
  resolvedIps: string[];
}

/**
 * Full URL intake pipeline (`THE-173`):
 * 1. Verifies Cloudflare Turnstile when required for anonymous preview scans
 * 2. Normalizes the URL, strips tracking params, and runs SSRF + DoH DNS + redirect preflight
 * 3. Rejects duplicate in-flight scans for the same `(workspaceId, normalizedUrl)`
 * 4. Enforces per-workspace, per-IP, and per-target-host rate limits
 * 5. Upserts `sites`, creates `queued` row in `scans` + `scan_events` + `scan_intake_events`,
 *    and publishes `{ scanId, workspaceId, siteId, targetUrl, stage: "queued" }` onto `SCAN_QUEUE`
 */
export async function submitScanIntake(
  params: SubmitScanIntakeOptions,
): Promise<SubmitScanIntakeResult> {
  const nowMs = params.nowMs ?? Date.now();

  if (params.isAnonymousPreview && params.turnstileSecretKey?.trim()) {
    const token = params.turnstileToken?.trim() ?? "";
    if (!token) {
      throw new ScanIntakeError(
        "turnstile_failed",
        "Complete the Cloudflare Turnstile verification challenge to start an anonymous preview scan.",
        403,
      );
    }
    const verifier =
      params.turnstileVerifier ?? defaultCloudflareTurnstileVerifier;
    const valid = await verifier(
      token,
      params.turnstileSecretKey.trim(),
      params.clientIp,
    );
    if (!valid) {
      throw new ScanIntakeError(
        "turnstile_failed",
        "Cloudflare Turnstile verification failed or expired. Please try again.",
        403,
      );
    }
  }

  // First normalize & run static SSRF check before hitting DB or network
  const initialValidated = validateAndNormalizeIntakeUrl(params.rawUrl);
  const ipHash = await hashClientIp(params.clientIp ?? "127.0.0.1");

  // Check rate limits before network preflight so abusive callers cannot use Mortem as a DoH/HTTP amplifier
  await enforceScanIntakeRateLimits(params.d1, {
    workspaceId: params.workspaceId,
    ipHash,
    targetHost: initialValidated.hostname,
    nowMs,
    config: params.rateLimitConfig,
  });

  // Check duplicate in-flight scan on initial normalized URL
  const existingInitial = await findDuplicateInFlightScan(
    params.d1,
    params.workspaceId,
    initialValidated.normalizedUrl,
  );
  if (existingInitial) {
    throw new ScanIntakeError(
      "duplicate_in_flight",
      `A scan for '${initialValidated.normalizedUrl}' is already in progress (${existingInitial.status}).`,
      409,
      { existingScanId: existingInitial.id, status: existingInitial.status },
    );
  }

  // Perform DoH DNS resolution + manual redirect hop preflight
  const preflight = await preflightAndValidateTargetUrl(params.rawUrl, {
    dohResolver: params.dohResolver,
    fetchFn: params.fetchFn,
  });

  // If redirects landed on a different canonical URL, check duplicate in-flight and target-host rate limit for final URL too
  if (preflight.finalUrl !== initialValidated.normalizedUrl) {
    if (preflight.hostname !== initialValidated.hostname) {
      await enforceScanIntakeRateLimits(params.d1, {
        workspaceId: params.workspaceId,
        ipHash,
        targetHost: preflight.hostname,
        nowMs,
        config: params.rateLimitConfig,
      });
    }
    const existingFinal = await findDuplicateInFlightScan(
      params.d1,
      params.workspaceId,
      preflight.finalUrl,
    );
    if (existingFinal) {
      throw new ScanIntakeError(
        "duplicate_in_flight",
        `A scan for '${preflight.finalUrl}' is already in progress (${existingFinal.status}).`,
        409,
        { existingScanId: existingFinal.id, status: existingFinal.status },
      );
    }
  }

  // Upsert site for (workspace_id, origin)
  const existingSite = await params.d1
    .prepare(
      `SELECT id FROM sites WHERE workspace_id = ? AND origin = ? LIMIT 1`,
    )
    .bind(params.workspaceId, preflight.origin)
    .first<{ id: string }>();

  const siteId = existingSite?.id ?? generateIntakeId("site");
  const scanId = generateIntakeId("scan");
  const eventId = generateIntakeId("evt");
  const intakeEventId = generateIntakeId("intake");

  const optionsJson = JSON.stringify(
    params.options ?? {
      maxPages: 5,
      viewports: ["desktop", "mobile"],
      includePageSpeed: true,
      includeConversionAnalysis: true,
    },
  );
  const budgetsJson = JSON.stringify({
    maxPages: 10,
    maxWallClockMs: 60_000,
    maxAiInputTokens: 12_000,
    maxAiOutputTokens: 3_000,
  });

  const statements = [
    existingSite
      ? params.d1
          .prepare(`UPDATE sites SET updated_at = ? WHERE id = ?`)
          .bind(nowMs, siteId)
      : params.d1
          .prepare(
            `INSERT INTO sites (
              id, workspace_id, origin, display_name, schedule_cron, schedule_enabled, last_scanned_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, NULL, 0, NULL, ?, ?)`,
          )
          .bind(
            siteId,
            params.workspaceId,
            preflight.origin,
            preflight.hostname,
            nowMs,
            nowMs,
          ),
    params.d1
      .prepare(
        `INSERT INTO scans (
          id, workspace_id, site_id, target_url, normalized_url, status,
          failure_class, failure_reason, options_json, scoring_version,
          budgets_json, usage_json, started_at, completed_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'queued', NULL, NULL, ?, 'v1.0.0', ?, '{}', NULL, NULL, ?, ?)`,
      )
      .bind(
        scanId,
        params.workspaceId,
        siteId,
        params.rawUrl.trim(),
        preflight.finalUrl,
        optionsJson,
        budgetsJson,
        nowMs,
        nowMs,
      ),
    params.d1
      .prepare(
        `INSERT INTO scan_events (
          id, scan_id, stage, message, pages_discovered, pages_captured, checks_completed, metadata_json, created_at
        ) VALUES (?, ?, 'queued', ?, 0, 0, 0, ?, ?)`,
      )
      .bind(
        eventId,
        scanId,
        `Scan queued for ${preflight.finalUrl}`,
        JSON.stringify({
          redirectChain: preflight.redirectChain,
          resolvedIps: preflight.resolvedIps,
          preflightStatusCode: preflight.statusCode,
        }),
        nowMs,
      ),
    params.d1
      .prepare(
        `INSERT INTO scan_intake_events (
          id, workspace_id, ip_hash, target_host, scan_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        intakeEventId,
        params.workspaceId,
        ipHash,
        preflight.hostname,
        scanId,
        nowMs,
      ),
  ];

  if (typeof params.d1.batch === "function") {
    await params.d1.batch(statements);
  } else {
    for (const stmt of statements) {
      await stmt.run();
    }
  }

  await params.scanQueue.send({
    kind: "website_scan",
    scanId,
    workspaceId: params.workspaceId,
    siteId,
    targetUrl: preflight.finalUrl,
    stage: "queued",
  });

  return {
    scanId,
    siteId,
    workspaceId: params.workspaceId,
    targetUrl: params.rawUrl.trim(),
    normalizedUrl: preflight.finalUrl,
    origin: preflight.origin,
    hostname: preflight.hostname,
    status: "queued",
    redirectChain: preflight.redirectChain,
    resolvedIps: preflight.resolvedIps,
  };
}
