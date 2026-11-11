import { describe, expect, it } from "vitest";
import { HTML_TRUNCATION_MARKER } from "./browser-capture";
import type { R2BucketLike } from "./cloudflare";
import { persistPageCaptureEvidenceToR2AndD1 } from "./evidence-storage";
import { runSeoChecks } from "./seo-checks-runner";
import {
  buildCaptureResult,
  createInMemoryR2,
  createSqliteD1,
  seedScanWithPages,
} from "./test-support";

/*
 * Evidence is written with the production writer (persistPageCaptureEvidenceToR2AndD1),
 * so these tests also pin the storage contract between capture and SEO checks.
 */

const head = (
  title: string,
  description: string,
  canonical: string,
  extra = "",
) => `
<title>${title}</title>
<meta name="description" content="${description}">
<link rel="canonical" href="${canonical}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:image" content="https://acme.test/og.png">
<meta property="og:url" content="${canonical}">
<meta name="twitter:card" content="summary_large_image">${extra}`;

const page = (headHtml: string, body = "<h1>Acme</h1><h2>Section</h2>") =>
  `<!doctype html><html lang="en"><head>${headHtml}</head><body>${body}</body></html>`;

const SHARED_TITLE = "Acme Analytics — Product analytics for small teams";
const SHARED_DESCRIPTION =
  "Acme Analytics shows small teams which features customers use, where they drop off, and what to fix next.";

async function setup(
  pages: Array<{
    id: string;
    url: string;
    html: string;
    headers?: Record<string, string>;
    sources?: string[];
    storeEvidence?: boolean;
  }>,
) {
  const d1 = createSqliteD1();
  const r2 = createInMemoryR2();
  await seedScanWithPages(d1, {
    scanId: "scan_seo",
    origin: "https://acme.test",
    pages: pages.map((p) => ({ id: p.id, url: p.url, templateType: "other" })),
  });
  for (const p of pages) {
    d1.sqlite
      .prepare(`UPDATE pages SET discovery_sources_json = ? WHERE id = ?`)
      .run(JSON.stringify(p.sources ?? ["internal_link"]), p.id);
    if (p.storeEvidence === false) continue;
    await persistPageCaptureEvidenceToR2AndD1({
      d1,
      r2,
      scanId: "scan_seo",
      pageId: p.id,
      capture: buildCaptureResult({
        url: p.url,
        html: p.html,
        headers: p.headers,
      }),
      nowMs: 1,
    });
  }
  return { d1, r2 };
}

const SITE = [
  {
    id: "p_home",
    url: "https://acme.test/",
    html: page(head(SHARED_TITLE, SHARED_DESCRIPTION, "https://acme.test/")),
  },
  {
    id: "p_about",
    url: "https://acme.test/about",
    html: page(
      head(
        SHARED_TITLE,
        "About Acme Analytics: who we are, why we built it and the small team behind the product.",
        "https://acme.test/about",
      ),
    ),
  },
  {
    id: "p_old",
    url: "https://acme.test/old-pricing",
    html: page(
      head(
        "Old pricing page for Acme Analytics customers",
        "Our previous pricing for Acme Analytics, kept for existing customers on legacy plans and contracts.",
        "https://acme.test/old-pricing",
      ),
    ),
    headers: { "content-type": "text/html", "X-Robots-Tag": "noindex" },
    sources: ["sitemap"],
  },
];

const rows = (
  d1: ReturnType<typeof createSqliteD1>,
  sql: string,
  ...args: unknown[]
) =>
  d1.sqlite.prepare(sql).all(...(args as never[])) as Record<string, unknown>[];

describe("runSeoChecks", () => {
  it("reads stored evidence, writes evidence-backed SEO findings and cites the right artifact", async () => {
    const { d1, r2 } = await setup(SITE);
    const summary = await runSeoChecks({
      d1,
      r2,
      scanId: "scan_seo",
      nowMs: 5,
    });

    expect(summary).toMatchObject({
      pagesConsidered: 3,
      pagesAnalyzed: 3,
      pagesSkipped: [],
    });
    expect([...summary.rulesFired].sort()).toEqual([
      "seo.indexability.noindex",
      "seo.indexability.sitemap-conflict",
      "seo.title.duplicate",
    ]);

    // Duplicate title: every affected URL and the exact text are stored.
    const dup = rows(
      d1,
      `SELECT measured_value_json FROM findings WHERE check_id = 'seo.title.duplicate'`,
    )[0]!;
    const measured = JSON.parse(String(dup.measured_value_json));
    expect(measured.value).toBe(2);
    expect(measured.rawContext.affectedUrls).toEqual([
      "https://acme.test/",
      "https://acme.test/about",
    ]);
    expect(measured.rawContext.details).toEqual([
      {
        text: SHARED_TITLE,
        urls: ["https://acme.test/", "https://acme.test/about"],
      },
    ]);

    // Header-based noindex cites the headers artifact; title duplicates cite HTML.
    const cited = rows(
      d1,
      `SELECT f.check_id, o.page_id, a.kind, o.excerpt
       FROM finding_occurrences o
       JOIN findings f ON f.id = o.finding_id
       JOIN evidence_artifacts a ON a.id = o.evidence_artifact_id
       ORDER BY f.check_id, o.page_id`,
    );
    expect(cited).toEqual([
      {
        check_id: "seo.indexability.noindex",
        page_id: "p_old",
        kind: "headers",
        excerpt: "noindex set by X-Robots-Tag header.",
      },
      {
        check_id: "seo.indexability.sitemap-conflict",
        page_id: "p_old",
        kind: "headers",
        excerpt:
          "Listed in the XML sitemap but marked noindex by X-Robots-Tag header.",
      },
      expect.objectContaining({
        check_id: "seo.title.duplicate",
        page_id: "p_about",
        kind: "html",
      }),
      expect.objectContaining({
        check_id: "seo.title.duplicate",
        page_id: "p_home",
        kind: "html",
      }),
    ]);
    for (const row of cited.filter(
      (r) => r.check_id === "seo.title.duplicate",
    )) {
      expect(row.excerpt).toContain(`"${SHARED_TITLE}"`);
    }
  });

  it("skips pages without stored HTML, with a reason, and still analyzes the rest", async () => {
    const { d1, r2 } = await setup([
      ...SITE.slice(0, 2),
      {
        id: "p_nohtml",
        url: "https://acme.test/x",
        html: "",
        storeEvidence: false,
      },
    ]);
    const summary = await runSeoChecks({ d1, r2, scanId: "scan_seo" });
    expect(summary.pagesAnalyzed).toBe(2);
    expect(summary.pagesSkipped).toEqual([
      {
        pageId: "p_nohtml",
        pageUrl: "https://acme.test/x",
        reason: "No HTML snapshot was stored for this page.",
      },
    ]);
  });

  it("reports an HTML object that D1 references but R2 no longer has", async () => {
    const { d1, r2 } = await setup(SITE.slice(0, 1));
    r2.objects.delete("scans/scan_seo/pages/p_home/html.html");
    const summary = await runSeoChecks({ d1, r2, scanId: "scan_seo" });
    expect(summary.pagesAnalyzed).toBe(0);
    expect(summary.pagesSkipped[0]!.reason).toContain("missing from R2");
  });

  it("fails closed with a typed error when the R2 binding cannot read objects", async () => {
    const { d1, r2 } = await setup(SITE.slice(0, 1));
    const writeOnly: R2BucketLike = { put: r2.put, head: r2.head };
    await expect(
      runSeoChecks({ d1, r2: writeOnly, scanId: "scan_seo" }),
    ).rejects.toMatchObject({
      name: "PlatformBindingError",
      code: "MISSING_BINDING",
    });
  });

  it("does not claim a missing H1 on a truncated snapshot", async () => {
    const truncated = page(
      head(SHARED_TITLE, SHARED_DESCRIPTION, "https://acme.test/"),
      `<p>…</p>\n${HTML_TRUNCATION_MARKER}`,
    );
    const { d1, r2 } = await setup([
      { id: "p_home", url: "https://acme.test/", html: truncated },
    ]);
    const summary = await runSeoChecks({ d1, r2, scanId: "scan_seo" });
    expect(summary.rulesFired).not.toContain("seo.h1.missing");

    const { d1: d1b, r2: r2b } = await setup([
      {
        id: "p_home",
        url: "https://acme.test/",
        html: truncated.replace(HTML_TRUNCATION_MARKER, ""),
      },
    ]);
    expect(
      (await runSeoChecks({ d1: d1b, r2: r2b, scanId: "scan_seo" })).rulesFired,
    ).toContain("seo.h1.missing");
  });

  it("does not flag a sitemap conflict when discovery did not see the page in the sitemap", async () => {
    const { d1, r2 } = await setup([
      { ...SITE[2]!, sources: ["internal_link"] },
    ]);
    const summary = await runSeoChecks({ d1, r2, scanId: "scan_seo" });
    expect(summary.rulesFired).toEqual(["seo.indexability.noindex"]);
  });

  it("treats pages discovered before migration 0005 ('[]') as not known to be in the sitemap", async () => {
    const { d1, r2 } = await setup([{ ...SITE[2]!, sources: [] }]);
    const summary = await runSeoChecks({ d1, r2, scanId: "scan_seo" });
    expect(summary.rulesFired).not.toContain(
      "seo.indexability.sitemap-conflict",
    );
  });

  it("is idempotent and leaves performance findings alone", async () => {
    const { d1, r2 } = await setup(SITE);
    d1.sqlite
      .prepare(
        `INSERT INTO findings (id, scan_id, check_id, category, severity, effort, impact, priority_score,
                               title, measured_value_json, threshold_json, fix_role, created_at, updated_at)
         VALUES ('f_perf', 'scan_seo', 'perf.lab.lcp', 'performance', 'high', 'medium', 'high', 70,
                 'Slow LCP', '{}', '{}', 'developer', 1, 1)`,
      )
      .run();
    const snapshot = () => ({
      seo: rows(
        d1,
        `SELECT COUNT(*) AS n FROM findings WHERE check_id LIKE 'seo.%'`,
      )[0]!.n,
      occurrences: rows(d1, `SELECT COUNT(*) AS n FROM finding_occurrences`)[0]!
        .n,
      perf: rows(
        d1,
        `SELECT COUNT(*) AS n FROM findings WHERE check_id LIKE 'perf.%'`,
      )[0]!.n,
    });
    await runSeoChecks({ d1, r2, scanId: "scan_seo" });
    const first = snapshot();
    await runSeoChecks({ d1, r2, scanId: "scan_seo" });
    expect(snapshot()).toEqual(first);
    expect(first).toEqual({ seo: 3, occurrences: 4, perf: 1 });
  });

  it("does nothing for a scan with no captured pages", async () => {
    const d1 = createSqliteD1();
    const r2 = createInMemoryR2();
    await seedScanWithPages(d1, {
      scanId: "scan_seo",
      origin: "https://acme.test",
      pages: [
        { id: "p_fail", url: "https://acme.test/", captureStatus: "failed" },
      ],
    });
    expect(await runSeoChecks({ d1, r2, scanId: "scan_seo" })).toEqual({
      pagesConsidered: 0,
      pagesAnalyzed: 0,
      pagesSkipped: [],
      findingsWritten: 0,
      occurrencesWritten: 0,
      rulesFired: [],
    });
  });
});
