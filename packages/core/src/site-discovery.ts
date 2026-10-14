import { load as loadCheerio } from "cheerio";
import type { D1DatabaseLike } from "./cloudflare";
import { READ_ONLY_SCAN_POLICY } from "./index";
import { validateAndNormalizeIntakeUrl, type DohResolverFn } from "./intake";
import type { PageTemplateType } from "./schema/scans";
import type { WorkspacePlan } from "./schema/auth";

export const DISCOVERY_TEMPLATE_CATEGORIES = [
  "home",
  "pricing",
  "contact",
  "product",
  "about",
  "auth",
  "blog",
  "docs",
  "legal",
  "other",
] as const;

export type DiscoveryTemplateCategory =
  (typeof DISCOVERY_TEMPLATE_CATEGORIES)[number];

export const PLAN_DEFAULT_PAGE_CAPS: Readonly<
  Record<WorkspacePlan | "preview", number>
> = {
  preview: 5,
  free: 5,
  single: 10,
  starter: 25,
  growth: 50,
  agency: 100,
};

export const MAX_ROBOTS_TXT_BYTES = 512 * 1024; // 512 KB
export const MAX_SITEMAP_BYTES = 2 * 1024 * 1024; // 2 MB
export const DEFAULT_MAX_INSPECTED_URLS = 500;
export const DEFAULT_MAX_CHILD_SITEMAPS = 5;
export const MAX_DISCOVERY_REDIRECT_HOPS = 5;

export interface RobotsTxtRule {
  type: "allow" | "disallow";
  pattern: string;
}

export interface ParsedRobotsTxt {
  matchedUserAgent: "mortembot" | "wildcard" | "none";
  rules: RobotsTxtRule[];
  sitemapUrls: string[];
}

export interface RobotsSkippedEntry {
  url: string;
  normalizedUrl: string;
  matchedRule: string;
  source: DiscoverySource;
}

export type DiscoverySource =
  "entry" | "sitemap" | "internal_link" | "canonical";

export interface ExtractedHtmlLink {
  href: string;
  anchorText: string;
  rel: "canonical" | "a";
}

export interface DiscoveredPageCandidate {
  url: string;
  normalizedUrl: string;
  pathname: string;
  category: DiscoveryTemplateCategory;
  templateType: PageTemplateType;
  priorityRank: number;
  sources: DiscoverySource[];
  anchorText?: string;
}

export interface SitemapFetchDiagnostic {
  sitemapUrl: string;
  status:
    | "ok"
    | "unreachable"
    | "malformed"
    | "redirect_loop"
    | "too_large"
    | "ssrf_blocked";
  urlsExtracted: number;
  error?: string;
}

export interface DiscoverSitePagesOptions {
  targetUrl: string;
  homepageHtml?: string;
  maxPages?: number;
  plan?: WorkspacePlan | "preview";
  maxInspectedUrls?: number;
  maxChildSitemaps?: number;
  fetchFn?: typeof fetch;
  dnsResolver?: DohResolverFn;
}

export interface SiteDiscoveryResult {
  origin: string;
  entryUrl: string;
  entryUrlDisallowed: boolean;
  maxPages: number;
  robots: {
    fetched: boolean;
    statusCode: number | null;
    matchedUserAgent: "mortembot" | "wildcard" | "none";
    sitemapDirectives: string[];
    rulesCount: number;
    error?: string;
  };
  sitemaps: SitemapFetchDiagnostic[];
  totalCandidatesInspected: number;
  selectedPages: DiscoveredPageCandidate[];
  skippedDisallowedUrls: RobotsSkippedEntry[];
  templateBreakdown: Partial<Record<DiscoveryTemplateCategory, number>>;
}

const TEMPLATE_PRIORITY_ORDER: Readonly<
  Record<DiscoveryTemplateCategory, number>
> = {
  home: 1,
  pricing: 2,
  contact: 3,
  product: 4,
  about: 5,
  auth: 6,
  blog: 7,
  docs: 8,
  legal: 9,
  other: 10,
};

const NON_PAGE_EXTENSION_REGEX =
  /\.(?:pdf|jpg|jpeg|png|gif|svg|webp|avif|ico|bmp|tiff|css|js|mjs|cjs|map|json|xml|rss|atom|zip|tar|gz|tgz|rar|7z|mp4|webm|mov|avi|mp3|wav|ogg|woff|woff2|ttf|eot|otf|dmg|exe|apk|csv)$/i;

/**
 * Resolves the effective page cap for a scan based on workspace plan and optional scan budget override.
 */
export function resolvePlanPageCap(
  plan: WorkspacePlan | "preview" = "single",
  requestedMaxPages?: number,
): number {
  const planCap = PLAN_DEFAULT_PAGE_CAPS[plan] ?? PLAN_DEFAULT_PAGE_CAPS.single;
  if (
    typeof requestedMaxPages === "number" &&
    Number.isFinite(requestedMaxPages) &&
    requestedMaxPages > 0
  ) {
    return Math.max(1, Math.min(100, Math.floor(requestedMaxPages)));
  }
  return planCap;
}

/**
 * Maps a rich discovery template category (`about`, `pricing`, etc.) to the D1 `pages.template_type` column enum.
 */
export function toDbPageTemplateType(
  category: DiscoveryTemplateCategory,
): PageTemplateType {
  if (category === "about") {
    return "other";
  }
  return category;
}

/**
 * Parses a `robots.txt` document, extracting `Sitemap:` directives and rules for `MortemBot` (preferred) or `*`.
 */
export function parseRobotsTxt(
  rawText: string,
  baseOrigin?: string,
): ParsedRobotsTxt {
  const lines = rawText.split(/\r?\n/);
  const sitemapSet = new Set<string>();
  const mortemRules: RobotsTxtRule[] = [];
  const wildcardRules: RobotsTxtRule[] = [];

  let currentAgents: string[] = [];
  let sawRuleInCurrentGroup = false;
  let hasMortemGroup = false;
  let hasWildcardGroup = false;

  for (const rawLine of lines) {
    const commentIndex = rawLine.indexOf("#");
    const cleanLine = (
      commentIndex >= 0 ? rawLine.slice(0, commentIndex) : rawLine
    ).trim();
    if (!cleanLine) {
      continue;
    }

    const colonIndex = cleanLine.indexOf(":");
    if (colonIndex <= 0) {
      continue;
    }

    const directive = cleanLine.slice(0, colonIndex).trim().toLowerCase();
    const value = cleanLine.slice(colonIndex + 1).trim();

    if (directive === "sitemap") {
      if (value) {
        try {
          const resolved = baseOrigin
            ? new URL(value, baseOrigin).toString()
            : new URL(value).toString();
          if (
            resolved.startsWith("http://") ||
            resolved.startsWith("https://")
          ) {
            sitemapSet.add(resolved);
          }
        } catch {
          // Ignore malformed Sitemap URLs
        }
      }
      continue;
    }

    if (directive === "user-agent") {
      const agentToken = value.toLowerCase();
      if (sawRuleInCurrentGroup) {
        currentAgents = [];
        sawRuleInCurrentGroup = false;
      }
      currentAgents.push(agentToken);
      if (agentToken.includes("mortembot")) {
        hasMortemGroup = true;
      } else if (agentToken === "*") {
        hasWildcardGroup = true;
      }
      continue;
    }

    if (directive === "allow" || directive === "disallow") {
      sawRuleInCurrentGroup = true;
      // Per RFC 9309, an empty Disallow: means allow everything (no-op disallow).
      if (!value) {
        continue;
      }
      const rule: RobotsTxtRule = {
        type: directive,
        pattern: value,
      };
      const appliesToMortem = currentAgents.some((a) =>
        a.includes("mortembot"),
      );
      const appliesToWildcard = currentAgents.includes("*");

      if (appliesToMortem) {
        mortemRules.push(rule);
      }
      if (appliesToWildcard) {
        wildcardRules.push(rule);
      }
    }
  }

  if (hasMortemGroup) {
    return {
      matchedUserAgent: "mortembot",
      rules: mortemRules,
      sitemapUrls: [...sitemapSet],
    };
  }

  if (hasWildcardGroup) {
    return {
      matchedUserAgent: "wildcard",
      rules: wildcardRules,
      sitemapUrls: [...sitemapSet],
    };
  }

  return {
    matchedUserAgent: "none",
    rules: [],
    sitemapUrls: [...sitemapSet],
  };
}

function robotsPatternToRegExp(pattern: string): RegExp {
  const hasEndAnchor = pattern.endsWith("$");
  const core = hasEndAnchor ? pattern.slice(0, -1) : pattern;
  const escaped = core
    .split("*")
    .map((segment) => segment.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}${hasEndAnchor ? "$" : ""}`);
}

/**
 * Evaluates whether a URL path (including optional query string) is allowed by parsed `robots.txt` rules.
 * Longest matching pattern wins; ties between `allow` and `disallow` favor `allow` per RFC 9309.
 */
export function evaluateRobotsTxtPath(
  pathWithQuery: string,
  parsed: ParsedRobotsTxt,
): { allowed: boolean; matchedRule: RobotsTxtRule | null } {
  const normalizedPath = pathWithQuery.startsWith("/")
    ? pathWithQuery
    : `/${pathWithQuery}`;

  let bestMatch: RobotsTxtRule | null = null;
  let bestLength = -1;

  for (const rule of parsed.rules) {
    const regex = robotsPatternToRegExp(rule.pattern);
    if (regex.test(normalizedPath)) {
      const effectiveLength = rule.pattern.replace(/\*/g, "").length;
      if (
        effectiveLength > bestLength ||
        (effectiveLength === bestLength &&
          rule.type === "allow" &&
          bestMatch?.type === "disallow")
      ) {
        bestMatch = rule;
        bestLength = effectiveLength;
      }
    }
  }

  if (!bestMatch) {
    return { allowed: true, matchedRule: null };
  }

  return {
    allowed: bestMatch.type === "allow",
    matchedRule: bestMatch,
  };
}

export function isPathAllowedByRobots(
  pathWithQuery: string,
  parsed: ParsedRobotsTxt,
): boolean {
  return evaluateRobotsTxtPath(pathWithQuery, parsed).allowed;
}

/**
 * Canonicalizes a candidate URL and verifies that it belongs to `expectedOrigin` and is an HTML page candidate.
 */
export function canonicalizeSameOriginUrl(
  rawUrl: string,
  baseUrl: string,
  expectedOrigin: string,
): { url: string; normalizedUrl: string; pathname: string } | null {
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return null;
  }

  if (
    /^(?:mailto:|tel:|javascript:|data:|vbscript:|ftp:|file:)/i.test(trimmed)
  ) {
    return null;
  }

  let resolved: URL;
  try {
    resolved = new URL(trimmed, baseUrl);
  } catch {
    return null;
  }

  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
    return null;
  }

  if (resolved.origin.toLowerCase() !== expectedOrigin.toLowerCase()) {
    return null;
  }

  if (NON_PAGE_EXTENSION_REGEX.test(resolved.pathname)) {
    return null;
  }

  try {
    const normalized = validateAndNormalizeIntakeUrl(resolved.toString());
    if (normalized.origin.toLowerCase() !== expectedOrigin.toLowerCase()) {
      return null;
    }
    const parsedNormalized = new URL(normalized.normalizedUrl);
    if (
      parsedNormalized.pathname.length > 1 &&
      parsedNormalized.pathname.endsWith("/")
    ) {
      parsedNormalized.pathname =
        parsedNormalized.pathname.replace(/\/+$/, "") || "/";
    }
    const finalUrl = parsedNormalized.toString();
    return {
      url: finalUrl,
      normalizedUrl: finalUrl,
      pathname: parsedNormalized.pathname,
    };
  } catch {
    return null;
  }
}

/**
 * Classifies a candidate URL by path and optional anchor text heuristics into a high-value template category.
 */
export function classifyDiscoveryTemplate(
  urlOrPath: string,
  anchorText = "",
): DiscoveryTemplateCategory {
  let pathname = urlOrPath;
  try {
    if (urlOrPath.startsWith("http://") || urlOrPath.startsWith("https://")) {
      pathname = new URL(urlOrPath).pathname;
    }
  } catch {
    // Keep raw path
  }

  const cleanPath = pathname.toLowerCase().replace(/\/+$/, "") || "/";
  const anchor = anchorText.trim().toLowerCase();

  if (
    cleanPath === "/" ||
    /^\/(?:home|index(?:\.html?)?|en|en-us|en-gb)$/i.test(cleanPath)
  ) {
    return "home";
  }

  const segments = cleanPath.split("/").filter(Boolean);
  const pathJoined = segments.join("/");

  // 1. Pricing
  if (
    /\b(?:pricing|plans|packages|subscriptions|rate-card|cost|tiers)\b/i.test(
      pathJoined,
    ) ||
    /\b(?:pricing|plans\s*(?:&|and)\s*pricing|compare\s*plans)\b/i.test(anchor)
  ) {
    return "pricing";
  }

  // 2. Contact / Demo / Sales
  if (
    /\b(?:contact|contact-us|get-in-touch|talk-to-sales|book-a-demo|book-demo|request-demo|schedule-demo|support|help-center)\b/i.test(
      pathJoined,
    ) ||
    /\b(?:contact(?:\s+us)?|talk\s+to\s+sales|book\s+(?:a\s+)?demo|get\s+in\s+touch)\b/i.test(
      anchor,
    )
  ) {
    return "contact";
  }

  // 3. Auth / Signup / Checkout
  if (
    /\b(?:sign-up|signup|register|create-account|get-started|start-free|free-trial|trial|checkout|cart|subscribe|sign-in|signin|login|log-in)\b/i.test(
      pathJoined,
    ) ||
    /\b(?:sign\s*up|get\s+started|start\s+free\s+trial|create\s+account|checkout|sign\s*in|log\s*in)\b/i.test(
      anchor,
    )
  ) {
    return "auth";
  }

  // 4. Product / Service / Features / Solutions
  if (
    /\b(?:product|products|features|solutions|services|platform|capabilities|integrations|use-cases|workflows|how-it-works|tour|enterprise)\b/i.test(
      pathJoined,
    ) ||
    /\b(?:products?|features|solutions|services|how\s+it\s+works|integrations)\b/i.test(
      anchor,
    )
  ) {
    return "product";
  }

  // 5. About / Company / Customers / Case Studies
  if (
    /\b(?:about|about-us|company|our-story|mission|team|leadership|careers|jobs|customers|case-studies|testimonials|press)\b/i.test(
      pathJoined,
    ) ||
    /\b(?:about(?:\s+us)?|our\s+story|company|customers|case\s+studies)\b/i.test(
      anchor,
    )
  ) {
    return "about";
  }

  // 6. Blog / Editorial / Resources
  if (
    /\b(?:blog|news|articles|posts|insights|resources|guides|changelog|release-notes|learn|podcast|webinars)\b/i.test(
      pathJoined,
    ) ||
    /\b(?:blog|articles|news|changelog|resources)\b/i.test(anchor)
  ) {
    return "blog";
  }

  // 7. Docs / Developer Reference
  if (
    /\b(?:docs|documentation|developers|api-reference|api|sdk|reference|manual)\b/i.test(
      pathJoined,
    ) ||
    /\b(?:documentation|docs|api\s+reference|developers)\b/i.test(anchor)
  ) {
    return "docs";
  }

  // 8. Legal / Privacy / Terms / Security
  if (
    /\b(?:privacy|privacy-policy|terms|terms-of-service|tos|legal|cookies|cookie-policy|gdpr|dpa|compliance|security|Acceptable-use)\b/i.test(
      pathJoined,
    ) ||
    /\b(?:privacy(?:\s+policy)?|terms(?:\s+of\s+service)?|cookie\s+policy|legal)\b/i.test(
      anchor,
    )
  ) {
    return "legal";
  }

  return "other";
}

/**
 * Extracts internal `<a href>` and `<link rel="canonical">` links from HTML using Cheerio.
 */
export function extractInternalLinksFromHtml(
  html: string,
  baseUrl: string,
  expectedOrigin?: string,
): ExtractedHtmlLink[] {
  if (!html || !html.trim()) {
    return [];
  }

  let origin = expectedOrigin;
  if (!origin) {
    try {
      origin = new URL(baseUrl).origin;
    } catch {
      return [];
    }
  }

  const $ = loadCheerio(html);
  const extracted: ExtractedHtmlLink[] = [];

  $('link[rel="canonical"]').each((_idx, el) => {
    const href = $(el).attr("href")?.trim();
    if (!href) return;
    const canonical = canonicalizeSameOriginUrl(href, baseUrl, origin!);
    if (canonical) {
      extracted.push({
        href: canonical.normalizedUrl,
        anchorText: "",
        rel: "canonical",
      });
    }
  });

  $("a[href]").each((_idx, el) => {
    const rawHref = $(el).attr("href")?.trim();
    if (!rawHref) return;
    const canonical = canonicalizeSameOriginUrl(rawHref, baseUrl, origin!);
    if (!canonical) return;

    const text =
      $(el).text().replace(/\s+/g, " ").trim() ||
      $(el).attr("aria-label")?.trim() ||
      $(el).attr("title")?.trim() ||
      "";

    extracted.push({
      href: canonical.normalizedUrl,
      anchorText: text.slice(0, 160),
      rel: "a",
    });
  });

  return extracted;
}

/**
 * Parses an XML sitemap (`<urlset>`) or sitemap index (`<sitemapindex>`).
 * Tolerates malformed XML blocks and namespaces without throwing.
 */
export function parseSitemapXml(xmlText: string): {
  kind: "urlset" | "sitemapindex" | "malformed";
  urls: string[];
  childSitemaps: string[];
} {
  const trimmed = xmlText.trim();
  if (!trimmed) {
    return { kind: "malformed", urls: [], childSitemaps: [] };
  }

  const hasSitemapIndex = /<(?:\w+:)?sitemapindex\b/i.test(trimmed);
  const hasUrlset = /<(?:\w+:)?urlset\b/i.test(trimmed);

  if (!hasSitemapIndex && !hasUrlset) {
    return { kind: "malformed", urls: [], childSitemaps: [] };
  }

  const decodeXmlEntities = (val: string): string =>
    val
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .trim();

  if (hasSitemapIndex) {
    const childSitemaps: string[] = [];
    const sitemapBlocks =
      trimmed.match(/<(?:\w+:)?sitemap\b[\s\S]*?<\/(?:\w+:)?sitemap>/gi) ?? [];
    for (const block of sitemapBlocks) {
      const locMatch = block.match(
        /<(?:\w+:)?loc\b[^>]*>([\s\S]*?)<\/(?:\w+:)?loc>/i,
      );
      if (locMatch?.[1]) {
        const loc = decodeXmlEntities(locMatch[1]);
        if (loc) {
          childSitemaps.push(loc);
        }
      }
    }
    return {
      kind: "sitemapindex",
      urls: [],
      childSitemaps,
    };
  }

  const urls: string[] = [];
  const urlBlocks =
    trimmed.match(/<(?:\w+:)?url\b[\s\S]*?<\/(?:\w+:)?url>/gi) ?? [];
  for (const block of urlBlocks) {
    const locMatch = block.match(
      /<(?:\w+:)?loc\b[^>]*>([\s\S]*?)<\/(?:\w+:)?loc>/i,
    );
    if (locMatch?.[1]) {
      const loc = decodeXmlEntities(locMatch[1]);
      if (loc) {
        urls.push(loc);
      }
    }
  }

  return {
    kind: "urlset",
    urls,
    childSitemaps: [],
  };
}

/**
 * Decompresses gzip-compressed bytes (`0x1f 0x8b`) using the Web `DecompressionStream("gzip")` API.
 */
export async function decompressGzipBytes(
  bytes: Uint8Array,
  maxOutputBytes = MAX_SITEMAP_BYTES,
): Promise<string> {
  const isGzipMagic =
    bytes.byteLength >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  if (!isGzipMagic) {
    return new TextDecoder("utf-8").decode(bytes);
  }

  const stream = new Blob([bytes as unknown as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      totalBytes += value.byteLength;
      if (totalBytes > maxOutputBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(
          `Decompressed gzip sitemap exceeded byte cap (${maxOutputBytes} bytes).`,
        );
      }
      chunks.push(value);
    }
  }

  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder("utf-8").decode(merged);
}

interface SafeBoundedFetchResult {
  ok: boolean;
  statusCode: number | null;
  finalUrl: string;
  bytes: Uint8Array;
  contentType: string;
  failureKind?: "unreachable" | "redirect_loop" | "too_large" | "ssrf_blocked";
  error?: string;
}

async function fetchSameOriginBoundedBytes(params: {
  url: string;
  expectedOrigin: string;
  maxBytes: number;
  fetchFn: typeof fetch;
}): Promise<SafeBoundedFetchResult> {
  const visited = new Set<string>();
  let currentUrl = params.url;

  for (let hop = 0; hop <= MAX_DISCOVERY_REDIRECT_HOPS; hop += 1) {
    let normalizedCurrent: string;
    try {
      const checked = validateAndNormalizeIntakeUrl(currentUrl);
      if (
        checked.origin.toLowerCase() !== params.expectedOrigin.toLowerCase()
      ) {
        return {
          ok: false,
          statusCode: null,
          finalUrl: currentUrl,
          bytes: new Uint8Array(0),
          contentType: "",
          failureKind: "ssrf_blocked",
          error: `Cross-origin redirect or resource blocked (${checked.origin}).`,
        };
      }
      normalizedCurrent = checked.normalizedUrl;
    } catch (err) {
      return {
        ok: false,
        statusCode: null,
        finalUrl: currentUrl,
        bytes: new Uint8Array(0),
        contentType: "",
        failureKind: "ssrf_blocked",
        error: err instanceof Error ? err.message : "Invalid discovery URL",
      };
    }

    if (visited.has(normalizedCurrent)) {
      return {
        ok: false,
        statusCode: null,
        finalUrl: normalizedCurrent,
        bytes: new Uint8Array(0),
        contentType: "",
        failureKind: "redirect_loop",
        error: `Redirect loop detected while fetching ${normalizedCurrent}`,
      };
    }
    visited.add(normalizedCurrent);

    let response: Response;
    try {
      response = await params.fetchFn(normalizedCurrent, {
        method: "GET",
        redirect: "manual",
        headers: {
          "user-agent": READ_ONLY_SCAN_POLICY.userAgent,
          accept: "text/plain, application/xml, text/xml, text/html, */*;q=0.8",
        },
      });
    } catch (err) {
      return {
        ok: false,
        statusCode: null,
        finalUrl: normalizedCurrent,
        bytes: new Uint8Array(0),
        contentType: "",
        failureKind: "unreachable",
        error: err instanceof Error ? err.message : "Network error",
      };
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location")?.trim();
      if (!location) {
        return {
          ok: false,
          statusCode: response.status,
          finalUrl: normalizedCurrent,
          bytes: new Uint8Array(0),
          contentType: "",
          failureKind: "unreachable",
          error: `Redirect (${response.status}) missing Location header`,
        };
      }
      if (hop === MAX_DISCOVERY_REDIRECT_HOPS) {
        return {
          ok: false,
          statusCode: response.status,
          finalUrl: normalizedCurrent,
          bytes: new Uint8Array(0),
          contentType: "",
          failureKind: "redirect_loop",
          error: `Exceeded maximum discovery redirect hops (${MAX_DISCOVERY_REDIRECT_HOPS})`,
        };
      }
      try {
        currentUrl = new URL(location, normalizedCurrent).toString();
      } catch {
        return {
          ok: false,
          statusCode: response.status,
          finalUrl: normalizedCurrent,
          bytes: new Uint8Array(0),
          contentType: "",
          failureKind: "unreachable",
          error: `Invalid redirect Location header: ${location}`,
        };
      }
      continue;
    }

    if (!response.ok) {
      return {
        ok: false,
        statusCode: response.status,
        finalUrl: normalizedCurrent,
        bytes: new Uint8Array(0),
        contentType: response.headers.get("content-type") ?? "",
        failureKind: "unreachable",
        error: `HTTP ${response.status}`,
      };
    }

    const contentLengthHeader = response.headers.get("content-length");
    if (contentLengthHeader) {
      const declaredBytes = Number(contentLengthHeader);
      if (Number.isFinite(declaredBytes) && declaredBytes > params.maxBytes) {
        return {
          ok: false,
          statusCode: response.status,
          finalUrl: normalizedCurrent,
          bytes: new Uint8Array(0),
          contentType: response.headers.get("content-type") ?? "",
          failureKind: "too_large",
          error: `Content-Length (${declaredBytes}) exceeds cap (${params.maxBytes})`,
        };
      }
    }

    try {
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > params.maxBytes) {
        return {
          ok: false,
          statusCode: response.status,
          finalUrl: normalizedCurrent,
          bytes: new Uint8Array(0),
          contentType: response.headers.get("content-type") ?? "",
          failureKind: "too_large",
          error: `Body size (${buffer.byteLength}) exceeds cap (${params.maxBytes})`,
        };
      }
      return {
        ok: true,
        statusCode: response.status,
        finalUrl: normalizedCurrent,
        bytes: new Uint8Array(buffer),
        contentType: response.headers.get("content-type") ?? "",
      };
    } catch (err) {
      return {
        ok: false,
        statusCode: response.status,
        finalUrl: normalizedCurrent,
        bytes: new Uint8Array(0),
        contentType: response.headers.get("content-type") ?? "",
        failureKind: "unreachable",
        error: err instanceof Error ? err.message : "Failed to read body",
      };
    }
  }

  return {
    ok: false,
    statusCode: null,
    finalUrl: currentUrl,
    bytes: new Uint8Array(0),
    contentType: "",
    failureKind: "redirect_loop",
    error: "Exceeded discovery redirect hops",
  };
}

/**
 * Selects up to `maxPages` high-value pages from a deduplicated candidate list.
 * Guarantees that the entry page (`home`) is included first, followed by one representative of each
 * available high-value template (`pricing`, `contact`, `product`, `about`, `auth`, `blog`, `docs`, `legal`),
 * and then fills remaining capacity by priority rank and shorter path depth.
 */
export function selectPrioritizedDiscoveryPages(
  candidates: readonly DiscoveredPageCandidate[],
  entryNormalizedUrl: string,
  maxPages: number,
): DiscoveredPageCandidate[] {
  const cap = Math.max(1, Math.floor(maxPages));
  if (candidates.length === 0) {
    return [];
  }

  const compareCandidates = (
    a: DiscoveredPageCandidate,
    b: DiscoveredPageCandidate,
  ): number => {
    if (a.normalizedUrl === entryNormalizedUrl) return -1;
    if (b.normalizedUrl === entryNormalizedUrl) return 1;
    if (a.priorityRank !== b.priorityRank) {
      return a.priorityRank - b.priorityRank;
    }
    const depthA = a.pathname.split("/").filter(Boolean).length;
    const depthB = b.pathname.split("/").filter(Boolean).length;
    if (depthA !== depthB) {
      return depthA - depthB;
    }
    if (a.pathname.length !== b.pathname.length) {
      return a.pathname.length - b.pathname.length;
    }
    return a.normalizedUrl.localeCompare(b.normalizedUrl);
  };

  const sorted = [...candidates].sort(compareCandidates);
  const selected: DiscoveredPageCandidate[] = [];
  const selectedUrls = new Set<string>();

  const entryCandidate = sorted.find(
    (c) => c.normalizedUrl === entryNormalizedUrl,
  );
  if (entryCandidate) {
    selected.push(entryCandidate);
    selectedUrls.add(entryCandidate.normalizedUrl);
  }

  // Pass 1: Ensure template diversity across high-value categories before duplicating any single category
  const highValueCategories: DiscoveryTemplateCategory[] = [
    "home",
    "pricing",
    "contact",
    "product",
    "about",
    "auth",
    "blog",
    "docs",
    "legal",
  ];

  for (const category of highValueCategories) {
    if (selected.length >= cap) break;
    if (selected.some((c) => c.category === category)) {
      continue;
    }
    const bestForCategory = sorted.find(
      (c) => c.category === category && !selectedUrls.has(c.normalizedUrl),
    );
    if (bestForCategory) {
      selected.push(bestForCategory);
      selectedUrls.add(bestForCategory.normalizedUrl);
    }
  }

  // Pass 2: Fill remaining slots up to `maxPages` in sorted priority order
  for (const candidate of sorted) {
    if (selected.length >= cap) break;
    if (!selectedUrls.has(candidate.normalizedUrl)) {
      selected.push(candidate);
      selectedUrls.add(candidate.normalizedUrl);
    }
  }

  return selected;
}

/**
 * Discovers same-origin pages for a scan via `/robots.txt`, XML sitemaps (including `.xml.gz` and `<sitemapindex>`),
 * and internal `<a href>` + `<link rel="canonical">` links from homepage HTML.
 */
export async function discoverSitePages(
  options: DiscoverSitePagesOptions,
): Promise<SiteDiscoveryResult> {
  const fetchFn = options.fetchFn ?? fetch;
  const maxInspectedUrls =
    options.maxInspectedUrls ?? DEFAULT_MAX_INSPECTED_URLS;
  const maxChildSitemaps =
    options.maxChildSitemaps ?? DEFAULT_MAX_CHILD_SITEMAPS;

  const entryValidated = validateAndNormalizeIntakeUrl(options.targetUrl);
  const origin = entryValidated.origin;
  const entryUrl = entryValidated.normalizedUrl;
  const maxPages = resolvePlanPageCap(options.plan, options.maxPages);

  // 1. Fetch & parse /robots.txt
  const robotsUrl = `${origin}/robots.txt`;
  const robotsFetch = await fetchSameOriginBoundedBytes({
    url: robotsUrl,
    expectedOrigin: origin,
    maxBytes: MAX_ROBOTS_TXT_BYTES,
    fetchFn,
  });

  let parsedRobots: ParsedRobotsTxt = {
    matchedUserAgent: "none",
    rules: [],
    sitemapUrls: [],
  };
  let robotsError: string | undefined;

  if (robotsFetch.ok) {
    const text = new TextDecoder("utf-8").decode(robotsFetch.bytes);
    parsedRobots = parseRobotsTxt(text, origin);
  } else if (robotsFetch.statusCode !== 404) {
    robotsError = robotsFetch.error;
  }

  const skippedDisallowedUrls: RobotsSkippedEntry[] = [];
  const skippedNormalizedSet = new Set<string>();
  const candidateMap = new Map<string, DiscoveredPageCandidate>();
  let totalCandidatesInspected = 0;

  const considerCandidateUrl = (
    rawCandidateUrl: string,
    baseUrl: string,
    source: DiscoverySource,
    anchorText = "",
  ): void => {
    if (totalCandidatesInspected >= maxInspectedUrls && source !== "entry") {
      return;
    }

    const canonical = canonicalizeSameOriginUrl(
      rawCandidateUrl,
      baseUrl,
      origin,
    );
    if (!canonical) {
      return;
    }

    const existing = candidateMap.get(canonical.normalizedUrl);
    if (existing) {
      if (!existing.sources.includes(source)) {
        existing.sources.push(source);
      }
      if (anchorText && !existing.anchorText) {
        existing.anchorText = anchorText;
        if (existing.category === "other") {
          const upgraded = classifyDiscoveryTemplate(
            canonical.pathname,
            anchorText,
          );
          existing.category = upgraded;
          existing.templateType = toDbPageTemplateType(upgraded);
          existing.priorityRank = TEMPLATE_PRIORITY_ORDER[upgraded];
        }
      }
      return;
    }

    totalCandidatesInspected += 1;

    const parsedCandidate = new URL(canonical.normalizedUrl);
    const pathWithQuery = `${parsedCandidate.pathname}${parsedCandidate.search}`;
    const robotsEval = evaluateRobotsTxtPath(pathWithQuery, parsedRobots);

    if (!robotsEval.allowed) {
      if (!skippedNormalizedSet.has(canonical.normalizedUrl)) {
        skippedNormalizedSet.add(canonical.normalizedUrl);
        skippedDisallowedUrls.push({
          url: canonical.url,
          normalizedUrl: canonical.normalizedUrl,
          matchedRule: robotsEval.matchedRule?.pattern ?? "/",
          source,
        });
      }
      return;
    }

    const category =
      canonical.normalizedUrl === entryUrl &&
      (canonical.pathname === "/" ||
        classifyDiscoveryTemplate(canonical.pathname, anchorText) === "other")
        ? "home"
        : classifyDiscoveryTemplate(canonical.pathname, anchorText);

    candidateMap.set(canonical.normalizedUrl, {
      url: canonical.url,
      normalizedUrl: canonical.normalizedUrl,
      pathname: canonical.pathname,
      category,
      templateType: toDbPageTemplateType(category),
      priorityRank: TEMPLATE_PRIORITY_ORDER[category],
      sources: [source],
      ...(anchorText ? { anchorText } : {}),
    });
  };

  // Seed entry URL first
  const entryUrlObj = new URL(entryUrl);
  const entryRobotsEval = evaluateRobotsTxtPath(
    `${entryUrlObj.pathname}${entryUrlObj.search}`,
    parsedRobots,
  );
  const entryUrlDisallowed = !entryRobotsEval.allowed;
  considerCandidateUrl(entryUrl, origin, "entry");

  // 2. Discover URLs from XML sitemaps (from robots.txt Sitemap: directives or fallback /sitemap.xml)
  const sitemapDiagnostics: SitemapFetchDiagnostic[] = [];
  const visitedSitemaps = new Set<string>();
  const initialSitemapQueue: string[] = [];

  for (const directiveUrl of parsedRobots.sitemapUrls) {
    try {
      const parsed = new URL(directiveUrl, origin);
      if (parsed.origin.toLowerCase() === origin.toLowerCase()) {
        initialSitemapQueue.push(parsed.toString());
      }
    } catch {
      // Ignore invalid directive
    }
  }

  if (initialSitemapQueue.length === 0) {
    initialSitemapQueue.push(`${origin}/sitemap.xml`);
  }

  const processSitemapUrl = async (
    sitemapUrl: string,
    allowIndexExpansion: boolean,
  ): Promise<string[]> => {
    if (
      visitedSitemaps.has(sitemapUrl) ||
      totalCandidatesInspected >= maxInspectedUrls
    ) {
      return [];
    }
    visitedSitemaps.add(sitemapUrl);

    const fetchResult = await fetchSameOriginBoundedBytes({
      url: sitemapUrl,
      expectedOrigin: origin,
      maxBytes: MAX_SITEMAP_BYTES,
      fetchFn,
    });

    if (!fetchResult.ok) {
      sitemapDiagnostics.push({
        sitemapUrl,
        status: fetchResult.failureKind ?? "unreachable",
        urlsExtracted: 0,
        error: fetchResult.error,
      });
      return [];
    }

    let xmlText: string;
    try {
      xmlText = await decompressGzipBytes(fetchResult.bytes, MAX_SITEMAP_BYTES);
    } catch (err) {
      sitemapDiagnostics.push({
        sitemapUrl,
        status: "malformed",
        urlsExtracted: 0,
        error:
          err instanceof Error
            ? err.message
            : "Failed to decompress gzip sitemap",
      });
      return [];
    }

    const parsed = parseSitemapXml(xmlText);
    if (parsed.kind === "malformed") {
      sitemapDiagnostics.push({
        sitemapUrl,
        status: "malformed",
        urlsExtracted: 0,
        error:
          "Response was not a valid <urlset> or <sitemapindex> XML document.",
      });
      return [];
    }

    if (parsed.kind === "sitemapindex") {
      sitemapDiagnostics.push({
        sitemapUrl,
        status: "ok",
        urlsExtracted: parsed.childSitemaps.length,
      });
      return allowIndexExpansion ? parsed.childSitemaps : [];
    }

    let addedCount = 0;
    for (const loc of parsed.urls) {
      if (totalCandidatesInspected >= maxInspectedUrls) break;
      considerCandidateUrl(loc, sitemapUrl, "sitemap");
      addedCount += 1;
    }

    sitemapDiagnostics.push({
      sitemapUrl,
      status: "ok",
      urlsExtracted: addedCount,
    });
    return [];
  };

  const childSitemapsToFetch: string[] = [];
  for (const rootSitemapUrl of initialSitemapQueue.slice(0, maxChildSitemaps)) {
    const discoveredChildren = await processSitemapUrl(rootSitemapUrl, true);
    for (const childUrl of discoveredChildren) {
      if (childSitemapsToFetch.length < maxChildSitemaps) {
        childSitemapsToFetch.push(childUrl);
      }
    }
  }

  for (const childSitemapUrl of childSitemapsToFetch) {
    if (totalCandidatesInspected >= maxInspectedUrls) break;
    await processSitemapUrl(childSitemapUrl, false);
  }

  // 3. Extract internal links and canonical URL from homepage HTML (supplied or fetched)
  let homepageHtml = options.homepageHtml;
  if (homepageHtml === undefined && !entryUrlDisallowed) {
    const homeFetch = await fetchSameOriginBoundedBytes({
      url: entryUrl,
      expectedOrigin: origin,
      maxBytes: MAX_SITEMAP_BYTES,
      fetchFn,
    });
    if (homeFetch.ok) {
      homepageHtml = new TextDecoder("utf-8").decode(homeFetch.bytes);
    }
  }

  if (homepageHtml) {
    const htmlLinks = extractInternalLinksFromHtml(
      homepageHtml,
      entryUrl,
      origin,
    );
    for (const link of htmlLinks) {
      if (totalCandidatesInspected >= maxInspectedUrls) break;
      considerCandidateUrl(
        link.href,
        entryUrl,
        link.rel === "canonical" ? "canonical" : "internal_link",
        link.anchorText,
      );
    }
  }

  // 4. Prioritize and select up to `maxPages`
  const allAllowedCandidates = [...candidateMap.values()];
  const selectedPages = selectPrioritizedDiscoveryPages(
    allAllowedCandidates,
    entryUrl,
    maxPages,
  );

  const templateBreakdown: Partial<Record<DiscoveryTemplateCategory, number>> =
    {};
  for (const page of selectedPages) {
    templateBreakdown[page.category] =
      (templateBreakdown[page.category] ?? 0) + 1;
  }

  return {
    origin,
    entryUrl,
    entryUrlDisallowed,
    maxPages,
    robots: {
      fetched: robotsFetch.ok,
      statusCode: robotsFetch.statusCode,
      matchedUserAgent: parsedRobots.matchedUserAgent,
      sitemapDirectives: parsedRobots.sitemapUrls,
      rulesCount: parsedRobots.rules.length,
      ...(robotsError ? { error: robotsError } : {}),
    },
    sitemaps: sitemapDiagnostics,
    totalCandidatesInspected,
    selectedPages,
    skippedDisallowedUrls,
    templateBreakdown,
  };
}

export interface PersistDiscoveredPagesOptions {
  d1: D1DatabaseLike;
  scanId: string;
  discovery: SiteDiscoveryResult;
  nowMs?: number;
}

export interface PersistedDiscoveredPageRecord {
  pageId: string;
  url: string;
  normalizedUrl: string;
  category: DiscoveryTemplateCategory;
  templateType: PageTemplateType;
}

/**
 * Idempotently persists the selected discovered pages into the D1 `pages` table (`capture_status = 'pending'`).
 */
export async function persistDiscoveredPagesInD1(
  options: PersistDiscoveredPagesOptions,
): Promise<PersistedDiscoveredPageRecord[]> {
  const { d1, scanId, discovery } = options;
  const nowMs = options.nowMs ?? Date.now();
  const records: PersistedDiscoveredPageRecord[] = [];

  for (const candidate of discovery.selectedPages) {
    const existing = await d1
      .prepare(
        `SELECT id FROM pages
         WHERE scan_id = ? AND normalized_url = ?
         LIMIT 1`,
      )
      .bind(scanId, candidate.normalizedUrl)
      .first<{ id: string }>();

    if (existing?.id) {
      await d1
        .prepare(
          `UPDATE pages
           SET template_type = ?,
               updated_at = ?
           WHERE id = ?`,
        )
        .bind(candidate.templateType, nowMs, existing.id)
        .run();

      records.push({
        pageId: existing.id,
        url: candidate.url,
        normalizedUrl: candidate.normalizedUrl,
        category: candidate.category,
        templateType: candidate.templateType,
      });
    } else {
      const pageId = `page_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
      await d1
        .prepare(
          `INSERT INTO pages (
            id,
            scan_id,
            url,
            normalized_url,
            template_type,
            status_code,
            redirect_chain_json,
            load_timings_json,
            capture_status,
            failure_reason,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, NULL, '[]', '{}', 'pending', NULL, ?, ?)`,
        )
        .bind(
          pageId,
          scanId,
          candidate.url,
          candidate.normalizedUrl,
          candidate.templateType,
          nowMs,
          nowMs,
        )
        .run();

      records.push({
        pageId,
        url: candidate.url,
        normalizedUrl: candidate.normalizedUrl,
        category: candidate.category,
        templateType: candidate.templateType,
      });
    }
  }

  return records;
}
