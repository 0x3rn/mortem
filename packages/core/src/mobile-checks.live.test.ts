import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BROWSER_VIEWPORT_PROFILES,
  type PlaywrightPageLike,
} from "./browser-capture";
import { runMobileAuditInPage } from "./mobile-audit";
import { evaluateMobilePageRules } from "./mobile-checks";
import { findLocalChromium } from "./test-browser";

/**
 * Opt-in live check (THE-184): `MOBILE_LIVE=1 npx vitest run src/mobile-checks.live.test.ts`.
 * Loads real public pages in real Chromium with the production mobile profile
 * (plain GETs, like a visitor) and prints what fired, to judge the rules
 * against real sites.
 */

const SITES = [
  "https://mortem.corstack.dev/",
  "https://morrow.corstack.dev/",
  "https://example.com/",
  "http://info.cern.ch/",
  "https://github.com/",
  "https://www.bbc.com/news",
];

const chromiumPath = findLocalChromium();
const enabled = process.env.MOBILE_LIVE === "1" && Boolean(chromiumPath);

describe.skipIf(!enabled)("mobile checks on live sites", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({
      executablePath: chromiumPath!,
      headless: true,
    });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
  }, 30_000);

  for (const site of SITES) {
    it(
      site,
      async () => {
        const profile = BROWSER_VIEWPORT_PROFILES.mobile;
        const context = await browser.newContext({
          viewport: profile.viewport,
          deviceScaleFactor: profile.deviceScaleFactor,
          isMobile: profile.isMobile,
          hasTouch: profile.hasTouch,
        });
        const page = await context.newPage();
        await page.goto(site, { waitUntil: "load", timeout: 45_000 });
        await page.waitForTimeout(1500);
        const result = await runMobileAuditInPage({
          page: page as unknown as PlaywrightPageLike,
          pageUrl: site,
          now: Date.now,
        });
        await context.close();
        expect(result.status).toBe("ok");
        if (result.status !== "ok") return;
        const m = result.measurements;
        const violations = evaluateMobilePageRules({
          pageId: "home",
          pageUrl: site,
          measurements: m,
          evidence: { raw: "ev_raw", screenshot: "ev_shot", crops: [] },
        });
        console.log(
          JSON.stringify(
            {
              site,
              viewport: m.viewport,
              meta: m.viewportMeta.content,
              documentWidth: m.documentWidth,
              tapTargets: m.tapTargets.checked,
              smallShare: m.text.totalChars
                ? Math.round((m.text.smallChars / m.text.totalChars) * 100) /
                  100
                : 0,
              crops: result.elementCrops.length,
              durationMs: result.durationMs,
              fired: violations.map(
                (v) => `${v.ruleId} :: ${v.excerpt.slice(0, 110)}`,
              ),
            },
            null,
            2,
          ),
        );
      },
      120_000,
    );
  }
});
