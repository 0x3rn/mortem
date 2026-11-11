import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ACCESSIBILITY_COVERAGE_NOTE } from "./accessibility-checks";
import { runAccessibilityChecks } from "./accessibility-checks-runner";
import type { AxeCaptureResult } from "./axe-runner";
import type { R2BucketLike } from "./cloudflare";
import { persistPageCaptureEvidenceToR2AndD1 } from "./evidence-storage";
import {
  buildCaptureResult,
  createInMemoryR2,
  createSqliteD1,
  seedScanWithPages,
} from "./test-support";

/** Real recorded axe output, shaped exactly as the capture stage produces it. */
function recordedResult(
  viewport: "desktop" | "mobile",
  withHeroCrop = true,
): AxeCaptureResult {
  const artifact = JSON.parse(
    readFileSync(
      resolve(__dirname, `__fixtures__/axe/recorded-bad-page-${viewport}.json`),
      "utf8",
    ),
  ) as Record<string, unknown> & {
    boundingBoxes: Array<{
      ruleId: string;
      target: string;
      impact: string | null;
      x: number;
      y: number;
      width: number;
      height: number;
    }>;
  };
  delete artifact._mortemFixture;
  const hero = artifact.boundingBoxes.find((b) => b.target === "#hero")!;
  return {
    status: "ok",
    durationMs: 900,
    axeVersion: "4.14.0",
    violationCount: 7,
    artifactJson: JSON.stringify(artifact),
    elementCrops: withHeroCrop
      ? [
          {
            ruleId: "image-alt",
            target: "#hero",
            box: hero,
            png: new Uint8Array([137, 80, 78, 71]),
          },
        ]
      : [],
    cropFailures: 0,
  };
}

async function setup(
  pages: Array<{
    id: string;
    url: string;
    accessibility?: Partial<Record<"desktop" | "mobile", AxeCaptureResult>>;
  }>,
) {
  const d1 = createSqliteD1();
  const r2 = createInMemoryR2();
  await seedScanWithPages(d1, {
    scanId: "scan_a11y",
    origin: "https://shop.example.test",
    pages: pages.map((p) => ({ id: p.id, url: p.url, templateType: "other" })),
  });
  for (const p of pages) {
    await persistPageCaptureEvidenceToR2AndD1({
      d1,
      r2,
      scanId: "scan_a11y",
      pageId: p.id,
      capture: buildCaptureResult({
        url: p.url,
        html: "<html></html>",
        accessibility: p.accessibility,
      }),
      nowMs: 1,
    });
  }
  return { d1, r2 };
}

const rows = (d1: ReturnType<typeof createSqliteD1>, sql: string) =>
  d1.sqlite.prepare(sql).all() as Record<string, unknown>[];

describe("runAccessibilityChecks", () => {
  it("turns stored axe results into a11y findings with selector, box and crop evidence", async () => {
    const { d1, r2 } = await setup([
      {
        id: "p_home",
        url: "https://shop.example.test/",
        accessibility: {
          desktop: recordedResult("desktop"),
          mobile: recordedResult("mobile", false),
        },
      },
    ]);
    const summary = await runAccessibilityChecks({
      d1,
      r2,
      scanId: "scan_a11y",
      nowMs: 5,
    });

    expect(summary).toMatchObject({
      pagesConsidered: 1,
      viewportsAudited: 2,
      unavailable: [],
      findingsWritten: 7,
      coverageNote: ACCESSIBILITY_COVERAGE_NOTE,
    });
    expect([...summary.rulesFired].sort()).toEqual([
      "a11y.button-name",
      "a11y.color-contrast",
      "a11y.html-has-lang",
      "a11y.image-alt",
      "a11y.label",
      "a11y.link-name",
      "a11y.region",
    ]);

    const imageAlt = rows(
      d1,
      `SELECT o.selector, o.bbox_json, a.kind, a.metadata_json
       FROM finding_occurrences o
       JOIN findings f ON f.id = o.finding_id
       JOIN evidence_artifacts a ON a.id = o.evidence_artifact_id
       WHERE f.check_id = 'a11y.image-alt'
       ORDER BY o.id`,
    );
    expect(imageAlt).toHaveLength(4);
    // Desktop #hero cites its element crop; everything else cites the axe results.
    const desktopHero = imageAlt.find(
      (r) =>
        r.selector === "#hero" &&
        JSON.parse(String(r.bbox_json)).viewport === "desktop",
    )!;
    expect(desktopHero.kind).toBe("screenshot_element");
    expect(JSON.parse(String(desktopHero.metadata_json))).toMatchObject({
      source: "axe",
      ruleId: "image-alt",
      selector: "#hero",
    });
    expect(JSON.parse(String(desktopHero.bbox_json))).toMatchObject({
      width: 200,
      height: 80,
    });
    expect(imageAlt.filter((r) => r.kind === "axe_raw")).toHaveLength(3);

    const finding = rows(
      d1,
      `SELECT category, severity, measured_value_json FROM findings WHERE check_id = 'a11y.color-contrast'`,
    )[0]!;
    expect(finding).toMatchObject({
      category: "accessibility",
      severity: "high",
    });
    expect(
      JSON.parse(String(finding.measured_value_json)).rawContext.wcag,
    ).toEqual([{ sc: "1.4.3", name: "Contrast (Minimum)", level: "AA" }]);
  });

  it("reports viewports where axe did not run, with the stored reason, and audits the rest", async () => {
    const { d1, r2 } = await setup([
      {
        id: "p_home",
        url: "https://shop.example.test/",
        accessibility: {
          desktop: recordedResult("desktop"),
          mobile: {
            status: "timeout",
            durationMs: 20000,
            message: "axe-core did not finish within 20000 ms.",
            artifactJson: JSON.stringify({
              format: "mortem-axe/1",
              viewport: "mobile",
              status: "timeout",
              message: "axe-core did not finish within 20000 ms.",
            }),
          },
        },
      },
    ]);
    const summary = await runAccessibilityChecks({
      d1,
      r2,
      scanId: "scan_a11y",
    });
    expect(summary.viewportsAudited).toBe(1);
    expect(summary.unavailable).toEqual([
      {
        pageId: "p_home",
        pageUrl: "https://shop.example.test/",
        viewport: "mobile",
        status: "timeout",
        message: "axe-core did not finish within 20000 ms.",
      },
    ]);
    expect(summary.findingsWritten).toBe(7);
  });

  it("says when a page has no accessibility results at all (captured before THE-182)", async () => {
    const { d1, r2 } = await setup([
      { id: "p_old", url: "https://shop.example.test/old" },
    ]);
    const summary = await runAccessibilityChecks({
      d1,
      r2,
      scanId: "scan_a11y",
    });
    expect(summary.viewportsAudited).toBe(0);
    expect(summary.unavailable.map((u) => `${u.viewport}:${u.status}`)).toEqual(
      ["desktop:not_captured", "mobile:not_captured"],
    );
    expect(summary.findingsWritten).toBe(0);
  });

  it("flags axe results recorded in D1 but missing from R2", async () => {
    const { d1, r2 } = await setup([
      {
        id: "p_home",
        url: "https://shop.example.test/",
        accessibility: { desktop: recordedResult("desktop") },
      },
    ]);
    r2.objects.delete("scans/scan_a11y/pages/p_home/axe_raw_desktop.json");
    const summary = await runAccessibilityChecks({
      d1,
      r2,
      scanId: "scan_a11y",
    });
    expect(
      summary.unavailable.find((u) => u.viewport === "desktop"),
    ).toMatchObject({ status: "missing" });
  });

  it("is idempotent and leaves other check families alone", async () => {
    const { d1, r2 } = await setup([
      {
        id: "p_home",
        url: "https://shop.example.test/",
        accessibility: { desktop: recordedResult("desktop") },
      },
    ]);
    d1.sqlite
      .prepare(
        `INSERT INTO findings (id, scan_id, check_id, category, severity, effort, impact, priority_score,
                               title, measured_value_json, threshold_json, fix_role, created_at, updated_at)
         VALUES ('f_seo', 'scan_a11y', 'seo.title.missing', 'seo', 'high', 'low', 'high', 70,
                 'Missing title', '{}', '{}', 'content', 1, 1)`,
      )
      .run();
    const snapshot = () => ({
      a11y: rows(
        d1,
        `SELECT COUNT(*) AS n FROM findings WHERE check_id LIKE 'a11y.%'`,
      )[0]!.n,
      occurrences: rows(d1, `SELECT COUNT(*) AS n FROM finding_occurrences`)[0]!
        .n,
      seo: rows(
        d1,
        `SELECT COUNT(*) AS n FROM findings WHERE check_id LIKE 'seo.%'`,
      )[0]!.n,
    });
    await runAccessibilityChecks({ d1, r2, scanId: "scan_a11y" });
    const first = snapshot();
    await runAccessibilityChecks({ d1, r2, scanId: "scan_a11y" });
    expect(snapshot()).toEqual(first);
    expect(first).toEqual({ a11y: 7, occurrences: 8, seo: 1 });
  });

  it("fails closed when R2 cannot be read", async () => {
    const { d1, r2 } = await setup([
      {
        id: "p_home",
        url: "https://shop.example.test/",
        accessibility: { desktop: recordedResult("desktop") },
      },
    ]);
    const writeOnly: R2BucketLike = { put: r2.put, head: r2.head };
    await expect(
      runAccessibilityChecks({ d1, r2: writeOnly, scanId: "scan_a11y" }),
    ).rejects.toMatchObject({
      name: "PlatformBindingError",
      code: "MISSING_BINDING",
    });
  });
});

describe("runAccessibilityChecks evidence selection", () => {
  it("never cites an element screenshot that another check stored, even if it names the same element", async () => {
    const { d1, r2 } = await setup([
      {
        id: "p_home",
        url: "https://shop.example.test/",
        accessibility: { desktop: recordedResult("desktop", false) },
      },
    ]);
    // A non-axe crop for the same rule and selector (e.g. from a future conversion check).
    d1.sqlite
      .prepare(
        `INSERT INTO evidence_artifacts (id, scan_id, page_id, kind, r2_key, byte_size, sha256, metadata_json, created_at)
         VALUES ('p_home_ev_other_crop', 'scan_a11y', 'p_home', 'screenshot_element', 'k/other', 4, ?, ?, 1)`,
      )
      .run(
        "b".repeat(64),
        JSON.stringify({
          source: "conversion",
          viewport: "desktop",
          ruleId: "image-alt",
          selector: "#hero",
        }),
      );
    await runAccessibilityChecks({ d1, r2, scanId: "scan_a11y" });
    const cited = rows(
      d1,
      `SELECT o.evidence_artifact_id FROM finding_occurrences o
       JOIN findings f ON f.id = o.finding_id
       WHERE f.check_id = 'a11y.image-alt' AND o.selector = '#hero'`,
    );
    expect(cited).toEqual([
      { evidence_artifact_id: "p_home_ev_axe_raw_desktop" },
    ]);
  });
});
