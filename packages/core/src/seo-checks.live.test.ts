import { describe, expect, it } from "vitest";
import {
  evaluateSeoPageRules,
  evaluateSeoSiteRules,
  extractSeoFacts,
  type SeoPageFacts,
} from "./seo-checks";

/**
 * Live smoke check of the SEO rules on real public pages (THE-181).
 * Skipped unless SEO_LIVE=1, so CI never depends on third-party sites.
 * Uses each site's server HTML (production uses the Browser Run rendered DOM),
 * which is enough to catch parser crashes and obvious false positives.
 *
 *   SEO_LIVE=1 npx vitest run src/seo-checks.live.test.ts
 */
const SITES = [
  "https://web.dev/",
  "https://www.cnn.com/",
  "https://info.cern.ch/",
  "https://example.com/",
  "https://developer.mozilla.org/en-US/",
  "https://www.bbc.com/news",
];

describe.skipIf(process.env.SEO_LIVE !== "1")(
  "SEO checks live (real pages)",
  () => {
    it("extracts facts and evaluates every rule on real-world HTML without crashing", async () => {
      const pages: SeoPageFacts[] = [];
      for (const url of SITES) {
        const response = await fetch(url, {
          headers: { "user-agent": "MortemBot/1.0 (+https://mortem.app/bot)" },
          redirect: "follow",
          signal: AbortSignal.timeout(30_000),
        });
        const html = await response.text();
        const headers = Object.fromEntries(response.headers.entries());
        const facts = extractSeoFacts({
          pageId: url,
          pageUrl: url,
          finalUrl: response.url || url,
          html,
          headers,
          inSitemap: false,
          htmlTruncated: false,
        });
        pages.push(facts);
        const fired = evaluateSeoPageRules(facts);
        console.info(
          JSON.stringify({
            url,
            status: response.status,
            bytes: html.length,
            title: facts.title,
            descriptionChars: facts.metaDescription?.length ?? null,
            h1: facts.h1WithTextCount,
            canonical: facts.canonicalHrefs,
            lang: facts.htmlLang,
            hreflangs: facts.hreflangs.length,
            jsonLd: facts.jsonLd.map((b) => ({
              valid: b.validJson,
              types: b.types.slice(0, 4),
            })),
            imagesMissingAlt: facts.imagesMissingAlt.length,
            robots: [...facts.metaRobots, ...facts.xRobotsTag],
            fired: fired.map((v) => `${v.ruleId}: ${v.excerpt.slice(0, 140)}`),
          }),
        );
        if (response.ok) {
          expect(facts.title, `${url} title`).not.toBeNull();
        }
      }
      expect(() => evaluateSeoSiteRules(pages)).not.toThrow();
    }, 300_000);
  },
);
