import { describe, expect, it } from "vitest";
import { computeSha256Hex } from "./evidence-storage";
import {
  listPagePerformanceResults,
  runPerformanceChecks,
} from "./performance-checks";
import {
  createInMemoryR2,
  createSqliteD1,
  seedScanWithPages,
} from "./test-support";

/**
 * Live end-to-end check against the real PageSpeed Insights API (THE-180).
 * Skipped unless PAGESPEED_API_KEY is set in the environment, so CI and normal
 * runs never spend quota. Run it with:
 *
 *   PAGESPEED_API_KEY=... npx vitest run src/pagespeed.live.test.ts
 */
const apiKey = process.env.PAGESPEED_API_KEY?.trim();

describe.skipIf(!apiKey)("PageSpeed Insights live (real API)", () => {
  it("analyzes a real page end to end and stores honest, evidence-backed results", async () => {
    const d1 = createSqliteD1();
    const r2 = createInMemoryR2();
    await seedScanWithPages(d1, {
      scanId: "scan_live",
      origin: "https://info.cern.ch",
      pages: [
        {
          id: "page_live_home",
          url: "https://info.cern.ch/",
          templateType: "home",
          loadTimingsJson: JSON.stringify({ ttfbMs: 120 }),
        },
      ],
    });

    const summary = await runPerformanceChecks({
      d1,
      r2,
      scanId: "scan_live",
      apiKey,
      maxPages: 1,
    });

    const results = await listPagePerformanceResults(d1, "scan_live");
    console.info(
      "Live PSI results:",
      JSON.stringify(
        results.map((r) => ({
          strategy: r.strategy,
          status: r.status,
          reason: r.unavailableReason,
          lighthouse: r.lighthouseVersion,
          score: r.lab?.performanceScore ?? null,
          lcpMs: r.lab?.lcpMs ?? null,
          field: r.field?.available ? r.field.scope : "unavailable",
          audits: r.audits.map((a) => `${a.auditId}:${a.status}`),
        })),
        null,
        1,
      ),
    );

    // A live check must prove real data came back, not just a reason.
    expect(summary.resultsOk).toBeGreaterThan(0);
    // Every result is either real data or an explicit, typed reason.
    expect(summary.pagesAnalyzed).toBe(1);
    expect(summary.resultsOk + summary.resultsUnavailable).toBe(2);
    expect(summary.psiCalls).toBeGreaterThanOrEqual(2);
    for (const entry of summary.unavailable) {
      expect(entry.message.length).toBeGreaterThan(0);
    }

    expect(results).toHaveLength(2);
    for (const result of results) {
      if (result.status === "ok") {
        expect(result.lighthouseVersion).toMatch(/^\d+\.\d+\.\d+$/);
        expect(result.lab?.performanceScore).toBeGreaterThanOrEqual(0);
        expect(result.lab?.performanceScore).toBeLessThanOrEqual(100);
        expect(result.field).not.toBeNull();
        expect(result.audits).toHaveLength(6);
        // Raw response stored verbatim with a matching checksum.
        const row = d1.sqlite
          .prepare(`SELECT r2_key, sha256 FROM evidence_artifacts WHERE id = ?`)
          .get(result.psiEvidenceArtifactId!) as {
          r2_key: string;
          sha256: string;
        };
        const stored = r2.objects.get(row.r2_key)!;
        expect(await computeSha256Hex(stored.bytes)).toBe(row.sha256);
      } else {
        expect(result.lab).toBeNull();
        expect(result.unavailableReason).not.toBeNull();
      }
    }

    // The key never lands in D1 or R2.
    const everything =
      JSON.stringify(
        d1.sqlite.prepare(`SELECT * FROM page_performance_results`).all(),
      ) +
      JSON.stringify(
        d1.sqlite.prepare(`SELECT * FROM evidence_artifacts`).all(),
      ) +
      [...r2.objects.values()]
        .map((o) => new TextDecoder().decode(o.bytes))
        .join("");
    expect(everything).not.toContain(apiKey!);
  }, 600_000);
});
