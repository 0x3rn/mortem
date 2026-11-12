import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  collectDocumentSecurity,
  type PlaywrightResponseLike,
} from "./browser-capture";
import {
  evaluateSecurityRules,
  parseMixedContentConsoleMessage,
  type MixedContentItem,
  type SecurityPageFacts,
} from "./security-checks";
import {
  createPreflightHttpsRedirectProbe,
  type HttpsRedirectProbeFn,
} from "./security-checks-runner";
import { findLocalChromium } from "./test-browser";

/**
 * Opt-in live check (THE-183): `SECURITY_LIVE=1 npx vitest run src/security-checks.live.test.ts`.
 * Loads real public pages in real Chromium (plain GETs, like a visitor) and
 * runs the production probe against their http:// address. Prints what fired
 * so the rules can be judged against real sites.
 */

const SITES = [
  "https://mortem.corstack.dev/",
  "https://morrow.corstack.dev/",
  "https://example.com/",
  "https://github.com/",
  "http://info.cern.ch/",
];

const chromiumPath = findLocalChromium();
const enabled = process.env.SECURITY_LIVE === "1" && Boolean(chromiumPath);

describe.skipIf(!enabled)("security checks on live sites", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({
      executablePath: chromiumPath!,
      headless: true,
    });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
  });

  for (const site of SITES) {
    it(`${site}`, async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      const consoleTexts: string[] = [];
      page.on("console", (m) => consoleTexts.push(m.text()));
      const response = await page.goto(site, {
        waitUntil: "load",
        timeout: 45_000,
      });
      const finalUrl = page.url();
      const security = await collectDocumentSecurity(
        response as unknown as PlaywrightResponseLike,
        finalUrl,
        [],
      );
      const headers = response ? await response.allHeaders() : {};
      await context.close();

      const mixed = consoleTexts
        .map(parseMixedContentConsoleMessage)
        .filter((m): m is MixedContentItem => m !== null);
      const facts: SecurityPageFacts = {
        pageId: "home",
        pageUrl: site,
        finalUrl,
        headers,
        security,
        mixedContent: mixed,
        evidence: { headers: "ev_headers", consoleLog: "ev_console" },
      };

      const probeFn: HttpsRedirectProbeFn = createPreflightHttpsRedirectProbe();
      const httpUrl = `http://${new URL(finalUrl).host}/`;
      let probe: Parameters<typeof evaluateSecurityRules>[0]["probe"] = null;
      if (finalUrl.startsWith("https://")) {
        try {
          const outcome = await probeFn(httpUrl);
          probe = {
            status: outcome.finalUrl.startsWith("https://")
              ? "redirects_to_https"
              : "serves_http",
            probedUrl: httpUrl,
            finalUrl: outcome.finalUrl,
            hops: outcome.redirectChain.length,
            reason: null,
            pageId: "home",
            pageUrl: site,
            evidenceArtifactId: "ev_probe",
          };
        } catch (err) {
          probe = {
            status: "unavailable",
            probedUrl: httpUrl,
            finalUrl: null,
            hops: 0,
            reason: err instanceof Error ? err.message : String(err),
            pageId: "home",
            pageUrl: site,
            evidenceArtifactId: "ev_probe",
          };
        }
      }

      const candidates = evaluateSecurityRules({
        pages: [facts],
        probe,
        nowMs: Date.now(),
      });
      console.log(
        JSON.stringify(
          {
            site,
            finalUrl,
            tls: security.tls,
            tlsUnavailableReason: security.tlsUnavailableReason,
            cookies: security.setCookies,
            probe: probe && {
              status: probe.status,
              hops: probe.hops,
              finalUrl: probe.finalUrl,
              reason: probe.reason,
            },
            fired: candidates.map((c) => ({
              rule: c.ruleId,
              severity: c.severity,
              excerpt: c.occurrences[0]?.excerpt,
            })),
          },
          null,
          2,
        ),
      );

      // Sanity: TLS details exist for HTTPS sites, never for plain HTTP.
      if (finalUrl.startsWith("https://")) {
        expect(security.tls?.protocol).toMatch(/^(TLS 1\.[23]|QUIC)$/);
        expect(typeof security.tls?.validTo).toBe("number");
      } else {
        expect(security.tls).toBeNull();
        expect(candidates.map((c) => c.ruleId)).toContain("sec.https.not-used");
      }
      expect(JSON.stringify(security.setCookies)).not.toMatch(/=/);
    }, 120_000);
  }
});
