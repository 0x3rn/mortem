import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { MobileAuditMeasurements } from "./mobile-audit";
import {
  MOBILE_MAX_OCCURRENCES_PER_PAGE,
  MOBILE_RULES,
  evaluateMobilePageRules,
  evaluateMobileRules,
  isZoomDisabled,
  parseViewportContent,
  type MobilePageFacts,
} from "./mobile-checks";

/** A page with no problems. */
function clean(): MobileAuditMeasurements {
  return {
    viewport: { width: 390, height: 844 },
    viewportMeta: { count: 1, content: "width=device-width, initial-scale=1" },
    documentWidth: 390,
    overflowingElements: [],
    tapTargets: { checked: 12, tooSmall: [], crowded: [] },
    text: { totalChars: 2000, smallChars: 0, smallElements: [] },
    overlays: [],
  };
}

function facts(
  patch: Partial<MobileAuditMeasurements> = {},
  crops: MobilePageFacts["evidence"]["crops"] = [],
): MobilePageFacts {
  return {
    pageId: "p1",
    pageUrl: "https://shop.example.test/",
    measurements: { ...clean(), ...patch },
    evidence: { raw: "ev_raw", screenshot: "ev_shot", crops },
  };
}

const ids = (f: MobilePageFacts) =>
  evaluateMobilePageRules(f).map((v) => v.ruleId);
const el = (selector: string, extra: Record<string, unknown> = {}) => ({
  selector,
  x: 0,
  y: 100,
  width: 16,
  height: 16,
  ...extra,
});

describe("viewport meta parsing", () => {
  it("parses the directives that matter", () => {
    expect(
      parseViewportContent(
        "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no",
      ),
    ).toEqual({ width: "device-width", userScalable: "no", maximumScale: 1 });
    expect(parseViewportContent("width=320;user-scalable=0").userScalable).toBe(
      "0",
    );
    expect(parseViewportContent("initial-scale=1").width).toBeNull();
    expect(parseViewportContent("maximum-scale=abc").maximumScale).toBeNull();
  });

  it("treats zoom as disabled only below 2x or with user-scalable=no/0", () => {
    expect(isZoomDisabled(parseViewportContent("user-scalable=no"))).toBe(true);
    expect(isZoomDisabled(parseViewportContent("user-scalable=0"))).toBe(true);
    expect(isZoomDisabled(parseViewportContent("maximum-scale=1.5"))).toBe(
      true,
    );
    expect(isZoomDisabled(parseViewportContent("maximum-scale=2"))).toBe(false);
    expect(
      isZoomDisabled(
        parseViewportContent("user-scalable=yes, maximum-scale=5"),
      ),
    ).toBe(false);
    expect(isZoomDisabled(parseViewportContent("width=device-width"))).toBe(
      false,
    );
  });
});

describe("mobile rules: passing and failing fixtures", () => {
  it("a clean responsive page passes every rule", () => {
    expect(ids(facts())).toEqual([]);
  });

  it("mobile.viewport.missing fires alone; sizes on a 980 px desktop layout are not repeated", () => {
    const v = evaluateMobilePageRules(
      facts({
        viewport: { width: 980, height: 2100 },
        viewportMeta: { count: 0, content: null },
        documentWidth: 1200,
        overflowingElements: [el("#wide", { width: 1200 })],
        tapTargets: {
          checked: 3,
          tooSmall: [{ ...el("a"), label: "A" }],
          crowded: [],
        },
        text: { totalChars: 100, smallChars: 90, smallElements: [] },
      }),
    );
    expect(v.map((x) => x.ruleId)).toEqual(["mobile.viewport.missing"]);
    expect(v[0]!.evidenceArtifactId).toBe("ev_raw");
    expect(v[0]!.excerpt).toContain("980 px");
  });

  it("an overlay is still reported when the viewport tag is missing", () => {
    expect(
      ids(
        facts({
          viewportMeta: { count: 0, content: null },
          overlays: [
            {
              ...el("#modal", { width: 980, height: 1500 }),
              position: "fixed",
              coverage: 0.7,
              sample: "Sign up!",
            },
          ],
        }),
      ),
    ).toEqual(["mobile.viewport.missing", "mobile.overlay.intrusive"]);
  });

  it("mobile.viewport.not-device-width and mobile.viewport.zoom-disabled", () => {
    expect(
      ids(facts({ viewportMeta: { count: 1, content: "width=1024" } })),
    ).toEqual(["mobile.viewport.not-device-width"]);
    expect(
      ids(
        facts({
          viewportMeta: {
            count: 1,
            content: "width=device-width, maximum-scale=1",
          },
        }),
      ),
    ).toEqual(["mobile.viewport.zoom-disabled"]);
    expect(
      ids(
        facts({
          viewportMeta: {
            count: 1,
            content: "width=device-width, user-scalable=no",
          },
        }),
      ),
    ).toEqual(["mobile.viewport.zoom-disabled"]);
  });

  it("mobile.overflow.horizontal: one occurrence per element, or one for the page", () => {
    const v = evaluateMobilePageRules(
      facts(
        {
          documentWidth: 700,
          overflowingElements: [el("#wide", { width: 700, height: 40 })],
        },
        [{ check: "overflow", selector: "#wide", artifactId: "ev_crop_wide" }],
      ),
    );
    expect(v).toEqual([
      expect.objectContaining({
        ruleId: "mobile.overflow.horizontal",
        selector: "#wide",
        bbox: { x: 0, y: 100, width: 700, height: 40 },
        evidenceArtifactId: "ev_crop_wide",
        occurrenceKey: "#wide",
      }),
    ]);
    // Overflow measured but no element identified: still reported, citing the raw audit.
    const page = evaluateMobilePageRules(facts({ documentWidth: 420 }));
    expect(page).toEqual([
      expect.objectContaining({
        ruleId: "mobile.overflow.horizontal",
        evidenceArtifactId: "ev_raw",
      }),
    ]);
    // 1 px of rounding is not overflow.
    expect(ids(facts({ documentWidth: 391 }))).toEqual([]);
  });

  it("tap target rules cite the crop when there is one, else the mobile screenshot", () => {
    const v = evaluateMobilePageRules(
      facts(
        {
          tapTargets: {
            checked: 5,
            tooSmall: [{ ...el("nav > a:nth-of-type(1)"), label: "Search" }],
            crowded: [
              {
                ...el("footer a", { width: 40, height: 30 }),
                label: "Terms",
                gapPx: 2,
              },
            ],
          },
        },
        [
          {
            check: "tap-target-small",
            selector: "nav > a:nth-of-type(1)",
            artifactId: "ev_crop_a",
          },
        ],
      ),
    );
    expect(v.map((x) => [x.ruleId, x.evidenceArtifactId])).toEqual([
      ["mobile.tap-target.too-small", "ev_crop_a"],
      ["mobile.tap-target.crowded", "ev_shot"],
    ]);
    expect(v[0]!.excerpt).toContain('"Search" is 16×16 px');
    // The measured tap area is reported when the audit found one larger than the box.
    const hit = evaluateMobilePageRules(
      facts({
        tapTargets: {
          checked: 1,
          tooSmall: [
            { ...el("#dot"), label: "Next", hitWidth: 20, hitHeight: 22 },
          ],
          crowded: [],
        },
      }),
    );
    expect(hit[0]!.excerpt).toContain('"Next" is 20×22 px to tap');
    expect(v[1]!.excerpt).toContain("only 2 px to the next target");
  });

  it("caps occurrences per page but keeps one per element up to the cap", () => {
    const many = Array.from({ length: 15 }, (_, i) => ({
      ...el(`a:nth-of-type(${i + 1})`),
      label: `L${i}`,
    }));
    const v = evaluateMobilePageRules(
      facts({ tapTargets: { checked: 15, tooSmall: many, crowded: [] } }),
    );
    expect(v).toHaveLength(MOBILE_MAX_OCCURRENCES_PER_PAGE);
  });

  it("mobile.text.too-small fires above 40 % small text, not at or below it", () => {
    const text = (small: number) => ({
      totalChars: 1000,
      smallChars: small,
      smallElements: [
        {
          ...el("#fine", { width: 300, height: 80 }),
          fontSizePx: 10,
          chars: small,
          sample: "Terms apply",
        },
      ],
    });
    expect(ids(facts({ text: text(400) }))).toEqual([]);
    const v = evaluateMobilePageRules(facts({ text: text(401) }));
    expect(v.map((x) => x.ruleId)).toEqual(["mobile.text.too-small"]);
    expect(v[0]!.excerpt).toBe('10 px text: "Terms apply"');
    expect(v[0]!.context).toEqual({
      smallChars: 401,
      totalChars: 1000,
      smallShare: 0.401,
    });
    expect(
      ids(facts({ text: { totalChars: 0, smallChars: 0, smallElements: [] } })),
    ).toEqual([]);
  });

  it("mobile.overlay.intrusive fires above 30 % of the screen height only", () => {
    const overlay = (coverage: number) => [
      {
        ...el("#cookie", { width: 390, height: 300 }),
        position: "fixed",
        coverage,
        sample: "We use cookies",
      },
    ];
    expect(ids(facts({ overlays: overlay(0.3) }))).toEqual([]);
    const v = evaluateMobilePageRules(facts({ overlays: overlay(0.47) }));
    expect(v.map((x) => x.ruleId)).toEqual(["mobile.overlay.intrusive"]);
    expect(v[0]!.excerpt).toBe(
      'fixed element covers 47 % of the screen height on load: "We use cookies"',
    );
  });
});

describe("mobile findings", () => {
  it("one finding per rule with the worst severity, counting pages and elements", () => {
    const candidates = evaluateMobileRules([
      facts({
        tapTargets: {
          checked: 2,
          tooSmall: [
            { ...el("a"), label: "A" },
            { ...el("b"), label: "B" },
          ],
          crowded: [],
        },
      }),
      {
        ...facts({ documentWidth: 500 }),
        pageId: "p2",
        pageUrl: "https://shop.example.test/a",
      },
    ]);
    expect(
      candidates.map((c) => [
        c.ruleId,
        c.severity,
        c.measured.value,
        c.measured.rawContext.elements,
      ]),
    ).toEqual([
      ["mobile.overflow.horizontal", "high", 1, 0],
      ["mobile.tap-target.too-small", "medium", 1, 2],
    ]);
    expect(candidates[0]!.category).toBe("mobile");
  });
});

describe("mobile rule catalog documentation stays in sync with the code", () => {
  it("documents every rule id", () => {
    const doc = readFileSync(
      resolve(__dirname, "../../../docs/rule-catalog/mobile.md"),
      "utf8",
    );
    for (const rule of MOBILE_RULES) {
      expect(
        doc,
        `${rule.ruleId} missing from docs/rule-catalog/mobile.md`,
      ).toContain(`\`${rule.ruleId}\``);
    }
  });
});
