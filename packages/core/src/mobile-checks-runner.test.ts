import { describe, expect, it } from "vitest";
import { persistPageCaptureEvidenceToR2AndD1 } from "./evidence-storage";
import type {
  MobileAuditMeasurements,
  MobileAuditResult,
} from "./mobile-audit";
import { runMobileChecks } from "./mobile-checks-runner";
import {
  buildCaptureResult,
  createInMemoryR2,
  createSqliteD1,
  seedScanWithPages,
} from "./test-support";

/* Evidence is written with the production writer, pinning the capture → checks contract. */

const SCAN = "scan_mobile";
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function measurements(
  patch: Partial<MobileAuditMeasurements> = {},
): MobileAuditMeasurements {
  return {
    viewport: { width: 390, height: 844 },
    viewportMeta: { count: 1, content: "width=device-width, initial-scale=1" },
    documentWidth: 390,
    overflowingElements: [],
    tapTargets: { checked: 4, tooSmall: [], crowded: [] },
    text: { totalChars: 500, smallChars: 0, smallElements: [] },
    overlays: [],
    ...patch,
  };
}

function okResult(
  m: MobileAuditMeasurements,
  cropSelectors: string[] = [],
): MobileAuditResult {
  return {
    status: "ok",
    durationMs: 40,
    measurements: m,
    artifactJson: JSON.stringify({
      format: "mortem-mobile/1",
      status: "ok",
      measurements: m,
    }),
    elementCrops: cropSelectors.map((selector) => ({
      check: "overflow" as const,
      selector,
      box: { selector, x: 0, y: 10, width: 700, height: 40 },
      png: PNG,
    })),
    cropFailures: 0,
  };
}

async function setup(
  pages: Array<{
    id: string;
    url: string;
    mobileLayout?: MobileAuditResult;
    store?: boolean;
  }>,
) {
  const d1 = createSqliteD1();
  const r2 = createInMemoryR2();
  await seedScanWithPages(d1, {
    scanId: SCAN,
    origin: "https://shop.example.test",
    pages: pages.map((p) => ({ id: p.id, url: p.url })),
  });
  for (const p of pages) {
    if (p.store === false) continue;
    await persistPageCaptureEvidenceToR2AndD1({
      d1,
      r2,
      scanId: SCAN,
      pageId: p.id,
      capture: buildCaptureResult({
        url: p.url,
        html: "<!doctype html><title>x</title>",
        mobileLayout: p.mobileLayout,
      }),
      nowMs: 1,
    });
  }
  return { d1, r2 };
}

function occurrences(d1: ReturnType<typeof createSqliteD1>) {
  return d1.sqlite
    .prepare(
      `SELECT f.check_id, f.category, o.page_id, o.selector, o.bbox_json, e.kind, json_extract(e.metadata_json, '$.source') AS source
       FROM findings f JOIN finding_occurrences o ON o.finding_id = f.id
       JOIN evidence_artifacts e ON e.id = o.evidence_artifact_id
       WHERE f.scan_id = ? ORDER BY f.check_id, o.selector`,
    )
    .all(SCAN) as Array<Record<string, string | null>>;
}

describe("runMobileChecks", () => {
  it("turns stored measurements into findings that cite crops, screenshots and the raw audit", async () => {
    const { d1, r2 } = await setup([
      {
        id: "p_home",
        url: "https://shop.example.test/",
        mobileLayout: okResult(
          measurements({
            viewportMeta: {
              count: 1,
              content: "width=device-width, user-scalable=no",
            },
            documentWidth: 700,
            overflowingElements: [
              { selector: "#wide", x: 0, y: 10, width: 700, height: 40 },
            ],
            tapTargets: {
              checked: 3,
              tooSmall: [
                {
                  selector: "nav > a",
                  x: 10,
                  y: 60,
                  width: 16,
                  height: 16,
                  label: "Search",
                },
              ],
              crowded: [],
            },
          }),
          ["#wide"],
        ),
      },
      {
        id: "p_clean",
        url: "https://shop.example.test/about",
        mobileLayout: okResult(measurements()),
      },
    ]);

    const summary = await runMobileChecks({ d1, r2, scanId: SCAN, nowMs: 5 });

    expect(summary).toMatchObject({
      pagesConsidered: 2,
      pagesChecked: 2,
      pagesSkipped: [],
      rulesFired: [
        "mobile.viewport.zoom-disabled",
        "mobile.overflow.horizontal",
        "mobile.tap-target.too-small",
      ],
    });
    expect(occurrences(d1)).toEqual([
      {
        check_id: "mobile.overflow.horizontal",
        category: "mobile",
        page_id: "p_home",
        selector: "#wide",
        bbox_json: JSON.stringify({ x: 0, y: 10, width: 700, height: 40 }),
        kind: "screenshot_element",
        source: "mobile",
      },
      {
        check_id: "mobile.tap-target.too-small",
        category: "mobile",
        page_id: "p_home",
        selector: "nav > a",
        bbox_json: JSON.stringify({ x: 10, y: 60, width: 16, height: 16 }),
        kind: "screenshot_mobile",
        source: null,
      },
      {
        check_id: "mobile.viewport.zoom-disabled",
        category: "mobile",
        page_id: "p_home",
        selector: null,
        bbox_json: null,
        kind: "mobile_raw",
        source: null,
      },
    ]);
  });

  it("skips pages without a stored audit or with a failed audit, stating why", async () => {
    const failed: MobileAuditResult = {
      status: "timeout",
      durationMs: 10_000,
      message: "The mobile layout audit did not finish within 10000 ms.",
      artifactJson: JSON.stringify({
        status: "timeout",
        message: "The mobile layout audit did not finish within 10000 ms.",
      }),
    };
    const { d1, r2 } = await setup([
      { id: "p_old", url: "https://shop.example.test/old" }, // captured before the audit existed
      {
        id: "p_slow",
        url: "https://shop.example.test/slow",
        mobileLayout: failed,
      },
    ]);
    const summary = await runMobileChecks({ d1, r2, scanId: SCAN, nowMs: 5 });
    expect(summary.pagesChecked).toBe(0);
    expect(summary.pagesSkipped.map((s) => [s.pageId, s.reason])).toEqual([
      ["p_old", expect.stringContaining("No mobile layout audit was stored")],
      [
        "p_slow",
        "The mobile layout audit did not run: The mobile layout audit did not finish within 10000 ms.",
      ],
    ]);
    expect(occurrences(d1)).toEqual([]);
  });

  it("is idempotent and only replaces the mobile family", async () => {
    const { d1, r2 } = await setup([
      {
        id: "p_home",
        url: "https://shop.example.test/",
        mobileLayout: okResult(measurements({ documentWidth: 600 })),
      },
    ]);
    d1.sqlite
      .prepare(
        `INSERT INTO findings (id, scan_id, check_id, category, severity, effort, impact, priority_score, title, measured_value_json, threshold_json, fix_role, created_at, updated_at)
         VALUES ('f_seo', ?, 'seo.title.missing', 'seo', 'high', 'low', 'high', 70, 'x', '{}', '{}', 'content', 1, 1)`,
      )
      .run(SCAN);
    const first = await runMobileChecks({ d1, r2, scanId: SCAN, nowMs: 5 });
    const second = await runMobileChecks({ d1, r2, scanId: SCAN, nowMs: 6 });
    expect(second.findingsWritten).toBe(first.findingsWritten);
    const rows = d1.sqlite
      .prepare(
        `SELECT check_id FROM findings WHERE scan_id = ? ORDER BY check_id`,
      )
      .all(SCAN);
    expect(rows).toEqual([
      { check_id: "mobile.overflow.horizontal" },
      { check_id: "seo.title.missing" },
    ]);
  });

  it("never uses measurements from a failed audit, and cites only mobile crops", async () => {
    const m = measurements({
      documentWidth: 700,
      overflowingElements: [
        { selector: "#wide", x: 0, y: 10, width: 700, height: 40 },
      ],
    });
    // A failed audit that still carries partial measurements must be skipped.
    const failedWithData: MobileAuditResult = {
      status: "error",
      durationMs: 5,
      message: "Execution context was destroyed",
      artifactJson: JSON.stringify({
        status: "error",
        message: "Execution context was destroyed",
        measurements: m,
      }),
    };
    const { d1, r2 } = await setup([
      {
        id: "p_failed",
        url: "https://shop.example.test/f",
        mobileLayout: failedWithData,
      },
      {
        id: "p_ok",
        url: "https://shop.example.test/",
        mobileLayout: okResult(m),
      },
    ]);
    // A crop from another source with the same check and selector must not be cited.
    d1.sqlite
      .prepare(
        `INSERT INTO evidence_artifacts (id, scan_id, page_id, kind, r2_key, byte_size, sha256, metadata_json, created_at)
         VALUES ('ev_other_crop', ?, 'p_ok', 'screenshot_element', 'k/other', 1, ?, ?, 1)`,
      )
      .run(
        SCAN,
        "b".repeat(64),
        JSON.stringify({ source: "axe", check: "overflow", selector: "#wide" }),
      );
    const summary = await runMobileChecks({ d1, r2, scanId: SCAN, nowMs: 5 });
    expect(summary.pagesSkipped.map((s) => s.pageId)).toEqual(["p_failed"]);
    const rows = occurrences(d1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      page_id: "p_ok",
      selector: "#wide",
      kind: "screenshot_mobile",
    });
  });
});
