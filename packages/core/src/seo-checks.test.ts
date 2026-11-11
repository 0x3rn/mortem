import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SEO_DESCRIPTION_MAX_CHARS,
  SEO_DESCRIPTION_MIN_CHARS,
  SEO_RULES,
  SEO_RULE_IDS,
  SEO_TITLE_MAX_CHARS,
  SEO_TITLE_MIN_CHARS,
  evaluateSeoPageRules,
  evaluateSeoRules,
  evaluateSeoSiteRules,
  extractSeoFacts,
  normalizeUrlForComparison,
  type SeoPageFacts,
  type SeoPageInput,
} from "./seo-checks";

/**
 * Every rule has a passing case (the healthy page below triggers nothing) and a
 * failing case that changes exactly one thing and expects exactly that rule.
 */
const HEALTHY_HEAD = `
<title>Acme Analytics — Product analytics for small teams</title>
<meta name="description" content="Acme Analytics shows small teams which features customers use, where they drop off, and what to fix next.">
<link rel="canonical" href="https://acme.test/">
<meta property="og:title" content="Acme Analytics">
<meta property="og:description" content="Product analytics for small teams.">
<meta property="og:image" content="https://acme.test/og.png">
<meta property="og:url" content="https://acme.test/">
<meta name="twitter:card" content="summary_large_image">
<link rel="alternate" hreflang="en" href="https://acme.test/">
<link rel="alternate" hreflang="x-default" href="https://acme.test/">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Acme"}</script>`;

const HEALTHY_BODY = `
<h1>Product analytics</h1>
<h2>Features</h2><h3>Funnels</h3><h3>Retention</h3>
<h2>Pricing</h2>
<img src="/hero.png" alt="Dashboard screenshot">
<img src="/divider.png" alt="">
<img src="/pixel.gif" width="1" height="1">
<img src="/icon.svg" aria-hidden="true">
<img src="/decor.svg" role="presentation">`;

function html(
  head = HEALTHY_HEAD,
  body = HEALTHY_BODY,
  htmlAttrs = ' lang="en"',
): string {
  return `<!doctype html><html${htmlAttrs}><head>${head}</head><body>${body}</body></html>`;
}

function facts(overrides: Partial<SeoPageInput> = {}): SeoPageFacts {
  return extractSeoFacts({
    pageId: "page_home",
    pageUrl: "https://acme.test/",
    finalUrl: "https://acme.test/",
    html: html(),
    headers: { "content-type": "text/html" },
    inSitemap: false,
    htmlTruncated: false,
    ...overrides,
  });
}

function firedRules(overrides: Partial<SeoPageInput> = {}): string[] {
  return evaluateSeoPageRules(facts(overrides))
    .map((v) => v.ruleId)
    .sort();
}

const headWith = (from: string, to: string): string =>
  HEALTHY_HEAD.replace(from, to);
const bodyWith = (from: string, to: string): string =>
  HEALTHY_BODY.replace(from, to);

describe("extractSeoFacts", () => {
  it("reads every SEO fact from a healthy page", () => {
    const f = facts();
    expect(f.title).toBe("Acme Analytics — Product analytics for small teams");
    expect(f.metaDescription).toMatch(/^Acme Analytics shows small teams/);
    expect(f.h1Count).toBe(1);
    expect(f.headingLevels.map((h) => h.level)).toEqual([1, 2, 3, 3, 2]);
    expect(f.canonicalHrefs).toEqual(["https://acme.test/"]);
    expect(f.htmlLang).toBe("en");
    expect(f.hreflangs).toHaveLength(2);
    expect(f.openGraph.image).toBe("https://acme.test/og.png");
    expect(f.twitterCard).toBe("summary_large_image");
    expect(f.jsonLd).toEqual([
      {
        index: 0,
        validJson: true,
        parseError: null,
        hasSchemaOrgContext: true,
        nodesMissingType: 0,
        types: ["Organization"],
      },
    ]);
    // alt="" (decorative), 1x1 pixels, aria-hidden and role=presentation are not flagged.
    expect(f.imagesMissingAlt).toEqual([]);
  });

  it("collapses whitespace and treats an empty title or description as absent", () => {
    const f = facts({
      html: html(
        `<title>
          Acme   Analytics
        </title><meta name="description" content="   ">`,
      ),
    });
    expect(f.title).toBe("Acme Analytics");
    expect(f.metaDescription).toBeNull();
  });

  it("reads meta names case-insensitively", () => {
    const f = facts({
      html: html(headWith('name="description"', 'NAME="Description"')),
    });
    expect(f.metaDescription).not.toBeNull();
  });

  it("parses X-Robots-Tag for all crawlers and Googlebot, ignoring other crawlers", () => {
    expect(
      facts({ headers: { "X-Robots-Tag": "noindex, nofollow" } }).xRobotsTag,
    ).toEqual(["noindex", "nofollow"]);
    expect(
      facts({ headers: { "x-robots-tag": "googlebot: noindex" } }).xRobotsTag,
    ).toEqual(["noindex"]);
    expect(
      facts({ headers: { "x-robots-tag": "otherbot: noindex" } }).xRobotsTag,
    ).toEqual([]);
    expect(
      facts({ headers: { "x-robots-tag": "max-snippet:-1, noarchive" } })
        .xRobotsTag,
    ).toEqual(["max-snippet:-1", "noarchive"]);
  });

  it("handles JSON-LD arrays and @graph", () => {
    const f = facts({
      html: html(
        headWith(
          `{"@context":"https://schema.org","@type":"Organization","name":"Acme"}`,
          `{"@context":"https://schema.org","@graph":[{"@type":"WebSite"},{"@type":["Organization","Brand"]}]}`,
        ),
      ),
    });
    expect(f.jsonLd[0]).toMatchObject({
      validJson: true,
      hasSchemaOrgContext: true,
      nodesMissingType: 0,
      types: ["WebSite", "Organization", "Brand"],
    });
  });

  it("does not throw on empty or malformed HTML", () => {
    for (const bad of ["", "<<<>>>", "<html><head><title>x", "\u0000\u0001"]) {
      expect(() => facts({ html: bad })).not.toThrow();
    }
    const empty = facts({ html: "" });
    expect(empty.title).toBeNull();
    expect(empty.h1Count).toBe(0);
  });
});

describe("per-page rules: the healthy page passes every rule", () => {
  it("fires nothing for the healthy fixture", () => {
    expect(firedRules()).toEqual([]);
  });
});

describe("per-page rules: each failing fixture fires exactly its rule", () => {
  const cases: Array<{ rule: string; input: Partial<SeoPageInput> }> = [
    {
      rule: "seo.title.missing",
      input: {
        html: html(
          headWith(
            "<title>Acme Analytics — Product analytics for small teams</title>",
            "",
          ),
        ),
      },
    },
    {
      rule: "seo.title.length",
      input: {
        html: html(
          headWith(
            "Acme Analytics — Product analytics for small teams</title>",
            "Acme Analytics — Product analytics for small teams, startups, agencies and enterprises</title>",
          ),
        ),
      },
    },
    {
      rule: "seo.meta-description.missing",
      input: { html: html(headWith('name="description"', 'name="keywords"')) },
    },
    {
      rule: "seo.meta-description.length",
      input: {
        html: html(
          headWith(
            "Acme Analytics shows small teams which features customers use, where they drop off, and what to fix next.",
            "Analytics.",
          ),
        ),
      },
    },
    {
      rule: "seo.h1.missing",
      input: {
        html: html(HEALTHY_HEAD, bodyWith("<h1>Product analytics</h1>", "")),
      },
    },
    {
      rule: "seo.h1.multiple",
      input: {
        html: html(
          HEALTHY_HEAD,
          bodyWith("<h2>Pricing</h2>", "<h1>Pricing</h1>"),
        ),
      },
    },
    {
      rule: "seo.headings.skipped-level",
      input: {
        html: html(
          HEALTHY_HEAD,
          bodyWith(
            "<h2>Features</h2><h3>Funnels</h3>",
            "<h2>Features</h2><h4>Funnels</h4>",
          ),
        ),
      },
    },
    {
      rule: "seo.canonical.missing",
      input: {
        html: html(
          headWith('<link rel="canonical" href="https://acme.test/">', ""),
        ),
      },
    },
    {
      rule: "seo.canonical.invalid",
      input: {
        html: html(
          headWith(
            'href="https://acme.test/">\n<meta property',
            'href="/">\n<meta property',
          ),
        ),
      },
    },
    {
      rule: "seo.canonical.cross-page",
      input: {
        html: html(
          headWith(
            '<link rel="canonical" href="https://acme.test/">',
            '<link rel="canonical" href="https://acme.test/pricing">',
          ),
        ),
      },
    },
    {
      rule: "seo.indexability.noindex",
      input: {
        html: html(`${HEALTHY_HEAD}<meta name="robots" content="noindex">`),
      },
    },
    {
      rule: "seo.indexability.nofollow",
      input: {
        html: html(`${HEALTHY_HEAD}<meta name="robots" content="nofollow">`),
      },
    },
    {
      rule: "seo.lang.missing",
      input: { html: html(HEALTHY_HEAD, HEALTHY_BODY, "") },
    },
    {
      rule: "seo.lang.invalid",
      input: {
        html: html(HEALTHY_HEAD, HEALTHY_BODY, ' lang="english language"'),
      },
    },
    {
      rule: "seo.hreflang.invalid",
      input: {
        html: html(
          headWith(
            'hreflang="en" href="https://acme.test/"',
            'hreflang="english" href="https://acme.test/"',
          ),
        ),
      },
    },
    {
      rule: "seo.open-graph.missing",
      input: {
        html: html(
          headWith('<meta property="og:url" content="https://acme.test/">', ""),
        ),
      },
    },
    {
      rule: "seo.open-graph.invalid-image",
      input: {
        html: html(
          headWith('content="https://acme.test/og.png"', 'content="/og.png"'),
        ),
      },
    },
    {
      rule: "seo.twitter-card.missing",
      input: {
        html: html(
          headWith(
            '<meta name="twitter:card" content="summary_large_image">',
            "",
          ),
        ),
      },
    },
    {
      rule: "seo.structured-data.invalid-json",
      input: {
        html: html(headWith(`"name":"Acme"}`, `"name":"Acme",}`)),
      },
    },
    {
      rule: "seo.structured-data.missing-context-or-type",
      input: { html: html(headWith(`"@type":"Organization",`, "")) },
    },
    {
      rule: "seo.images.missing-alt",
      input: {
        html: html(
          HEALTHY_HEAD,
          bodyWith(
            '<img src="/hero.png" alt="Dashboard screenshot">',
            '<img src="/hero.png">',
          ),
        ),
      },
    },
  ];

  it.each(cases)("$rule", ({ rule, input }) => {
    expect(firedRules(input)).toEqual([rule]);
  });

  it("seo.title.boilerplate fires (with the length rule) for a generic title", () => {
    expect(
      firedRules({
        html: html(
          headWith(
            "Acme Analytics — Product analytics for small teams",
            "Home",
          ),
        ),
      }),
    ).toEqual(["seo.title.boilerplate", "seo.title.length"]);
  });

  it("seo.indexability.sitemap-conflict fires only when a noindex page is in the sitemap", () => {
    const noindex = html(
      `${HEALTHY_HEAD}<meta name="robots" content="noindex">`,
    );
    expect(firedRules({ html: noindex, inSitemap: true })).toEqual([
      "seo.indexability.noindex",
      "seo.indexability.sitemap-conflict",
    ]);
    expect(firedRules({ inSitemap: true })).toEqual([]);
  });

  it("detects noindex from the X-Robots-Tag header and cites the headers evidence", () => {
    const violations = evaluateSeoPageRules(
      facts({ headers: { "X-Robots-Tag": "noindex" } }),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      ruleId: "seo.indexability.noindex",
      evidence: "headers",
    });
    expect(violations[0]!.excerpt).toContain("X-Robots-Tag");
  });

  it("treats robots 'none' as both noindex and nofollow", () => {
    expect(
      firedRules({
        html: html(`${HEALTHY_HEAD}<meta name="robots" content="none">`),
      }),
    ).toEqual(["seo.indexability.nofollow", "seo.indexability.noindex"]);
  });
});

describe("per-page rule boundaries and edge cases", () => {
  const titleOfLength = (n: number): string => "T".repeat(n);

  it("accepts titles of exactly 20 and 60 characters, rejects 19 and 61", () => {
    for (const [length, fires] of [
      [20, false],
      [60, false],
      [19, true],
      [61, true],
    ] as const) {
      const rules = firedRules({
        html: html(
          headWith(
            "Acme Analytics — Product analytics for small teams",
            titleOfLength(length),
          ),
        ),
      });
      expect(rules.includes("seo.title.length"), `length ${length}`).toBe(
        fires,
      );
    }
  });

  it("accepts descriptions of exactly 70 and 160 characters, rejects 69 and 161", () => {
    const original =
      "Acme Analytics shows small teams which features customers use, where they drop off, and what to fix next.";
    for (const [length, fires] of [
      [70, false],
      [160, false],
      [69, true],
      [161, true],
    ] as const) {
      const rules = firedRules({
        html: html(headWith(original, "d".repeat(length))),
      });
      expect(
        rules.includes("seo.meta-description.length"),
        `length ${length}`,
      ).toBe(fires);
    }
  });

  it("counts an H1 that contains only a logo image with alt text as a real H1", () => {
    expect(
      firedRules({
        html: html(
          HEALTHY_HEAD,
          bodyWith(
            "<h1>Product analytics</h1>",
            '<h1><img src="/logo.svg" alt="Acme"></h1>',
          ),
        ),
      }),
    ).toEqual([]);
  });

  it("does not claim a missing H1 when the HTML snapshot was truncated", () => {
    expect(
      firedRules({
        html: html(HEALTHY_HEAD, bodyWith("<h1>Product analytics</h1>", "")),
        htmlTruncated: true,
      }),
    ).toEqual([]);
  });

  it("treats trailing-slash and fragment differences as the same canonical URL", () => {
    expect(
      firedRules({
        pageUrl: "https://acme.test/pricing",
        finalUrl: "https://acme.test/pricing",
        html: html(
          headWith(
            '<link rel="canonical" href="https://acme.test/">',
            '<link rel="canonical" href="https://acme.test/pricing/#top">',
          ).replace(
            'content="https://acme.test/">',
            'content="https://acme.test/pricing">',
          ),
        ),
      }).filter((r) => r.startsWith("seo.canonical")),
    ).toEqual([]);
  });

  it("flags two canonical tags that disagree", () => {
    expect(
      firedRules({
        html: html(
          `${HEALTHY_HEAD}<link rel="canonical" href="https://acme.test/other">`,
        ),
      }),
    ).toEqual(["seo.canonical.invalid"]);
  });

  it("rates missing og:title or og:image medium and other gaps low", () => {
    const severity = (from: string) =>
      evaluateSeoPageRules(facts({ html: html(headWith(from, "")) })).find(
        (v) => v.ruleId === "seo.open-graph.missing",
      )!.severity;
    expect(
      severity('<meta property="og:image" content="https://acme.test/og.png">'),
    ).toBe("medium");
    expect(
      severity('<meta property="og:url" content="https://acme.test/">'),
    ).toBe("low");
  });

  it("rates five or more images without alt medium and lists their sources", () => {
    const body = `${HEALTHY_BODY}${Array.from({ length: 5 }, (_, i) => `<img src="/p${i}.jpg">`).join("")}`;
    const v = evaluateSeoPageRules(
      facts({ html: html(HEALTHY_HEAD, body) }),
    ).find((x) => x.ruleId === "seo.images.missing-alt")!;
    expect(v.severity).toBe("medium");
    expect(v.excerpt).toContain("/p0.jpg");
  });

  it("flags JSON-LD with a non-schema.org @context", () => {
    expect(
      firedRules({
        html: html(
          headWith(
            '"@context":"https://schema.org"',
            '"@context":"https://example.org/vocab"',
          ),
        ),
      }),
    ).toEqual(["seo.structured-data.missing-context-or-type"]);
  });
});

describe("site rules across a scan", () => {
  function pageFacts(
    id: string,
    url: string,
    head: string,
    body = HEALTHY_BODY,
  ): SeoPageFacts {
    return extractSeoFacts({
      pageId: id,
      pageUrl: url,
      finalUrl: url,
      html: html(head, body),
      headers: null,
      inSitemap: false,
      htmlTruncated: false,
    });
  }

  const uniqueHead = (path: string, title: string, description: string) =>
    HEALTHY_HEAD.replace(
      "Acme Analytics — Product analytics for small teams",
      title,
    )
      .replace(
        "Acme Analytics shows small teams which features customers use, where they drop off, and what to fix next.",
        description,
      )
      .replace(
        '<link rel="canonical" href="https://acme.test/">',
        `<link rel="canonical" href="https://acme.test${path}">`,
      )
      .replace(
        'content="https://acme.test/">',
        `content="https://acme.test${path}">`,
      )
      .replaceAll(
        'href="https://acme.test/"',
        `href="https://acme.test${path}"`,
      );

  const home = pageFacts("p_home", "https://acme.test/", HEALTHY_HEAD);
  const pricing = pageFacts(
    "p_pricing",
    "https://acme.test/pricing",
    uniqueHead(
      "/pricing",
      "Pricing — Acme Analytics plans for every team",
      "Compare Acme Analytics plans: free for small teams, with paid tiers for growing companies and agencies.",
    ),
  );

  it("passes when titles and descriptions are unique and canonicals are self-referencing", () => {
    expect(evaluateSeoSiteRules([home, pricing])).toEqual([]);
  });

  it("lists every affected URL and the exact text for duplicate titles and descriptions", () => {
    const copy = pageFacts(
      "p_about",
      "https://acme.test/about",
      uniqueHead("/about", "", "")
        .replace(
          "<title></title>",
          "<title>Acme Analytics — Product analytics for small teams</title>",
        )
        .replace(
          'content=""',
          'content="Acme Analytics shows small teams which features customers use, where they drop off, and what to fix next."',
        ),
    );
    const violations = evaluateSeoSiteRules([home, pricing, copy]);
    const titles = violations.filter((v) => v.ruleId === "seo.title.duplicate");
    expect(titles.map((v) => v.pageId).sort()).toEqual(["p_about", "p_home"]);
    for (const v of titles) {
      expect(v.excerpt).toContain(
        '"Acme Analytics — Product analytics for small teams"',
      );
      expect(v.excerpt).toContain("https://acme.test/");
      expect(v.excerpt).toContain("https://acme.test/about");
      expect(v.context).toEqual({
        text: "Acme Analytics — Product analytics for small teams",
        urls: ["https://acme.test/", "https://acme.test/about"],
      });
    }
    expect(
      violations
        .filter((v) => v.ruleId === "seo.meta-description.duplicate")
        .map((v) => v.pageId)
        .sort(),
    ).toEqual(["p_about", "p_home"]);
    // Pricing is unique, so it is not part of either group.
    expect(violations.some((v) => v.pageId === "p_pricing")).toBe(false);
  });

  it("compares duplicates case-insensitively but quotes each page's exact text", () => {
    const upper = pageFacts(
      "p_upper",
      "https://acme.test/upper",
      uniqueHead(
        "/upper",
        "ACME ANALYTICS — PRODUCT ANALYTICS FOR SMALL TEAMS",
        "Something entirely different about Acme Analytics plans and how teams use them every day.",
      ),
    );
    const titles = evaluateSeoSiteRules([home, upper]).filter(
      (v) => v.ruleId === "seo.title.duplicate",
    );
    expect(titles).toHaveLength(2);
    expect(titles.find((v) => v.pageId === "p_upper")!.excerpt).toContain(
      '"ACME ANALYTICS — PRODUCT ANALYTICS FOR SMALL TEAMS"',
    );
  });

  it("detects a canonical loop between scanned pages and reports every page in it", () => {
    const a = pageFacts(
      "p_a",
      "https://acme.test/a",
      uniqueHead(
        "/b",
        "Page A of the Acme Analytics website",
        "Description for page A of the Acme Analytics website, long enough to pass the length rule.",
      ),
    );
    const b = pageFacts(
      "p_b",
      "https://acme.test/b",
      uniqueHead(
        "/a",
        "Page B of the Acme Analytics website",
        "Description for page B of the Acme Analytics website, long enough to pass the length rule.",
      ),
    );
    const loops = evaluateSeoSiteRules([a, b]).filter(
      (v) => v.ruleId === "seo.canonical.loop",
    );
    expect(loops.map((v) => v.pageId).sort()).toEqual(["p_a", "p_b"]);
    expect(loops[0]!.excerpt).toMatch(
      /https:\/\/acme\.test\/a → https:\/\/acme\.test\/b → https:\/\/acme\.test\/a|https:\/\/acme\.test\/b → https:\/\/acme\.test\/a → https:\/\/acme\.test\/b/,
    );
  });

  it("does not call a one-way cross-page canonical a loop", () => {
    const a = pageFacts(
      "p_a",
      "https://acme.test/a",
      uniqueHead(
        "/",
        "Page A of the Acme Analytics website",
        "Description for page A of the Acme Analytics website, long enough to pass the length rule.",
      ),
    );
    expect(
      evaluateSeoSiteRules([home, a]).filter(
        (v) => v.ruleId === "seo.canonical.loop",
      ),
    ).toEqual([]);
  });

  it("flags hreflang alternates that do not link back, but only for scanned pages", () => {
    const en = pageFacts(
      "p_en",
      "https://acme.test/en",
      `${uniqueHead("/en", "Acme Analytics in English for small teams", "English version of Acme Analytics product analytics for small teams and growing companies.")}<link rel="alternate" hreflang="fr" href="https://acme.test/fr"><link rel="alternate" hreflang="de" href="https://acme.test/de">`,
    );
    const fr = pageFacts(
      "p_fr",
      "https://acme.test/fr",
      uniqueHead(
        "/fr",
        "Acme Analytics en français pour les équipes",
        "Version française d’Acme Analytics, l’analyse produit pour les petites équipes et entreprises.",
      ),
    );
    const v = evaluateSeoSiteRules([en, fr]).filter(
      (x) => x.ruleId === "seo.hreflang.missing-return",
    );
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ pageId: "p_en" });
    expect(v[0]!.excerpt).toContain("fr → https://acme.test/fr");
    // /de was not scanned, so it is not claimed.
    expect(v[0]!.excerpt).not.toContain("/de");

    const frBack = pageFacts(
      "p_fr",
      "https://acme.test/fr",
      `${uniqueHead("/fr", "Acme Analytics en français pour les équipes", "Version française d’Acme Analytics, l’analyse produit pour les petites équipes et entreprises.")}<link rel="alternate" hreflang="en" href="https://acme.test/en">`,
    );
    expect(
      evaluateSeoSiteRules([en, frBack]).filter(
        (x) => x.ruleId === "seo.hreflang.missing-return",
      ),
    ).toEqual([]);
  });
});

describe("evaluateSeoRules finding candidates", () => {
  it("groups violations into one finding per rule with page counts and affected URLs", () => {
    const noTitle = (id: string, url: string) =>
      extractSeoFacts({
        pageId: id,
        pageUrl: url,
        finalUrl: url,
        html: html(
          headWith(
            "<title>Acme Analytics — Product analytics for small teams</title>",
            "",
          ),
        ),
        headers: null,
        inSitemap: false,
        htmlTruncated: false,
      });
    const candidates = evaluateSeoRules([
      noTitle("p1", "https://acme.test/"),
      noTitle("p2", "https://acme.test/about"),
    ]);
    const missing = candidates.find((c) => c.ruleId === "seo.title.missing")!;
    expect(missing).toMatchObject({
      category: "seo",
      severity: "high",
      ruleVersion: "1.0.0",
      measured: { value: 2, unit: "pages" },
      threshold: { operator: "exists", target: true },
    });
    expect(missing.measured.rawContext.affectedUrls).toEqual([
      "https://acme.test/",
      "https://acme.test/about",
    ]);
    expect(missing.occurrences).toHaveLength(2);
  });

  it("returns nothing for a healthy single-page scan", () => {
    expect(evaluateSeoRules([facts()])).toEqual([]);
  });

  it("has unique, well-formed rule ids and a scope for each", () => {
    expect(new Set(SEO_RULE_IDS).size).toBe(SEO_RULE_IDS.length);
    for (const rule of SEO_RULES) {
      expect(rule.ruleId).toMatch(/^seo\.[a-z0-9-]+\.[a-z0-9-]+$/);
    }
    expect(
      SEO_RULES.filter((r) => r.scope === "site")
        .map((r) => r.ruleId)
        .sort(),
    ).toEqual([
      "seo.canonical.loop",
      "seo.hreflang.missing-return",
      "seo.meta-description.duplicate",
      "seo.title.duplicate",
    ]);
  });
});

describe("normalizeUrlForComparison", () => {
  it("drops fragments and non-root trailing slashes, rejects relative and non-http URLs", () => {
    expect(normalizeUrlForComparison("https://ACME.test/pricing/#plans")).toBe(
      "https://acme.test/pricing",
    );
    expect(normalizeUrlForComparison("https://acme.test")).toBe(
      "https://acme.test/",
    );
    expect(normalizeUrlForComparison("/pricing")).toBeNull();
    expect(normalizeUrlForComparison("javascript:alert(1)")).toBeNull();
  });
});

describe("SEO rule catalog documentation stays in sync with the code", () => {
  const doc = readFileSync(
    resolve(__dirname, "../../../docs/rule-catalog/seo.md"),
    "utf8",
  );

  it("documents every rule id", () => {
    for (const id of SEO_RULE_IDS) {
      expect(doc, `${id} missing from docs/rule-catalog/seo.md`).toContain(
        `\`${id}\``,
      );
    }
  });

  it("documents the length thresholds the code uses", () => {
    const titleRow = doc
      .split("\n")
      .find((l) => l.includes("`seo.title.length`"))!;
    expect(titleRow).toContain(`${SEO_TITLE_MIN_CHARS}`);
    expect(titleRow).toContain(`${SEO_TITLE_MAX_CHARS}`);
    const descriptionRow = doc
      .split("\n")
      .find((l) => l.includes("`seo.meta-description.length`"))!;
    expect(descriptionRow).toContain(`${SEO_DESCRIPTION_MIN_CHARS}`);
    expect(descriptionRow).toContain(`${SEO_DESCRIPTION_MAX_CHARS}`);
  });
});
