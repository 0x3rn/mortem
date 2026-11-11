import { describe, expect, it } from "vitest";
import {
  replaceFindingsByPrefix,
  type StoredFindingCandidate,
} from "./findings-store";
import { createSqliteD1, seedScanWithPages } from "./test-support";

async function setup() {
  const d1 = createSqliteD1(undefined, { withBatch: true });
  await seedScanWithPages(d1, {
    scanId: "scan_fs",
    origin: "https://acme.test",
    pages: [
      { id: "p_home", url: "https://acme.test/", templateType: "home" },
      { id: "p_about", url: "https://acme.test/about", templateType: "other" },
    ],
  });
  for (const pageId of ["p_home", "p_about"]) {
    d1.sqlite
      .prepare(
        `INSERT INTO evidence_artifacts (id, scan_id, page_id, kind, r2_key, byte_size, sha256, created_at)
         VALUES (?, 'scan_fs', ?, 'html', ?, 1, ?, 1)`,
      )
      .run(`${pageId}_ev_html`, pageId, `k/${pageId}`, "a".repeat(64));
  }
  return d1;
}

function candidate(
  ruleId: string,
  occurrences: StoredFindingCandidate["occurrences"],
): StoredFindingCandidate {
  return {
    ruleId,
    ruleVersion: "1.0.0",
    category: "seo",
    severity: "medium",
    effort: "low",
    impact: "medium",
    priorityScore: 45,
    title: ruleId,
    measured: { value: occurrences.length },
    threshold: { operator: "exists", target: true },
    fixRole: "content",
    occurrences,
  };
}

const count = (d1: Awaited<ReturnType<typeof setup>>, sql: string) =>
  (d1.sqlite.prepare(sql).get() as { n: number }).n;

describe("replaceFindingsByPrefix", () => {
  it("replaces only its own family and leaves other families untouched", async () => {
    const d1 = await setup();
    const occ = [
      { pageId: "p_home", evidenceArtifactId: "p_home_ev_html", excerpt: "x" },
    ];
    await replaceFindingsByPrefix({
      d1,
      scanId: "scan_fs",
      checkIdPrefix: "perf.",
      label: "performance",
      nowMs: 1,
      candidates: [
        { ...candidate("perf.lab.lcp", occ), category: "performance" },
      ],
    });
    await replaceFindingsByPrefix({
      d1,
      scanId: "scan_fs",
      checkIdPrefix: "seo.",
      label: "SEO",
      nowMs: 1,
      candidates: [candidate("seo.title.missing", occ)],
    });
    // Re-running SEO with nothing removes SEO findings but keeps performance.
    await replaceFindingsByPrefix({
      d1,
      scanId: "scan_fs",
      checkIdPrefix: "seo.",
      label: "SEO",
      nowMs: 2,
      candidates: [],
    });
    expect(
      count(
        d1,
        `SELECT COUNT(*) AS n FROM findings WHERE check_id LIKE 'seo.%'`,
      ),
    ).toBe(0);
    expect(
      count(
        d1,
        `SELECT COUNT(*) AS n FROM findings WHERE check_id LIKE 'perf.%'`,
      ),
    ).toBe(1);
  });

  it("refuses a rule outside the prefix and an unsafe prefix", async () => {
    const d1 = await setup();
    await expect(
      replaceFindingsByPrefix({
        d1,
        scanId: "scan_fs",
        checkIdPrefix: "seo.",
        label: "SEO",
        nowMs: 1,
        candidates: [candidate("perf.lab.lcp", [])],
      }),
    ).rejects.toThrow(/does not belong/);
    for (const bad of [
      "%",
      "seo",
      "seo.%",
      "SEO.",
      "",
      "_.",
      "1abc.",
      "a_b.",
    ]) {
      await expect(
        replaceFindingsByPrefix({
          d1,
          scanId: "scan_fs",
          checkIdPrefix: bad,
          label: "SEO",
          nowMs: 1,
          candidates: [],
        }),
      ).rejects.toThrow(/Invalid check id prefix/);
    }
  });

  it("gives repeated occurrences on the same page distinct ids instead of failing", async () => {
    const d1 = await setup();
    const result = await replaceFindingsByPrefix({
      d1,
      scanId: "scan_fs",
      checkIdPrefix: "seo.",
      label: "SEO",
      nowMs: 1,
      candidates: [
        candidate("seo.images.missing-alt", [
          {
            pageId: "p_home",
            evidenceArtifactId: "p_home_ev_html",
            excerpt: "a",
          },
          {
            pageId: "p_home",
            evidenceArtifactId: "p_home_ev_html",
            excerpt: "b",
          },
          {
            pageId: "p_about",
            evidenceArtifactId: "p_about_ev_html",
            excerpt: "c",
          },
        ]),
      ],
    });
    expect(result).toEqual({ findings: 1, occurrences: 3 });
    expect(count(d1, `SELECT COUNT(*) AS n FROM finding_occurrences`)).toBe(3);
  });

  it("wraps database failures in a typed error and rolls the whole batch back", async () => {
    const d1 = await setup();
    const good = [
      { pageId: "p_home", evidenceArtifactId: "p_home_ev_html", excerpt: "x" },
    ];
    await replaceFindingsByPrefix({
      d1,
      scanId: "scan_fs",
      checkIdPrefix: "seo.",
      label: "SEO",
      nowMs: 1,
      candidates: [candidate("seo.title.missing", good)],
    });
    await expect(
      replaceFindingsByPrefix({
        d1,
        scanId: "scan_fs",
        checkIdPrefix: "seo.",
        label: "SEO",
        nowMs: 2,
        candidates: [
          candidate("seo.h1.missing", [
            {
              pageId: "p_home",
              evidenceArtifactId: "missing_artifact",
              excerpt: "x",
            },
          ]),
        ],
      }),
    ).rejects.toMatchObject({
      name: "PlatformBindingError",
      code: "DATABASE_QUERY_FAILED",
    });
    // The previous SEO finding survived because the delete was rolled back too.
    expect(
      count(
        d1,
        `SELECT COUNT(*) AS n FROM findings WHERE check_id = 'seo.title.missing'`,
      ),
    ).toBe(1);
  });
});

describe("replaceFindingsByPrefix occurrence details", () => {
  it("accepts the a11y. prefix and stores selector and bounding box", async () => {
    const d1 = await setup();
    await replaceFindingsByPrefix({
      d1,
      scanId: "scan_fs",
      checkIdPrefix: "a11y.",
      label: "accessibility",
      nowMs: 1,
      candidates: [
        {
          ...candidate("a11y.image-alt", [
            {
              pageId: "p_home",
              evidenceArtifactId: "p_home_ev_html",
              excerpt: "desktop: <img>",
              selector: "#hero",
              bbox: { x: 1, y: 2, width: 200, height: 80, viewport: "desktop" },
              occurrenceKey: "desktop_0",
            },
            {
              pageId: "p_about",
              evidenceArtifactId: "p_about_ev_html",
              excerpt: "no selector",
            },
          ]),
          category: "accessibility",
        },
      ],
    });
    const rows = d1.sqlite
      .prepare(
        `SELECT page_id, selector, bbox_json FROM finding_occurrences ORDER BY page_id`,
      )
      .all() as Array<{
      page_id: string;
      selector: string | null;
      bbox_json: string | null;
    }>;
    expect(rows).toEqual([
      { page_id: "p_about", selector: null, bbox_json: null },
      {
        page_id: "p_home",
        selector: "#hero",
        bbox_json: JSON.stringify({
          x: 1,
          y: 2,
          width: 200,
          height: 80,
          viewport: "desktop",
        }),
      },
    ]);
  });
});
