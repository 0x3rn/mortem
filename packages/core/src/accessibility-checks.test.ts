import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACCESSIBILITY_COVERAGE_NOTE,
  AXE_CATEGORY_GROUPS,
  MAX_NODES_PER_RULE_PER_VIEWPORT,
  WCAG_SUCCESS_CRITERIA,
  affectedGroupsFromTags,
  evaluateAccessibility,
  parseAxeArtifact,
  wcagCriteriaFromTags,
  type AccessibilityPageInput,
  type ParsedAxeArtifact,
} from "./accessibility-checks";

/*
 * Fixtures `recorded-bad-page-*.json` are real runAxeInPage output (axe-core 4.14
 * in Chromium) for a page with planted problems: two images without alt, faint
 * text, an empty button, an unlabelled input, an empty link, no <html lang>, and
 * content outside any landmark.
 */
const fixture = (viewport: "desktop" | "mobile"): unknown =>
  JSON.parse(
    readFileSync(
      resolve(__dirname, `__fixtures__/axe/recorded-bad-page-${viewport}.json`),
      "utf8",
    ),
  );

function parsed(viewport: "desktop" | "mobile"): ParsedAxeArtifact {
  const result = parseAxeArtifact(fixture(viewport));
  if (!result.ok) throw new Error(result.message);
  return result.data;
}

function input(
  viewport: "desktop" | "mobile",
  overrides: Partial<AccessibilityPageInput> = {},
): AccessibilityPageInput {
  return {
    pageId: "p_home",
    pageUrl: "https://shop.example.test/",
    viewport,
    axeArtifactId: `p_home_ev_axe_raw_${viewport}`,
    crops: [],
    data: parsed(viewport),
    ...overrides,
  };
}

describe("parseAxeArtifact", () => {
  it("reads a recorded axe artifact", () => {
    const data = parsed("desktop");
    expect(data.viewport).toBe("desktop");
    expect(data.axeVersion).toBe("4.14.0");
    expect(data.violations.map((v) => v.id).sort()).toEqual([
      "button-name",
      "color-contrast",
      "html-has-lang",
      "image-alt",
      "label",
      "link-name",
      "region",
    ]);
    expect(
      data.violations
        .find((v) => v.id === "image-alt")!
        .nodes.map((n) => n.target),
    ).toEqual(["#hero", "#promo"]);
    expect(data.boundingBoxes.find((b) => b.target === "#hero")).toMatchObject({
      width: 200,
      height: 80,
    });
  });

  it("returns the stored reason when axe did not run", () => {
    for (const status of ["error", "timeout", "skipped"] as const) {
      expect(
        parseAxeArtifact({
          format: "mortem-axe/1",
          viewport: "desktop",
          status,
          message: `axe ${status}`,
        }),
      ).toEqual({ ok: false, status, message: `axe ${status}` });
    }
  });

  it("rejects malformed artifacts instead of guessing", () => {
    for (const bad of [
      null,
      "x",
      [],
      {},
      { status: "ok" },
      { status: "ok", viewport: "tablet", axeResults: { violations: [] } },
    ]) {
      expect(parseAxeArtifact(bad)).toMatchObject({
        ok: false,
        status: "invalid",
      });
    }
  });

  it("joins iframe and shadow DOM target paths and tolerates odd node entries", () => {
    const result = parseAxeArtifact({
      status: "ok",
      viewport: "mobile",
      axeResults: {
        violations: [
          {
            id: "image-alt",
            tags: ["wcag111"],
            nodes: [
              { target: ["iframe#ad", "img.banner"], html: "<img>" },
              { target: [["my-widget", "img"]], html: "<img>" },
              "not-a-node",
            ],
          },
        ],
      },
    });
    expect(
      result.ok && result.data.violations[0]!.nodes.map((n) => n.target),
    ).toEqual(["iframe#ad >>> img.banner", "my-widget >>> img"]);
  });
});

describe("WCAG mapping", () => {
  it("maps axe SC tags to WCAG 2.2 criteria with names and levels", () => {
    expect(
      wcagCriteriaFromTags(["cat.color", "wcag2aa", "wcag143", "TTv5"]),
    ).toEqual([{ sc: "1.4.3", name: "Contrast (Minimum)", level: "AA" }]);
    expect(wcagCriteriaFromTags(["wcag1410", "wcag258", "wcag412"])).toEqual([
      { sc: "1.4.10", name: "Reflow", level: "AA" },
      { sc: "2.5.8", name: "Target Size (Minimum)", level: "AA" },
      { sc: "4.1.2", name: "Name, Role, Value", level: "A" },
    ]);
    // Unknown criterion: reported by number, never given an invented name.
    expect(wcagCriteriaFromTags(["wcag999"])).toEqual([
      { sc: "9.9.9", name: null, level: null },
    ]);
    expect(wcagCriteriaFromTags(["best-practice", "wcag2a"])).toEqual([]);
  });

  it("covers all 87 WCAG 2.2 success criteria (4.1.1 marked obsolete)", () => {
    const entries = Object.entries(WCAG_SUCCESS_CRITERIA);
    expect(entries).toHaveLength(87);
    expect(
      entries.filter(([, c]) => c.level === "obsolete").map(([sc]) => sc),
    ).toEqual(["4.1.1"]);
    for (const [sc, c] of entries) {
      expect(sc).toMatch(/^[1-4]\.\d\.\d{1,2}$/);
      expect(["A", "AA", "AAA", "obsolete"]).toContain(c.level);
    }
    expect(
      entries.filter(([, c]) => c.level === "A" || c.level === "AA"),
    ).toHaveLength(55);
  });

  it("names the people affected, with a generic fallback", () => {
    expect(affectedGroupsFromTags(["cat.color"])).toEqual([
      "People with low vision or colour-vision deficiency",
    ]);
    expect(affectedGroupsFromTags(["cat.aria", "cat.name-role-value"])).toEqual(
      ["Screen reader and voice-control users"],
    );
    expect(affectedGroupsFromTags(["wcag2a"])).toEqual([
      "Assistive technology users",
    ]);
  });
});

describe("evaluateAccessibility on recorded axe results", () => {
  const candidates = evaluateAccessibility([input("desktop"), input("mobile")]);
  const byId = new Map(candidates.map((c) => [c.ruleId, c]));

  it("produces one finding per axe rule with axe impact mapped to severity", () => {
    expect(
      Object.fromEntries(candidates.map((c) => [c.ruleId, c.severity])),
    ).toEqual({
      "a11y.button-name": "critical",
      "a11y.color-contrast": "high",
      "a11y.html-has-lang": "high",
      "a11y.image-alt": "critical",
      "a11y.label": "critical",
      "a11y.link-name": "high",
      "a11y.region": "medium",
    });
  });

  it("de-duplicates across viewports into per-page, per-viewport occurrences", () => {
    const imageAlt = byId.get("a11y.image-alt")!;
    expect(imageAlt.measured.value).toBe(4); // 2 images x 2 viewports
    expect(
      imageAlt.occurrences.map((o) => `${o.viewport}:${o.selector}`),
    ).toEqual([
      "desktop:#hero",
      "desktop:#promo",
      "mobile:#hero",
      "mobile:#promo",
    ]);
    expect(new Set(imageAlt.occurrences.map((o) => o.occurrenceKey)).size).toBe(
      4,
    );
    expect(imageAlt.measured.rawContext.viewports).toEqual([
      "desktop",
      "mobile",
    ]);
  });

  it("records WCAG criteria, affected groups and the coverage note", () => {
    const contrast = byId.get("a11y.color-contrast")!;
    expect(contrast.title).toBe(
      "Elements must meet minimum color contrast ratio thresholds",
    );
    expect(contrast.measured.rawContext).toMatchObject({
      wcag: [{ sc: "1.4.3", name: "Contrast (Minimum)", level: "AA" }],
      bestPracticeOnly: false,
      affectedGroups: ["People with low vision or colour-vision deficiency"],
      axeVersions: ["4.14.0"],
      coverageNote: ACCESSIBILITY_COVERAGE_NOTE,
    });
    expect(contrast.fixRole).toBe("designer");
    expect(
      byId.get("a11y.link-name")!.measured.rawContext.wcag.map((w) => w.sc),
    ).toEqual(["2.4.4", "4.1.2"]);
  });

  it("labels rules with no WCAG mapping as best practice", () => {
    expect(byId.get("a11y.region")!.measured.rawContext).toMatchObject({
      wcag: [],
      bestPracticeOnly: true,
    });
  });

  it("stores selector, HTML snippet, reason and bounding box on each occurrence", () => {
    const hero = byId.get("a11y.image-alt")!.occurrences[0]!;
    expect(hero.selector).toBe("#hero");
    expect(hero.excerpt).toContain("Element does not have an alt attribute");
    expect(hero.excerpt).toContain('<img id="hero"');
    expect(hero.excerpt.startsWith("desktop: ")).toBe(true);
    expect(hero.bbox).toMatchObject({
      width: 200,
      height: 80,
      viewport: "desktop",
    });

    const contrast = byId.get("a11y.color-contrast")!.occurrences[0]!;
    expect(contrast.excerpt).toContain("insufficient color contrast of 2.16");
  });

  it("cites the element crop when one exists, otherwise the raw axe results", () => {
    const withCrop = evaluateAccessibility([
      input("desktop", {
        crops: [
          {
            ruleId: "image-alt",
            target: "#hero",
            artifactId: "p_home_ev_screenshot_element_a11y_desktop_0",
          },
        ],
      }),
    ]);
    const occ = withCrop.find(
      (c) => c.ruleId === "a11y.image-alt",
    )!.occurrences;
    expect(occ.find((o) => o.selector === "#hero")!.evidenceArtifactId).toBe(
      "p_home_ev_screenshot_element_a11y_desktop_0",
    );
    expect(occ.find((o) => o.selector === "#promo")!.evidenceArtifactId).toBe(
      "p_home_ev_axe_raw_desktop",
    );
  });

  it("merges the same rule across pages and lists every affected URL", () => {
    const merged = evaluateAccessibility([
      input("desktop"),
      input("desktop", {
        pageId: "p_pricing",
        pageUrl: "https://shop.example.test/pricing",
        axeArtifactId: "p_pricing_ev_axe_raw_desktop",
      }),
    ]).find((c) => c.ruleId === "a11y.label")!;
    expect(merged.measured.rawContext.affectedUrls).toEqual([
      "https://shop.example.test/",
      "https://shop.example.test/pricing",
    ]);
    expect(merged.occurrences.map((o) => o.pageId)).toEqual([
      "p_home",
      "p_pricing",
    ]);
  });

  it("caps listed elements per rule and viewport while counting all of them", () => {
    const many: ParsedAxeArtifact = {
      viewport: "desktop",
      pageUrl: null,
      axeVersion: "4.14.0",
      incompleteRuleCount: 0,
      boundingBoxes: [],
      violations: [
        {
          id: "color-contrast",
          impact: "serious",
          help: "Contrast",
          helpUrl: null,
          tags: ["wcag143"],
          nodes: Array.from({ length: 15 }, (_, i) => ({
            target: `#t${i}`,
            html: `<p id="t${i}">x</p>`,
            failureSummary: null,
            impact: "serious",
          })),
        },
      ],
    };
    const [candidate] = evaluateAccessibility([
      input("desktop", { data: many }),
    ]);
    expect(candidate!.measured.value).toBe(15);
    expect(candidate!.occurrences).toHaveLength(
      MAX_NODES_PER_RULE_PER_VIEWPORT,
    );
    expect(candidate!.measured.rawContext.elementsNotListed).toBe(5);
  });

  it("returns nothing for a page without violations", () => {
    expect(
      evaluateAccessibility([
        input("desktop", { data: { ...parsed("desktop"), violations: [] } }),
      ]),
    ).toEqual([]);
  });

  it("states what automated checks cannot cover", () => {
    expect(ACCESSIBILITY_COVERAGE_NOTE).toContain("30–50%");
    expect(ACCESSIBILITY_COVERAGE_NOTE).toContain(
      "manual keyboard and screen-reader testing",
    );
    expect(ACCESSIBILITY_COVERAGE_NOTE).toContain(
      "does not mean the site conforms to WCAG",
    );
  });
});

describe("accessibility catalog documentation stays in sync", () => {
  const doc = readFileSync(
    resolve(__dirname, "../../../docs/rule-catalog/accessibility.md"),
    "utf8",
  );
  it("quotes the exact coverage note and documents every affected-people category", () => {
    expect(doc).toContain(ACCESSIBILITY_COVERAGE_NOTE);
    for (const category of Object.keys(AXE_CATEGORY_GROUPS)) {
      expect(doc, category).toContain(`\`${category}\``);
    }
  });
});
