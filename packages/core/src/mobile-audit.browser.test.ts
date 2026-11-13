import type { Browser, BrowserContext } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BROWSER_VIEWPORT_PROFILES,
  type PlaywrightPageLike,
} from "./browser-capture";
import { persistPageCaptureEvidenceToR2AndD1 } from "./evidence-storage";
import { runMobileAuditInPage } from "./mobile-audit";
import { runMobileChecks } from "./mobile-checks-runner";
import {
  buildCaptureResult,
  createInMemoryR2,
  createSqliteD1,
  seedScanWithPages,
} from "./test-support";
import { findLocalChromium, launchLocalChromium } from "./test-browser";

/** Every problem is planted on purpose. */
const BAD_PAGE = `<!doctype html><html lang="en"><head>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>Bad mobile page</title>
<style>
  body { margin: 0; font: 16px/1.4 sans-serif; }
  #wide { width: 700px; height: 40px; background: #ccc; }
  .icons a { display: inline-block; width: 16px; height: 16px; margin: 0 1px; background: #333; }
  #fine { font-size: 10px; }
  #cookie { position: fixed; left: 0; right: 0; bottom: 0; height: 400px; background: #fff; border-top: 1px solid #000; }
</style></head><body>
<h1>Shop</h1>
<div id="wide">A wide table that does not fit</div>
<nav class="icons"><a href="/a" aria-label="A"></a><a href="/b" aria-label="B"></a><a href="/c" aria-label="C"></a></nav>
<p id="fine">${"Tiny legal text that nobody can read on a phone. ".repeat(12)}</p>
<p>Short normal text.</p>
<div id="cookie">We use cookies. <button>Accept</button></div>
</body></html>`;

/** The same content, done properly. */
const GOOD_PAGE = `<!doctype html><html lang="en"><head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Good mobile page</title>
<style>
  body { margin: 0; padding: 16px; font: 16px/1.5 sans-serif; }
  .table-wrap { overflow-x: auto; }
  .table-wrap div { width: 700px; }
  nav a { display: inline-block; min-width: 48px; min-height: 48px; margin-right: 8px; }
  header { position: sticky; top: 0; height: 56px; background: #fff; }
  .cookie { position: fixed; left: 0; right: 0; bottom: 0; height: 80px; background: #fff; }
</style></head><body>
<header><a href="/">Home</a></header>
<h1>Shop</h1>
<div class="table-wrap"><div>A wide table that scrolls inside its own box</div></div>
<nav><a href="/a">Shoes</a><a href="/b">Bags</a></nav>
<p>Readable text with an <a href="/inline">inline link</a> inside a sentence, which is exempt.</p>
<label><input type="checkbox"> Remember me</label>
<div class="cookie">We use cookies. <button style="min-height:44px">OK</button></div>
</body></html>`;

const chromiumPath = findLocalChromium();
if (!chromiumPath) {
  console.warn(
    "[mobile-audit.browser.test] No local Chromium found; skipped. Run `npx playwright install chromium`.",
  );
}

describe.skipIf(!chromiumPath)(
  "runMobileAuditInPage in real Chromium (390×844)",
  () => {
    let browser: Browser;
    let context: BrowserContext;
    beforeAll(async () => {
      browser = await launchLocalChromium(chromiumPath!);
      const profile = BROWSER_VIEWPORT_PROFILES.mobile;
      context = await browser.newContext({
        viewport: profile.viewport,
        deviceScaleFactor: profile.deviceScaleFactor,
        isMobile: profile.isMobile,
        hasTouch: profile.hasTouch,
      });
    }, 60_000);
    afterAll(async () => {
      await browser?.close();
    }, 30_000);

    async function audit(html: string) {
      const page = await context.newPage();
      await page.setContent(html);
      const result = await runMobileAuditInPage({
        page: page as unknown as PlaywrightPageLike,
        pageUrl: "https://shop.example.test/",
        now: Date.now,
      });
      await page.close();
      return result;
    }

    it("flags every planted problem with selectors, boxes and crops", async () => {
      const result = await audit(BAD_PAGE);
      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      const m = result.measurements;

      expect(m.viewport).toEqual({ width: 390, height: 844 });
      expect(m.viewportMeta.content).toContain("user-scalable=no");

      expect(m.documentWidth).toBeGreaterThanOrEqual(700);
      expect(m.overflowingElements.map((e) => e.selector)).toEqual(["#wide"]);
      expect(m.overflowingElements[0]).toMatchObject({ x: 0, width: 700 });

      expect(m.tapTargets.tooSmall.map((t) => t.label)).toEqual([
        "A",
        "B",
        "C",
      ]);
      expect(m.tapTargets.tooSmall[0]).toMatchObject({ width: 16, height: 16 });

      expect(m.text.smallElements[0]).toMatchObject({
        selector: "#fine",
        fontSizePx: 10,
      });
      expect(m.text.smallChars).toBeGreaterThan(500);
      expect(m.text.smallChars / m.text.totalChars).toBeGreaterThan(0.4);

      expect(m.overlays).toHaveLength(1);
      expect(m.overlays[0]).toMatchObject({
        selector: "#cookie",
        position: "fixed",
      });
      expect(m.overlays[0]!.coverage).toBeCloseTo(400 / 844, 2);

      // Crops: overlay first, then overflow, then the small targets.
      expect(result.elementCrops.map((c) => c.check).slice(0, 3)).toEqual([
        "overlay",
        "overflow",
        "tap-target-small",
      ]);
      const png = result.elementCrops[0]!.png;
      expect([...png.slice(0, 4)]).toEqual([137, 80, 78, 71]);
      expect(JSON.parse(result.artifactJson)).toMatchObject({
        format: "mortem-mobile/1",
        status: "ok",
      });
    }, 60_000);

    it("finds nothing on a clean responsive page", async () => {
      const result = await audit(GOOD_PAGE);
      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      const m = result.measurements;
      expect(m.viewportMeta.content).toBe(
        "width=device-width, initial-scale=1",
      );
      expect(m.documentWidth).toBe(390);
      expect(m.overflowingElements).toEqual([]);
      expect(m.tapTargets.tooSmall).toEqual([]);
      expect(m.tapTargets.crowded).toEqual([]);
      expect(m.text.smallChars).toBe(0);
      expect(m.overlays).toEqual([]);
      expect(m.tapTargets.checked).toBeGreaterThanOrEqual(4);
    }, 60_000);

    it("measures the page as a phone renders it without a viewport tag (980 px layout)", async () => {
      const result = await audit(
        "<!doctype html><html><head><title>Old site</title></head><body><p>Desktop-only page</p></body></html>",
      );
      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(result.measurements.viewportMeta).toEqual({
        count: 0,
        content: null,
      });
      expect(result.measurements.viewport.width).toBe(980);
    }, 60_000);

    it("overflow: reports only the outermost element that really widens the page", async () => {
      const result = await audit(`<!doctype html><html><head>
      <meta name="viewport" content="width=device-width, initial-scale=1"><title>t</title></head>
      <body style="margin:0">
        <div id="wide" style="width:700px;height:30px"><span style="display:block;width:800px">inner</span></div>
        <div style="overflow-x:auto"><div style="width:900px">scrolls inside its own box</div></div>
        <nav style="position:fixed;top:0;left:300px;width:400px;height:40px;background:#eee">off-canvas menu</nav>
      </body></html>`);
      if (result.status !== "ok") throw new Error(result.message);
      expect(
        result.measurements.overflowingElements.map((e) => e.selector),
      ).toEqual(["#wide"]);
    }, 60_000);

    it("overflow: nothing when <html> hides it; body-only hiding still overflows on a phone", async () => {
      const result =
        await audit(`<!doctype html><html style="overflow-x:hidden"><head>
      <meta name="viewport" content="width=device-width, initial-scale=1"><title>t</title></head>
      <body style="margin:0;overflow-x:hidden"><div style="width:600px">clipped by the page</div></body></html>`);
      if (result.status !== "ok") throw new Error(result.message);
      expect(result.measurements.documentWidth).toBe(390);
      expect(result.measurements.overflowingElements).toEqual([]);

      // overflow-x:hidden on <body> only: Chrome on a phone still lays the page
      // out wider (measured: scrollWidth 600, innerWidth grows to 600), so it is reported.
      const bodyOnly = await audit(`<!doctype html><html><head>
      <meta name="viewport" content="width=device-width, initial-scale=1"><title>t</title></head>
      <body style="margin:0;overflow-x:hidden"><div id="wide2" style="width:600px">wider than the phone</div></body></html>`);
      if (bodyOnly.status !== "ok") throw new Error(bodyOnly.message);
      expect(bodyOnly.measurements.documentWidth).toBe(600);
      expect(bodyOnly.measurements.viewport.width).toBe(390);
      expect(
        bodyOnly.measurements.overflowingElements.map((e) => e.selector),
      ).toEqual(["#wide2"]);
    }, 60_000);

    it("tap targets: exempts links inside a sentence and labelled checkboxes, flags crowded buttons", async () => {
      const result = await audit(`<!doctype html><html><head>
      <meta name="viewport" content="width=device-width, initial-scale=1"><title>t</title></head>
      <body style="margin:0;padding:20px;font:16px sans-serif">
        <p>Results on pages <a href="/1">1</a> <a href="/2">2</a> <a href="/3">3</a> of this list.</p>
        <label><input type="checkbox"> Email me</label><br><label><input type="checkbox"> Text me</label>
        <div style="margin-top:40px"><button style="width:40px;height:30px;margin:0">X</button><button style="width:40px;height:30px;margin:0 0 0 2px">Y</button></div>
      </body></html>`);
      if (result.status !== "ok") throw new Error(result.message);
      expect(result.measurements.tapTargets.tooSmall).toEqual([]);
      expect(
        result.measurements.tapTargets.crowded.map((t) => [t.label, t.gapPx]),
      ).toEqual([
        ["X", 2],
        ["Y", 2],
      ]);
    }, 60_000);

    it("tap targets: counts the real tap area (::before hit areas, stretched card links)", async () => {
      const result = await audit(`<!doctype html><html><head>
      <meta name="viewport" content="width=device-width, initial-scale=1"><title>t</title>
      <style>
        body { margin: 0; padding: 20px; font: 16px sans-serif; }
        .dots button { position: relative; width: 8px; height: 8px; padding: 0; border: 0; margin: 0 12px; background: #333; }
        .dots button::before { content: ""; position: absolute; inset: -14px; }
        .card { position: relative; border: 1px solid #ccc; padding: 16px; margin-top: 40px; width: 300px; }
        .card a { font-size: 12px; }
        .card a::after { content: ""; position: absolute; inset: 0; }
        .tiny a { display: inline-block; width: 8px; height: 8px; margin: 0 1px; background: #333; }
        .pair { display: flex; align-items: center; gap: 2px; margin-top: 40px; }
        .icon { position: relative; width: 16px; height: 16px; padding: 0; border: 0; background: #333; }
        .icon::before { content: ""; position: absolute; inset: -12px; }
        .fine { font-size: 10px; }
      </style></head><body>
      <p class="fine" id="fine-top">Small print at the top of a long page.</p>
      <div class="dots"><button aria-label="Slide 1"></button><button aria-label="Slide 2"></button><button aria-label="Slide 3"></button></div>
      <div class="card"><h2>Product</h2><a href="/p">More</a></div>
      <div class="pair"><button class="icon" aria-label="Icon"></button><button style="width:100px;height:48px">Buy</button></div>
      <div style="height:2500px"></div>
      <div class="tiny"><a href="/x" aria-label="X"></a><a href="/y" aria-label="Y"></a></div>
    </body></html>`);
      if (result.status !== "ok") throw new Error(result.message);
      const small = result.measurements.tapTargets.tooSmall;
      // Dots with a 36x36 ::before, the stretched card link and the 16 px icon
      // whose ::before gives it a ~30x40 area pass; bare 8 px dots do not.
      expect(small.map((t) => t.label)).toEqual(["X", "Y"]);
      expect(small[0]).toMatchObject({
        width: 8,
        height: 8,
        hitWidth: 8,
        hitHeight: 8,
      });
      // The icon's box alone (16x16, 2 px from "Buy") would be too small; its
      // real tap area is not, so it is only crowded, with the measured size.
      const icon = result.measurements.tapTargets.crowded.find(
        (t) => t.label === "Icon",
      );
      expect(icon).toMatchObject({ width: 16, height: 16, gapPx: 2 });
      expect(icon!.hitWidth!).toBeGreaterThanOrEqual(24);
      expect(icon!.hitHeight!).toBeGreaterThanOrEqual(24);
      // Probing scrolled down to the far dots; boxes measured afterwards must
      // still be in document coordinates (the page is scrolled back first).
      const fine = result.measurements.text.smallElements.find(
        (e) => e.selector === "#fine-top",
      );
      expect(fine!.y).toBeGreaterThanOrEqual(0);
      expect(fine!.y).toBeLessThan(100);
    }, 60_000);

    it("overlays: ignores thin side bars and the page's own fixed layout shell", async () => {
      const text = "Real page content that people came to read. ".repeat(40);
      const result = await audit(`<!doctype html><html><head>
      <meta name="viewport" content="width=device-width, initial-scale=1"><title>t</title></head>
      <body style="margin:0">
        <aside style="position:fixed;top:0;left:0;width:100px;height:100vh;background:#eee">side</aside>
        <div style="position:fixed;inset:0;overflow:auto;margin-left:100px"><main><p>${text}</p></main></div>
      </body></html>`);
      if (result.status !== "ok") throw new Error(result.message);
      expect(result.measurements.overlays).toEqual([]);
    }, 60_000);

    it("end to end: real audit → production evidence writer → rules → findings citing element crops", async () => {
      const d1 = createSqliteD1();
      const r2 = createInMemoryR2();
      await seedScanWithPages(d1, {
        scanId: "scan_mobile_e2e",
        origin: "https://shop.example.test",
        pages: [
          { id: "p_bad", url: "https://shop.example.test/" },
          { id: "p_good", url: "https://shop.example.test/good" },
        ],
      });
      for (const [pageId, html] of [
        ["p_bad", BAD_PAGE],
        ["p_good", GOOD_PAGE],
      ] as const) {
        const mobileLayout = await audit(html);
        await persistPageCaptureEvidenceToR2AndD1({
          d1,
          r2,
          scanId: "scan_mobile_e2e",
          pageId,
          capture: buildCaptureResult({
            url: "https://shop.example.test/",
            html,
            mobileLayout,
          }),
          nowMs: 1,
        });
      }
      const summary = await runMobileChecks({
        d1,
        r2,
        scanId: "scan_mobile_e2e",
        nowMs: 2,
      });
      expect(summary.pagesChecked).toBe(2);
      expect(summary.rulesFired).toEqual([
        "mobile.viewport.zoom-disabled",
        "mobile.overflow.horizontal",
        "mobile.tap-target.too-small",
        "mobile.text.too-small",
        "mobile.overlay.intrusive",
      ]);
      const rows = d1.sqlite
        .prepare(
          `SELECT f.check_id, o.page_id, o.selector, e.kind FROM findings f
         JOIN finding_occurrences o ON o.finding_id = f.id
         JOIN evidence_artifacts e ON e.id = o.evidence_artifact_id
         WHERE f.scan_id = ? ORDER BY f.check_id, o.selector`,
        )
        .all("scan_mobile_e2e") as Array<{
        check_id: string;
        page_id: string;
        selector: string | null;
        kind: string;
      }>;
      // Nothing on the clean page.
      expect(rows.every((r) => r.page_id === "p_bad")).toBe(true);
      // Elements that were cropped cite their crop.
      expect(
        rows.find((r) => r.check_id === "mobile.overlay.intrusive"),
      ).toMatchObject({
        selector: "#cookie",
        kind: "screenshot_element",
      });
      expect(
        rows.find((r) => r.check_id === "mobile.overflow.horizontal"),
      ).toMatchObject({
        selector: "#wide",
        kind: "screenshot_element",
      });
      expect(
        rows.filter((r) => r.check_id === "mobile.tap-target.too-small"),
      ).toHaveLength(3);
    }, 60_000);

    it("returns an error result instead of throwing when the page cannot be audited", async () => {
      const page = {
        evaluate: async () => {
          throw new Error("Execution context was destroyed");
        },
      } as unknown as PlaywrightPageLike;
      const result = await runMobileAuditInPage({
        page,
        pageUrl: "x",
        now: Date.now,
      });
      expect(result).toMatchObject({
        status: "error",
        message: expect.stringContaining("Execution context was destroyed"),
      });
      const timedOut = await runMobileAuditInPage({
        page: {
          evaluate: () => new Promise(() => undefined),
        } as unknown as PlaywrightPageLike,
        pageUrl: "x",
        now: Date.now,
        timeoutMs: 50,
      });
      expect(timedOut.status).toBe("timeout");
    });
  },
);
