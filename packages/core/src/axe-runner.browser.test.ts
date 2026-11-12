import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AXE_RUN_TAGS,
  runAxeInPage,
  selectCropBoxes,
  type AxeBoundingBox,
} from "./axe-runner";
import type { PlaywrightPageLike } from "./browser-capture";
import { findLocalChromium, launchLocalChromium } from "./test-browser";

const AXE_SOURCE = readFileSync(
  resolve(__dirname, "../../../node_modules/axe-core/axe.min.js"),
  "utf8",
);

/** Known-bad page: each problem is planted on purpose. */
const BAD_PAGE = `<!doctype html><html><head><title>Bad page</title></head>
<body style="margin:0">
  <main>
    <h1>Shop</h1>
    <img id="hero" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="200" height="80">
    <p id="faint" style="color:#b0b0b0;background:#ffffff;font-size:14px;width:320px">Faint grey text</p>
    <button id="icon-only" style="width:40px;height:40px"></button>
    <input id="email" type="email" style="width:200px">
    <a id="empty-link" href="/cart" style="display:inline-block;width:30px;height:30px"></a>
  </main>
</body></html>`;

/** Accessible page: same content, done properly. */
const GOOD_PAGE = `<!doctype html><html lang="en"><head><title>Good page</title></head>
<body>
  <main>
    <h1>Shop</h1>
    <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="200" height="80" alt="Spring collection">
    <p style="color:#333333;background:#ffffff">Readable text</p>
    <button type="button">Add to cart</button>
    <label for="email">Email</label><input id="email" type="email">
    <a href="/cart">View cart</a>
  </main>
</body></html>`;

const STRICT_CSP_PAGE = BAD_PAGE.replace(
  "<head>",
  `<head><meta http-equiv="Content-Security-Policy" content="script-src 'none'; default-src 'none'; img-src data:; style-src 'unsafe-inline'">`,
);

function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

const chromiumPath = findLocalChromium();
if (!chromiumPath) {
  console.warn(
    "[axe-runner.browser.test] No local Chromium found; real-browser accessibility tests are skipped. Run `npx playwright install chromium` to enable them.",
  );
}

describe.skipIf(!chromiumPath)("runAxeInPage in real Chromium", () => {
  let browser: Browser;

  // Launching and closing Chromium can exceed the 10 s default while the
  // other browser test files run in parallel.
  beforeAll(async () => {
    browser = await launchLocalChromium(chromiumPath!);
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
  }, 30_000);

  async function audit(
    html: string,
    viewport: "desktop" | "mobile",
    opts: { maxCrops?: number } = {},
  ) {
    const context = await browser.newContext(
      viewport === "desktop"
        ? { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }
        : {
            viewport: { width: 390, height: 844 },
            deviceScaleFactor: 3,
            isMobile: true,
            hasTouch: true,
          },
    );
    const page = await context.newPage();
    await page.setContent(html);
    try {
      return await runAxeInPage({
        page: page as unknown as PlaywrightPageLike,
        axeSource: AXE_SOURCE,
        viewport,
        pageUrl: "https://shop.example.test/",
        now: Date.now,
        ...opts,
      });
    } finally {
      await context.close();
    }
  }

  it("finds the planted violations with their WCAG tags", async () => {
    const result = await audit(BAD_PAGE, "desktop");
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.axeVersion).toMatch(/^4\./);

    const artifact = JSON.parse(result.artifactJson);
    expect(artifact).toMatchObject({
      format: "mortem-axe/1",
      viewport: "desktop",
      status: "ok",
      runTags: [...AXE_RUN_TAGS],
    });
    const byId = new Map<string, { tags: string[]; impact: string }>(
      artifact.axeResults.violations.map(
        (v: { id: string; tags: string[]; impact: string }) => [v.id, v],
      ),
    );
    for (const [ruleId, wcagTag] of [
      ["image-alt", "wcag111"],
      ["color-contrast", "wcag143"],
      ["button-name", "wcag412"],
      ["label", "wcag412"],
      ["link-name", "wcag244"],
      ["html-has-lang", "wcag311"],
    ] as const) {
      expect(byId.has(ruleId), `${ruleId} expected`).toBe(true);
      expect(byId.get(ruleId)!.tags, ruleId).toContain(wcagTag);
    }
  });

  it("records document-coordinate bounding boxes and crops matching them", async () => {
    const result = await audit(BAD_PAGE, "desktop");
    if (result.status !== "ok") throw new Error(result.status);
    const boxes = JSON.parse(result.artifactJson)
      .boundingBoxes as AxeBoundingBox[];
    const hero = boxes.find((b) => b.ruleId === "image-alt")!;
    expect(hero).toMatchObject({ target: "#hero", width: 200, height: 80 });

    expect(result.elementCrops.length).toBeGreaterThan(0);
    expect(result.elementCrops.length).toBeLessThanOrEqual(5);
    for (const crop of result.elementCrops) {
      const size = pngSize(crop.png);
      expect(size.width, crop.target).toBe(Math.ceil(crop.box.width));
      expect(size.height, crop.target).toBe(Math.ceil(crop.box.height));
    }
    // Most severe first: critical rules are cropped before serious ones.
    expect(result.elementCrops[0]!.box.impact).toBe("critical");
  });

  it("crops at device scale on the mobile viewport", async () => {
    const result = await audit(BAD_PAGE, "mobile");
    if (result.status !== "ok") throw new Error(result.status);
    const crop = result.elementCrops.find((c) => c.target === "#hero")!;
    expect(pngSize(crop.png)).toEqual({ width: 600, height: 240 }); // 200x80 CSS px at 3x
  });

  it("audits a page whose Content-Security-Policy forbids all scripts", async () => {
    const result = await audit(STRICT_CSP_PAGE, "desktop");
    expect(result.status).toBe("ok");
    if (result.status === "ok")
      expect(result.violationCount).toBeGreaterThan(0);
  });

  it("finds no violations on the accessible version of the page", async () => {
    const result = await audit(GOOD_PAGE, "desktop");
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(JSON.parse(result.artifactJson).axeResults.violations).toEqual([]);
    expect(result.elementCrops).toEqual([]);
  });

  it("respects the crop limit", async () => {
    const result = await audit(BAD_PAGE, "desktop", { maxCrops: 1 });
    if (result.status !== "ok") throw new Error(result.status);
    expect(result.elementCrops).toHaveLength(1);
  });
});

describe("runAxeInPage failure handling (no browser needed)", () => {
  const stubPage = (
    evaluate: PlaywrightPageLike["evaluate"],
  ): PlaywrightPageLike =>
    ({
      evaluate,
      screenshot: async () => new Uint8Array(),
    }) as unknown as PlaywrightPageLike;

  it("skips with a reason when no axe source is provided", async () => {
    const result = await runAxeInPage({
      page: stubPage(async () => {
        throw new Error("must not be called");
      }),
      axeSource: "",
      viewport: "desktop",
      pageUrl: "https://x.test/",
      now: Date.now,
    });
    expect(result).toMatchObject({ status: "skipped" });
    expect(JSON.parse(result.artifactJson)).toMatchObject({
      status: "skipped",
      viewport: "desktop",
    });
  });

  it("reports an error instead of throwing when the page rejects evaluation", async () => {
    const result = await runAxeInPage({
      page: stubPage(async () => {
        throw new Error("Execution context was destroyed");
      }),
      axeSource: "window.axe = {}",
      viewport: "mobile",
      pageUrl: "https://x.test/",
      now: Date.now,
    });
    expect(result.status).toBe("error");
    expect(result.status !== "ok" && result.message).toContain(
      "Execution context was destroyed",
    );
  });

  it("times out instead of hanging the capture", async () => {
    const result = await runAxeInPage({
      page: stubPage(() => new Promise(() => undefined)),
      axeSource: "window.axe = {}",
      viewport: "desktop",
      pageUrl: "https://x.test/",
      now: Date.now,
      timeoutMs: 30,
    });
    expect(result).toMatchObject({ status: "timeout" });
  });

  it("rejects results in an unexpected shape", async () => {
    let call = 0;
    const result = await runAxeInPage({
      page: stubPage((async () =>
        call++ === 0
          ? undefined
          : JSON.stringify({
              axeResults: { nope: 1 },
            })) as PlaywrightPageLike["evaluate"]),
      axeSource: "window.axe = {}",
      viewport: "desktop",
      pageUrl: "https://x.test/",
      now: Date.now,
    });
    expect(result).toMatchObject({ status: "error" });
  });
});

describe("selectCropBoxes", () => {
  const box = (
    ruleId: string,
    impact: string,
    extra: Partial<AxeBoundingBox> = {},
  ): AxeBoundingBox => ({
    ruleId,
    target: `#${ruleId}`,
    impact,
    x: 10,
    y: 10,
    width: 50,
    height: 20,
    ...extra,
  });

  it("drops empty, off-page and page-sized boxes, dedupes, sorts by impact and caps", () => {
    const selected = selectCropBoxes(
      [
        box("minor-rule", "minor"),
        box("zero", "critical", { width: 0 }),
        box("offpage", "critical", { x: -5 }),
        box("huge", "critical", { width: 2000, height: 2000 }),
        box("crit", "critical"),
        box("crit", "critical"),
        box("serious-rule", "serious"),
      ],
      2,
    );
    expect(selected.map((b) => b.ruleId)).toEqual(["crit", "serious-rule"]);
  });
});
