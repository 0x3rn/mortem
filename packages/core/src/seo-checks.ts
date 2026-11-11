import { load as loadCheerio, type CheerioAPI } from "cheerio";

/**
 * Deterministic on-page SEO checks (THE-181).
 *
 * Pure functions only: `extractSeoFacts` reads one page's captured HTML and
 * response headers, `evaluateSeoRules` turns the facts of every page in a scan
 * into evidence-backed finding candidates. No network, no storage.
 *
 * The HTML is the rendered DOM snapshot captured by Browser Run, so rules see
 * what JavaScript produced. Every rule has a stable id and is documented in
 * docs/rule-catalog/seo.md.
 */

export const SEO_RULE_VERSION = "1.0.0";

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

export interface SeoPageInput {
  pageId: string;
  /** URL Mortem requested. */
  pageUrl: string;
  /** URL the browser ended on after redirects (used for canonical comparisons). */
  finalUrl: string;
  html: string;
  /** Main-document response headers (any case). `null` when not captured. */
  headers: Record<string, string> | null;
  /** True when site discovery found this page in the XML sitemap. */
  inSitemap: boolean;
  /** True when the HTML snapshot was cut at the per-page byte budget. */
  htmlTruncated: boolean;
}

export interface SeoHreflang {
  lang: string;
  href: string;
}

export interface SeoJsonLdBlock {
  index: number;
  validJson: boolean;
  parseError: string | null;
  hasSchemaOrgContext: boolean;
  /** Nodes (top-level items or @graph members) that have no `@type`. */
  nodesMissingType: number;
  types: string[];
}

export interface SeoPageFacts {
  pageId: string;
  pageUrl: string;
  finalUrl: string;
  inSitemap: boolean;
  htmlTruncated: boolean;
  title: string | null;
  metaDescription: string | null;
  h1Count: number;
  h1WithTextCount: number;
  headingLevels: { level: number; text: string }[];
  canonicalHrefs: string[];
  /** Directives that apply to all crawlers or Googlebot, lower-cased. */
  metaRobots: string[];
  xRobotsTag: string[];
  htmlLang: string | null;
  hreflangs: SeoHreflang[];
  openGraph: {
    title: string | null;
    description: string | null;
    image: string | null;
    url: string | null;
  };
  twitterCard: string | null;
  jsonLd: SeoJsonLdBlock[];
  /** `src` of meaningful images that have no `alt` attribute at all. */
  imagesMissingAlt: string[];
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function nonEmpty(text: string | undefined | null): string | null {
  if (text === undefined || text === null) return null;
  const collapsed = collapse(text);
  return collapsed.length > 0 ? collapsed : null;
}

/** Content of the first `<meta>` whose `name` or `property` matches (case-insensitive). */
function metaContent($: CheerioAPI, key: string): string | null {
  let found: string | null = null;
  $("meta").each((_, el) => {
    if (found !== null) return;
    const name = (
      $(el).attr("name") ??
      $(el).attr("property") ??
      ""
    ).toLowerCase();
    if (name === key) {
      found = nonEmpty($(el).attr("content"));
    }
  });
  return found;
}

/** Splits a robots directive list ("noindex, nofollow") into lower-case tokens. */
function robotsTokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

/** Directives from `X-Robots-Tag` that apply to every crawler or to Googlebot. */
function parseXRobotsTag(headerValue: string): string[] {
  const directives: string[] = [];
  // Multiple header instances may be joined with ", " — split per directive group.
  for (const part of headerValue.split(/\n/)) {
    const match = /^\s*([a-z0-9_-]+)\s*:\s*(.*)$/i.exec(part);
    if (match && !isRobotsDirective(match[1]!)) {
      const agent = match[1]!.toLowerCase();
      if (agent === "googlebot") directives.push(...robotsTokens(match[2]!));
      continue; // directives for another named crawler do not apply
    }
    directives.push(...robotsTokens(part));
  }
  return directives;
}

const ROBOTS_DIRECTIVES = new Set([
  "all",
  "noindex",
  "nofollow",
  "none",
  "noarchive",
  "nosnippet",
  "notranslate",
  "noimageindex",
  "unavailable_after",
  "max-snippet",
  "max-image-preview",
  "max-video-preview",
  "indexifembedded",
]);

function isRobotsDirective(token: string): boolean {
  return ROBOTS_DIRECTIVES.has(token.toLowerCase());
}

function headerValue(
  headers: Record<string, string> | null,
  name: string,
): string | null {
  if (!headers) return null;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted && typeof value === "string") return value;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contextIsSchemaOrg(context: unknown): boolean {
  if (typeof context === "string") return /schema\.org/i.test(context);
  if (Array.isArray(context)) return context.some(contextIsSchemaOrg);
  if (isRecord(context)) {
    const vocab = context["@vocab"];
    return typeof vocab === "string" && /schema\.org/i.test(vocab);
  }
  return false;
}

function typesOf(node: Record<string, unknown>): string[] {
  const type = node["@type"];
  if (typeof type === "string") return [type];
  if (Array.isArray(type))
    return type.filter((t): t is string => typeof t === "string");
  return [];
}

function analyzeJsonLd(text: string, index: number): SeoJsonLdBlock {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      index,
      validJson: false,
      parseError: err instanceof Error ? err.message : "Invalid JSON",
      hasSchemaOrgContext: false,
      nodesMissingType: 0,
      types: [],
    };
  }

  const items = Array.isArray(parsed) ? parsed : [parsed];
  let hasContext = items.length > 0;
  let nodesMissingType = 0;
  const types: string[] = [];

  for (const item of items) {
    if (!isRecord(item)) {
      hasContext = false;
      nodesMissingType += 1;
      continue;
    }
    if (!contextIsSchemaOrg(item["@context"])) hasContext = false;
    const graph = item["@graph"];
    const nodes = Array.isArray(graph) ? graph : [item];
    for (const node of nodes) {
      if (!isRecord(node) || typesOf(node).length === 0) {
        nodesMissingType += 1;
      } else {
        types.push(...typesOf(node));
      }
    }
  }

  return {
    index,
    validJson: true,
    parseError: null,
    hasSchemaOrgContext: hasContext,
    nodesMissingType,
    types,
  };
}

/** Images a sighted visitor would need described; decorative and tracking images are excluded. */
function isMeaningfulImage(
  $: CheerioAPI,
  el: Parameters<CheerioAPI>[0],
): boolean {
  const img = $(el);
  const role = (img.attr("role") ?? "").toLowerCase();
  if (role === "presentation" || role === "none") return false;
  if ((img.attr("aria-hidden") ?? "").toLowerCase() === "true") return false;
  const width = Number(img.attr("width"));
  const height = Number(img.attr("height"));
  if (
    (Number.isFinite(width) && width <= 1) ||
    (Number.isFinite(height) && height <= 1)
  ) {
    return false; // tracking pixel
  }
  return true;
}

/** Reads every SEO-relevant fact from one page's HTML and headers. */
export function extractSeoFacts(input: SeoPageInput): SeoPageFacts {
  const $ = loadCheerio(input.html);

  const headings: { level: number; text: string }[] = [];
  $("h1, h2, h3, h4, h5, h6").each((_, el) => {
    const tag = (el as { tagName?: string }).tagName ?? "";
    const level = Number(tag.slice(1));
    if (Number.isInteger(level)) {
      headings.push({ level, text: collapse($(el).text()).slice(0, 80) });
    }
  });

  let h1WithTextCount = 0;
  $("h1").each((_, el) => {
    const text = collapse($(el).text());
    const imgAlt = $(el)
      .find("img[alt]")
      .toArray()
      .some((img) => nonEmpty($(img).attr("alt")) !== null);
    if (text.length > 0 || imgAlt) h1WithTextCount += 1;
  });

  const canonicalHrefs: string[] = [];
  $("link").each((_, el) => {
    const rel = ($(el).attr("rel") ?? "").toLowerCase().split(/\s+/);
    if (rel.includes("canonical")) {
      canonicalHrefs.push(($(el).attr("href") ?? "").trim());
    }
  });

  const metaRobots: string[] = [];
  $("meta").each((_, el) => {
    const name = ($(el).attr("name") ?? "").toLowerCase();
    if (name === "robots" || name === "googlebot") {
      metaRobots.push(...robotsTokens($(el).attr("content") ?? ""));
    }
  });

  const hreflangs: SeoHreflang[] = [];
  $("link[hreflang]").each((_, el) => {
    const rel = ($(el).attr("rel") ?? "").toLowerCase().split(/\s+/);
    if (rel.includes("alternate")) {
      hreflangs.push({
        lang: ($(el).attr("hreflang") ?? "").trim(),
        href: ($(el).attr("href") ?? "").trim(),
      });
    }
  });

  const jsonLd: SeoJsonLdBlock[] = [];
  $("script").each((_, el) => {
    const type = ($(el).attr("type") ?? "").toLowerCase().trim();
    if (type === "application/ld+json") {
      jsonLd.push(analyzeJsonLd($(el).text(), jsonLd.length));
    }
  });

  const imagesMissingAlt: string[] = [];
  $("img").each((_, el) => {
    if ($(el).attr("alt") !== undefined) return; // alt="" is a deliberate decorative marker
    if (!isMeaningfulImage($, el)) return;
    imagesMissingAlt.push(
      ($(el).attr("src") ?? $(el).attr("data-src") ?? "").trim() ||
        "(image without src)",
    );
  });

  const xRobots = headerValue(input.headers, "x-robots-tag");

  return {
    pageId: input.pageId,
    pageUrl: input.pageUrl,
    finalUrl: input.finalUrl,
    inSitemap: input.inSitemap,
    htmlTruncated: input.htmlTruncated,
    title: nonEmpty($("title").first().text()),
    metaDescription: metaContent($, "description"),
    h1Count: $("h1").length,
    h1WithTextCount,
    headingLevels: headings,
    canonicalHrefs,
    metaRobots,
    xRobotsTag: xRobots ? parseXRobotsTag(xRobots) : [],
    htmlLang: nonEmpty($("html").attr("lang")),
    hreflangs,
    openGraph: {
      title: metaContent($, "og:title"),
      description: metaContent($, "og:description"),
      image: metaContent($, "og:image"),
      url: metaContent($, "og:url"),
    },
    twitterCard: metaContent($, "twitter:card"),
    jsonLd,
    imagesMissingAlt,
  };
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

function asAbsoluteHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null; // relative or malformed: not a valid absolute URL
  }
}

/** Comparable form of a URL: no fragment, no trailing slash except on the root path. */
export function normalizeUrlForComparison(value: string): string | null {
  const url = asAbsoluteHttpUrl(value);
  if (!url) return null;
  url.hash = "";
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }
  return url.toString();
}

const HREFLANG_PATTERN =
  /^(x-default|[a-z]{2,3}(-[a-z]{4})?(-([a-z]{2}|\d{3}))?)$/i;
const HTML_LANG_PATTERN = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i;

// ---------------------------------------------------------------------------
// Rule catalog
// ---------------------------------------------------------------------------

export type SeoSeverity = "high" | "medium" | "low";

export interface SeoRule {
  ruleId: string;
  scope: "page" | "site";
  title: string;
  severity: SeoSeverity;
  effort: "low" | "medium" | "high";
  impact: "low" | "medium" | "high" | "critical";
  fixRole: "developer" | "content" | "marketer";
  /** What a passing page looks like, stored as the finding threshold. */
  expectation: {
    operator: "lt" | "lte" | "gt" | "gte" | "eq" | "neq" | "exists";
    target: number | string | boolean;
    unit?: string;
  };
}

export const SEO_TITLE_MIN_CHARS = 20;
export const SEO_TITLE_MAX_CHARS = 60;
export const SEO_DESCRIPTION_MIN_CHARS = 70;
export const SEO_DESCRIPTION_MAX_CHARS = 160;
/** Titles that say nothing about the page (compared case-insensitively). */
export const SEO_BOILERPLATE_TITLES = [
  "home",
  "homepage",
  "home page",
  "index",
  "untitled",
  "untitled document",
  "document",
  "welcome",
  "new page",
  "page",
  "react app",
  "vite app",
  "vite + react",
  "vite + react + ts",
  "next.js",
  "create next app",
] as const;

export const SEO_RULES: readonly SeoRule[] = [
  {
    ruleId: "seo.title.missing",
    scope: "page",
    title: "Page has no title",
    severity: "high",
    effort: "low",
    impact: "high",
    fixRole: "content",
    expectation: { operator: "exists", target: true },
  },
  {
    ruleId: "seo.title.length",
    scope: "page",
    title: "Page title is too short or too long",
    severity: "low",
    effort: "low",
    impact: "medium",
    fixRole: "content",
    expectation: {
      operator: "lte",
      target: SEO_TITLE_MAX_CHARS,
      unit: "chars",
    },
  },
  {
    ruleId: "seo.title.boilerplate",
    scope: "page",
    title: "Page title is generic boilerplate",
    severity: "medium",
    effort: "low",
    impact: "high",
    fixRole: "content",
    expectation: { operator: "neq", target: "boilerplate" },
  },
  {
    ruleId: "seo.title.duplicate",
    scope: "site",
    title: "Several pages share the same title",
    severity: "medium",
    effort: "low",
    impact: "medium",
    fixRole: "content",
    expectation: { operator: "eq", target: 1, unit: "pages per title" },
  },
  {
    ruleId: "seo.meta-description.missing",
    scope: "page",
    title: "Page has no meta description",
    severity: "medium",
    effort: "low",
    impact: "medium",
    fixRole: "content",
    expectation: { operator: "exists", target: true },
  },
  {
    ruleId: "seo.meta-description.length",
    scope: "page",
    title: "Meta description is too short or too long",
    severity: "low",
    effort: "low",
    impact: "low",
    fixRole: "content",
    expectation: {
      operator: "lte",
      target: SEO_DESCRIPTION_MAX_CHARS,
      unit: "chars",
    },
  },
  {
    ruleId: "seo.meta-description.duplicate",
    scope: "site",
    title: "Several pages share the same meta description",
    severity: "low",
    effort: "low",
    impact: "medium",
    fixRole: "content",
    expectation: { operator: "eq", target: 1, unit: "pages per description" },
  },
  {
    ruleId: "seo.h1.missing",
    scope: "page",
    title: "Page has no H1 heading",
    severity: "medium",
    effort: "low",
    impact: "medium",
    fixRole: "content",
    expectation: { operator: "eq", target: 1, unit: "h1" },
  },
  {
    ruleId: "seo.h1.multiple",
    scope: "page",
    title: "Page has more than one H1 heading",
    severity: "low",
    effort: "low",
    impact: "low",
    fixRole: "developer",
    expectation: { operator: "eq", target: 1, unit: "h1" },
  },
  {
    ruleId: "seo.headings.skipped-level",
    scope: "page",
    title: "Heading levels are skipped",
    severity: "low",
    effort: "low",
    impact: "low",
    fixRole: "developer",
    expectation: { operator: "lte", target: 1, unit: "levels per step" },
  },
  {
    ruleId: "seo.canonical.missing",
    scope: "page",
    title: "Page has no canonical URL",
    severity: "medium",
    effort: "low",
    impact: "medium",
    fixRole: "developer",
    expectation: { operator: "exists", target: true },
  },
  {
    ruleId: "seo.canonical.invalid",
    scope: "page",
    title: "Canonical URL is invalid or ambiguous",
    severity: "medium",
    effort: "low",
    impact: "high",
    fixRole: "developer",
    expectation: { operator: "eq", target: "one absolute http(s) URL" },
  },
  {
    ruleId: "seo.canonical.cross-page",
    scope: "page",
    title: "Canonical URL points to a different page",
    severity: "medium",
    effort: "low",
    impact: "high",
    fixRole: "developer",
    expectation: { operator: "eq", target: "self" },
  },
  {
    ruleId: "seo.canonical.loop",
    scope: "site",
    title: "Canonical URLs point to each other in a loop",
    severity: "high",
    effort: "low",
    impact: "high",
    fixRole: "developer",
    expectation: { operator: "eq", target: "no loop" },
  },
  {
    ruleId: "seo.indexability.noindex",
    scope: "page",
    title: "Page tells search engines not to index it",
    severity: "high",
    effort: "low",
    impact: "critical",
    fixRole: "developer",
    expectation: { operator: "neq", target: "noindex" },
  },
  {
    ruleId: "seo.indexability.nofollow",
    scope: "page",
    title: "Page tells search engines not to follow its links",
    severity: "medium",
    effort: "low",
    impact: "medium",
    fixRole: "developer",
    expectation: { operator: "neq", target: "nofollow" },
  },
  {
    ruleId: "seo.indexability.sitemap-conflict",
    scope: "page",
    title: "Sitemap lists a page that blocks indexing",
    severity: "high",
    effort: "low",
    impact: "high",
    fixRole: "developer",
    expectation: { operator: "neq", target: "noindex while in sitemap" },
  },
  {
    ruleId: "seo.lang.missing",
    scope: "page",
    title: "Page does not declare its language",
    severity: "low",
    effort: "low",
    impact: "low",
    fixRole: "developer",
    expectation: { operator: "exists", target: true },
  },
  {
    ruleId: "seo.lang.invalid",
    scope: "page",
    title: "Page language code is not valid",
    severity: "low",
    effort: "low",
    impact: "low",
    fixRole: "developer",
    expectation: { operator: "eq", target: "BCP 47 language tag" },
  },
  {
    ruleId: "seo.hreflang.invalid",
    scope: "page",
    title: "Language alternate (hreflang) tags are invalid",
    severity: "medium",
    effort: "low",
    impact: "medium",
    fixRole: "developer",
    expectation: {
      operator: "eq",
      target: "valid language code and absolute URL",
    },
  },
  {
    ruleId: "seo.hreflang.missing-return",
    scope: "site",
    title: "Language alternate pages do not link back",
    severity: "medium",
    effort: "medium",
    impact: "medium",
    fixRole: "developer",
    expectation: { operator: "eq", target: "reciprocal hreflang" },
  },
  {
    ruleId: "seo.open-graph.missing",
    scope: "page",
    title: "Open Graph sharing tags are missing",
    severity: "medium",
    effort: "low",
    impact: "medium",
    fixRole: "marketer",
    expectation: {
      operator: "exists",
      target: "og:title, og:description, og:image, og:url",
    },
  },
  {
    ruleId: "seo.open-graph.invalid-image",
    scope: "page",
    title: "Open Graph image is not an absolute URL",
    severity: "low",
    effort: "low",
    impact: "medium",
    fixRole: "developer",
    expectation: { operator: "eq", target: "absolute http(s) URL" },
  },
  {
    ruleId: "seo.twitter-card.missing",
    scope: "page",
    title: "Twitter/X card tag is missing",
    severity: "low",
    effort: "low",
    impact: "low",
    fixRole: "marketer",
    expectation: { operator: "exists", target: true },
  },
  {
    ruleId: "seo.structured-data.invalid-json",
    scope: "page",
    title: "Structured data (JSON-LD) is not valid JSON",
    severity: "medium",
    effort: "low",
    impact: "medium",
    fixRole: "developer",
    expectation: { operator: "eq", target: "valid JSON" },
  },
  {
    ruleId: "seo.structured-data.missing-context-or-type",
    scope: "page",
    title: "Structured data (JSON-LD) lacks @context or @type",
    severity: "medium",
    effort: "low",
    impact: "medium",
    fixRole: "developer",
    expectation: {
      operator: "exists",
      target: "schema.org @context and @type",
    },
  },
  {
    ruleId: "seo.images.missing-alt",
    scope: "page",
    title: "Images are missing alt text",
    severity: "low",
    effort: "low",
    impact: "medium",
    fixRole: "content",
    expectation: { operator: "eq", target: 0, unit: "images without alt" },
  },
];

export const SEO_RULE_IDS: readonly string[] = SEO_RULES.map(
  (rule) => rule.ruleId,
);

const RULE_BY_ID: ReadonlyMap<string, SeoRule> = new Map(
  SEO_RULES.map((rule) => [rule.ruleId, rule]),
);

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export interface SeoViolation {
  ruleId: string;
  pageId: string;
  pageUrl: string;
  /** Which stored artifact proves it. */
  evidence: "html" | "headers";
  severity: SeoSeverity;
  excerpt: string;
  /** Extra structured context merged into the finding (e.g. duplicate groups). */
  context?: Record<string, unknown>;
}

const MAX_EXCERPT = 500;

function excerpt(text: string): string {
  return text.length > MAX_EXCERPT
    ? `${text.slice(0, MAX_EXCERPT - 1)}…`
    : text;
}

function quote(text: string): string {
  return `"${text}"`;
}

function violation(
  ruleId: string,
  facts: SeoPageFacts,
  text: string,
  extra: Partial<Pick<SeoViolation, "evidence" | "severity" | "context">> = {},
): SeoViolation {
  const rule = RULE_BY_ID.get(ruleId);
  if (!rule) throw new Error(`Unknown SEO rule ${ruleId}`);
  return {
    ruleId,
    pageId: facts.pageId,
    pageUrl: facts.pageUrl,
    evidence: extra.evidence ?? "html",
    severity: extra.severity ?? rule.severity,
    excerpt: excerpt(text),
    ...(extra.context ? { context: extra.context } : {}),
  };
}

function evaluateTitle(facts: SeoPageFacts): SeoViolation[] {
  if (facts.title === null) {
    return [
      violation(
        "seo.title.missing",
        facts,
        "No <title>, or the <title> is empty.",
      ),
    ];
  }
  const out: SeoViolation[] = [];
  const length = facts.title.length;
  if (length < SEO_TITLE_MIN_CHARS || length > SEO_TITLE_MAX_CHARS) {
    out.push(
      violation(
        "seo.title.length",
        facts,
        `Title is ${length} characters (aim for ${SEO_TITLE_MIN_CHARS}–${SEO_TITLE_MAX_CHARS}): ${quote(facts.title)}`,
      ),
    );
  }
  if (
    (SEO_BOILERPLATE_TITLES as readonly string[]).includes(
      facts.title.toLowerCase(),
    )
  ) {
    out.push(
      violation(
        "seo.title.boilerplate",
        facts,
        `Title says nothing about the page: ${quote(facts.title)}`,
      ),
    );
  }
  return out;
}

function evaluateDescription(facts: SeoPageFacts): SeoViolation[] {
  if (facts.metaDescription === null) {
    return [
      violation(
        "seo.meta-description.missing",
        facts,
        'No <meta name="description">, or its content is empty.',
      ),
    ];
  }
  const length = facts.metaDescription.length;
  if (
    length < SEO_DESCRIPTION_MIN_CHARS ||
    length > SEO_DESCRIPTION_MAX_CHARS
  ) {
    return [
      violation(
        "seo.meta-description.length",
        facts,
        `Meta description is ${length} characters (aim for ${SEO_DESCRIPTION_MIN_CHARS}–${SEO_DESCRIPTION_MAX_CHARS}): ${quote(facts.metaDescription)}`,
      ),
    ];
  }
  return [];
}

function evaluateHeadings(facts: SeoPageFacts): SeoViolation[] {
  const out: SeoViolation[] = [];
  // A truncated snapshot may have lost the H1, so absence is not claimed.
  if (facts.h1WithTextCount === 0 && !facts.htmlTruncated) {
    out.push(
      violation(
        "seo.h1.missing",
        facts,
        facts.h1Count > 0
          ? `Found ${facts.h1Count} <h1> element(s), but none contains text.`
          : "No <h1> heading on the page.",
      ),
    );
  }
  if (facts.h1Count > 1) {
    out.push(
      violation(
        "seo.h1.multiple",
        facts,
        `Found ${facts.h1Count} <h1> elements.`,
      ),
    );
  }
  const jumps: string[] = [];
  for (let i = 1; i < facts.headingLevels.length; i += 1) {
    const prev = facts.headingLevels[i - 1]!;
    const curr = facts.headingLevels[i]!;
    if (curr.level > prev.level + 1) {
      jumps.push(`h${prev.level} → h${curr.level} at ${quote(curr.text)}`);
    }
  }
  if (jumps.length > 0) {
    out.push(
      violation(
        "seo.headings.skipped-level",
        facts,
        `${jumps.length} skipped heading level(s): ${jumps.slice(0, 3).join("; ")}`,
      ),
    );
  }
  return out;
}

/** The page's single valid canonical, normalized, or null. */
export function resolvedCanonical(facts: SeoPageFacts): string | null {
  const valid = facts.canonicalHrefs
    .map((href) => normalizeUrlForComparison(href))
    .filter((href): href is string => href !== null);
  const unique = [...new Set(valid)];
  return unique.length === 1 && valid.length === facts.canonicalHrefs.length
    ? unique[0]!
    : null;
}

function evaluateCanonical(facts: SeoPageFacts): SeoViolation[] {
  if (facts.canonicalHrefs.length === 0) {
    return [
      violation(
        "seo.canonical.missing",
        facts,
        'No <link rel="canonical"> on the page.',
      ),
    ];
  }
  const invalid = facts.canonicalHrefs.filter(
    (href) => asAbsoluteHttpUrl(href) === null,
  );
  const distinct = new Set(
    facts.canonicalHrefs.map((href) => normalizeUrlForComparison(href) ?? href),
  );
  if (invalid.length > 0) {
    return [
      violation(
        "seo.canonical.invalid",
        facts,
        `Canonical must be an absolute http(s) URL; found ${invalid.map((h) => quote(h)).join(", ")}`,
      ),
    ];
  }
  if (distinct.size > 1) {
    return [
      violation(
        "seo.canonical.invalid",
        facts,
        `${facts.canonicalHrefs.length} canonical tags point to different URLs: ${[...distinct].join(", ")}`,
      ),
    ];
  }
  const canonical = resolvedCanonical(facts);
  const self = normalizeUrlForComparison(facts.finalUrl);
  if (canonical !== null && self !== null && canonical !== self) {
    return [
      violation(
        "seo.canonical.cross-page",
        facts,
        `Canonical points to ${canonical}, not to this page (${self}); search engines may index that URL instead.`,
      ),
    ];
  }
  return [];
}

function evaluateIndexability(facts: SeoPageFacts): SeoViolation[] {
  const out: SeoViolation[] = [];
  const metaNoindex = facts.metaRobots.some(
    (d) => d === "noindex" || d === "none",
  );
  const headerNoindex = facts.xRobotsTag.some(
    (d) => d === "noindex" || d === "none",
  );
  const metaNofollow = facts.metaRobots.some(
    (d) => d === "nofollow" || d === "none",
  );
  const headerNofollow = facts.xRobotsTag.some(
    (d) => d === "nofollow" || d === "none",
  );

  const source = (inMeta: boolean, inHeader: boolean): string =>
    [
      inMeta ? '<meta name="robots">' : null,
      inHeader ? "X-Robots-Tag header" : null,
    ]
      .filter(Boolean)
      .join(" and ");

  if (metaNoindex || headerNoindex) {
    const evidence = metaNoindex ? "html" : "headers";
    out.push(
      violation(
        "seo.indexability.noindex",
        facts,
        `noindex set by ${source(metaNoindex, headerNoindex)}.`,
        { evidence },
      ),
    );
    if (facts.inSitemap) {
      out.push(
        violation(
          "seo.indexability.sitemap-conflict",
          facts,
          `Listed in the XML sitemap but marked noindex by ${source(metaNoindex, headerNoindex)}.`,
          { evidence },
        ),
      );
    }
  }
  if (metaNofollow || headerNofollow) {
    out.push(
      violation(
        "seo.indexability.nofollow",
        facts,
        `nofollow set by ${source(metaNofollow, headerNofollow)}.`,
        { evidence: metaNofollow ? "html" : "headers" },
      ),
    );
  }
  return out;
}

function evaluateLanguage(facts: SeoPageFacts): SeoViolation[] {
  const out: SeoViolation[] = [];
  if (facts.htmlLang === null) {
    out.push(
      violation("seo.lang.missing", facts, "<html> has no lang attribute."),
    );
  } else if (!HTML_LANG_PATTERN.test(facts.htmlLang)) {
    out.push(
      violation(
        "seo.lang.invalid",
        facts,
        `<html lang=${quote(facts.htmlLang)}> is not a valid language tag.`,
      ),
    );
  }
  const badHreflang = facts.hreflangs.filter(
    (h) => !HREFLANG_PATTERN.test(h.lang) || asAbsoluteHttpUrl(h.href) === null,
  );
  if (badHreflang.length > 0) {
    out.push(
      violation(
        "seo.hreflang.invalid",
        facts,
        `${badHreflang.length} invalid hreflang tag(s): ${badHreflang
          .slice(0, 3)
          .map((h) => `hreflang=${quote(h.lang)} href=${quote(h.href)}`)
          .join("; ")}`,
      ),
    );
  }
  return out;
}

function evaluateSocial(facts: SeoPageFacts): SeoViolation[] {
  const out: SeoViolation[] = [];
  const og = facts.openGraph;
  const missing = (
    [
      ["og:title", og.title],
      ["og:description", og.description],
      ["og:image", og.image],
      ["og:url", og.url],
    ] as const
  )
    .filter(([, value]) => value === null)
    .map(([key]) => key);
  if (missing.length > 0) {
    out.push(
      violation(
        "seo.open-graph.missing",
        facts,
        `Missing ${missing.join(", ")}.`,
        {
          // Without a title or image, shared links render as bare URLs.
          severity:
            missing.includes("og:title") || missing.includes("og:image")
              ? "medium"
              : "low",
        },
      ),
    );
  }
  if (og.image !== null && asAbsoluteHttpUrl(og.image) === null) {
    out.push(
      violation(
        "seo.open-graph.invalid-image",
        facts,
        `og:image must be an absolute http(s) URL; found ${quote(og.image)}.`,
      ),
    );
  }
  if (facts.twitterCard === null) {
    out.push(
      violation(
        "seo.twitter-card.missing",
        facts,
        'No <meta name="twitter:card">.',
      ),
    );
  }
  return out;
}

function evaluateStructuredData(facts: SeoPageFacts): SeoViolation[] {
  const out: SeoViolation[] = [];
  const invalid = facts.jsonLd.filter((block) => !block.validJson);
  if (invalid.length > 0) {
    out.push(
      violation(
        "seo.structured-data.invalid-json",
        facts,
        `${invalid.length} JSON-LD block(s) failed to parse: ${invalid
          .slice(0, 2)
          .map((b) => `block ${b.index + 1}: ${b.parseError}`)
          .join("; ")}`,
      ),
    );
  }
  const incomplete = facts.jsonLd.filter(
    (block) =>
      block.validJson &&
      (!block.hasSchemaOrgContext || block.nodesMissingType > 0),
  );
  if (incomplete.length > 0) {
    out.push(
      violation(
        "seo.structured-data.missing-context-or-type",
        facts,
        incomplete
          .slice(0, 3)
          .map(
            (b) =>
              `block ${b.index + 1}: ${[
                b.hasSchemaOrgContext ? null : "no schema.org @context",
                b.nodesMissingType > 0
                  ? `${b.nodesMissingType} item(s) without @type`
                  : null,
              ]
                .filter(Boolean)
                .join(", ")}`,
          )
          .join("; "),
      ),
    );
  }
  return out;
}

function evaluateImages(facts: SeoPageFacts): SeoViolation[] {
  const count = facts.imagesMissingAlt.length;
  if (count === 0) return [];
  return [
    violation(
      "seo.images.missing-alt",
      facts,
      `${count} image(s) have no alt attribute: ${facts.imagesMissingAlt.slice(0, 5).join(", ")}`,
      { severity: count >= 5 ? "medium" : "low" },
    ),
  ];
}

/** Every per-page rule for one page. */
export function evaluateSeoPageRules(facts: SeoPageFacts): SeoViolation[] {
  return [
    ...evaluateTitle(facts),
    ...evaluateDescription(facts),
    ...evaluateHeadings(facts),
    ...evaluateCanonical(facts),
    ...evaluateIndexability(facts),
    ...evaluateLanguage(facts),
    ...evaluateSocial(facts),
    ...evaluateStructuredData(facts),
    ...evaluateImages(facts),
  ];
}

function duplicateViolations(
  ruleId: string,
  label: string,
  pages: readonly SeoPageFacts[],
  pick: (facts: SeoPageFacts) => string | null,
): SeoViolation[] {
  const groups = new Map<string, SeoPageFacts[]>();
  for (const facts of pages) {
    const text = pick(facts);
    if (text === null) continue;
    const key = text.toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), facts]);
  }
  const out: SeoViolation[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const urls = group.map((facts) => facts.pageUrl);
    for (const facts of group) {
      const text = pick(facts)!;
      out.push(
        violation(
          ruleId,
          facts,
          `Same ${label} on ${group.length} pages (${urls.join(", ")}): ${quote(text)}`,
          { context: { text, urls } },
        ),
      );
    }
  }
  return out;
}

function canonicalLoopViolations(
  pages: readonly SeoPageFacts[],
): SeoViolation[] {
  const byUrl = new Map<string, SeoPageFacts>();
  for (const facts of pages) {
    const self = normalizeUrlForComparison(facts.finalUrl);
    if (self) byUrl.set(self, facts);
  }
  const next = (facts: SeoPageFacts): SeoPageFacts | null => {
    const target = resolvedCanonical(facts);
    const self = normalizeUrlForComparison(facts.finalUrl);
    if (target === null || target === self) return null;
    return byUrl.get(target) ?? null;
  };

  const reported = new Set<string>();
  const out: SeoViolation[] = [];
  for (const start of pages) {
    const path: SeoPageFacts[] = [];
    let current: SeoPageFacts | null = start;
    while (current && !path.includes(current) && path.length <= pages.length) {
      path.push(current);
      current = next(current);
    }
    if (!current || !path.includes(current)) continue;
    const cycle = path.slice(path.indexOf(current));
    if (cycle.length < 2) continue;
    const chain = [...cycle, cycle[0]!].map((f) => f.pageUrl).join(" → ");
    for (const facts of cycle) {
      if (reported.has(facts.pageId)) continue;
      reported.add(facts.pageId);
      out.push(
        violation("seo.canonical.loop", facts, `Canonical loop: ${chain}`, {
          context: { loop: cycle.map((f) => f.pageUrl) },
        }),
      );
    }
  }
  return out;
}

function hreflangReturnViolations(
  pages: readonly SeoPageFacts[],
): SeoViolation[] {
  const byUrl = new Map<string, SeoPageFacts>();
  for (const facts of pages) {
    const self = normalizeUrlForComparison(facts.finalUrl);
    if (self) byUrl.set(self, facts);
  }
  const out: SeoViolation[] = [];
  for (const facts of pages) {
    const self = normalizeUrlForComparison(facts.finalUrl);
    if (!self) continue;
    const missingBack: string[] = [];
    for (const alt of facts.hreflangs) {
      const target = normalizeUrlForComparison(alt.href);
      if (!target || target === self) continue;
      const other = byUrl.get(target);
      if (!other) continue; // not scanned: cannot verify, so not claimed
      const linksBack = other.hreflangs.some(
        (h) => normalizeUrlForComparison(h.href) === self,
      );
      if (!linksBack) missingBack.push(`${alt.lang} → ${other.pageUrl}`);
    }
    if (missingBack.length > 0) {
      out.push(
        violation(
          "seo.hreflang.missing-return",
          facts,
          `${missingBack.length} alternate page(s) do not link back with hreflang: ${missingBack.slice(0, 3).join("; ")}`,
        ),
      );
    }
  }
  return out;
}

/** Rules that compare pages within one scan. */
export function evaluateSeoSiteRules(
  pages: readonly SeoPageFacts[],
): SeoViolation[] {
  return [
    ...duplicateViolations(
      "seo.title.duplicate",
      "title",
      pages,
      (f) => f.title,
    ),
    ...duplicateViolations(
      "seo.meta-description.duplicate",
      "meta description",
      pages,
      (f) => f.metaDescription,
    ),
    ...canonicalLoopViolations(pages),
    ...hreflangReturnViolations(pages),
  ];
}

// ---------------------------------------------------------------------------
// Finding candidates
// ---------------------------------------------------------------------------

export const SEO_PROVISIONAL_PRIORITY: Readonly<Record<SeoSeverity, number>> = {
  high: 70,
  medium: 45,
  low: 20,
};

const SEVERITY_RANK: Readonly<Record<SeoSeverity, number>> = {
  low: 0,
  medium: 1,
  high: 2,
};

export interface SeoFindingCandidate {
  ruleId: string;
  ruleVersion: string;
  category: "seo";
  severity: SeoSeverity;
  effort: SeoRule["effort"];
  impact: SeoRule["impact"];
  priorityScore: number;
  title: string;
  measured: {
    metric: string;
    value: number;
    unit: string;
    rawContext: Record<string, unknown>;
  };
  threshold: SeoRule["expectation"];
  fixRole: SeoRule["fixRole"];
  occurrences: SeoViolation[];
}

/** Groups violations into one finding per rule, ordered as in the catalog. */
export function buildSeoFindingCandidates(
  violations: readonly SeoViolation[],
): SeoFindingCandidate[] {
  const candidates: SeoFindingCandidate[] = [];
  for (const rule of SEO_RULES) {
    const occurrences = violations.filter((v) => v.ruleId === rule.ruleId);
    if (occurrences.length === 0) continue;
    const severity = occurrences.reduce<SeoSeverity>(
      (worst, v) =>
        SEVERITY_RANK[v.severity] > SEVERITY_RANK[worst] ? v.severity : worst,
      "low",
    );
    const contexts = occurrences
      .map((v) => v.context)
      .filter((c): c is Record<string, unknown> => c !== undefined);
    candidates.push({
      ruleId: rule.ruleId,
      ruleVersion: SEO_RULE_VERSION,
      category: "seo",
      severity,
      effort: rule.effort,
      impact: rule.impact,
      priorityScore: SEO_PROVISIONAL_PRIORITY[severity],
      title: rule.title,
      measured: {
        metric: rule.ruleId,
        value: new Set(occurrences.map((v) => v.pageId)).size,
        unit: "pages",
        rawContext: {
          affectedUrls: [...new Set(occurrences.map((v) => v.pageUrl))],
          ...(contexts.length > 0 ? { details: dedupeContexts(contexts) } : {}),
        },
      },
      threshold: rule.expectation,
      fixRole: rule.fixRole,
      occurrences,
    });
  }
  return candidates;
}

function dedupeContexts(
  contexts: Record<string, unknown>[],
): Record<string, unknown>[] {
  const seen = new Set<string>();
  return contexts.filter((context) => {
    const key = JSON.stringify(context);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Facts → per-page and site-wide violations → one candidate per fired rule. */
export function evaluateSeoRules(
  pages: readonly SeoPageFacts[],
): SeoFindingCandidate[] {
  return buildSeoFindingCandidates([
    ...pages.flatMap((facts) => evaluateSeoPageRules(facts)),
    ...evaluateSeoSiteRules(pages),
  ]);
}
