import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PlatformBindingError } from "./cloudflare";
import { computeSha256Hex } from "./evidence-storage";
import {
  listPagePerformanceResults,
  replacePerformanceFindings,
  runPerformanceChecks,
  selectPagesForPerformanceAnalysis,
  type PerformanceCandidatePage,
} from "./performance-checks";
import { parsePsiResponse, PERFORMANCE_RULE_IDS } from "./pagespeed";
import {
  MIGRATION_FILES,
  createInMemoryR2,
  createSqliteD1,
  seedScanWithPages,
} from "./test-support";

const FIXTURE_DIR = resolve(__dirname, "__fixtures__/psi");
const fixture = (name: string): string =>
  readFileSync(resolve(FIXTURE_DIR, name), "utf8");

// Real recorded PageSpeed responses (Lighthouse 13.6.0): a slow page and a healthy one.
const MOBILE_SLOW = fixture("recorded-www.cnn.com-mobile.json");
const DESKTOP_FAST = fixture("recorded-info.cern.ch-desktop.json");
const RUNTIME_ERROR = fixture("synthetic-runtime-error-unreachable.json");
const QUOTA_429 = fixture("recorded-quota-exceeded-429.json");

const API_KEY = "AIzaSyTESTKEY-persist-0123456789";
const noSleep = async (): Promise<void> => undefined;

function json(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });
}

type PsiResponder = (
  strategy: "MOBILE" | "DESKTOP",
  pageUrl: string,
) => Response;

function psiFetch(responder: PsiResponder): {
  fetchFn: typeof fetch;
  calls: Array<{ strategy: string; pageUrl: string }>;
  peakInFlight: () => number;
} {
  const calls: Array<{ strategy: string; pageUrl: string }> = [];
  let inFlight = 0;
  let peak = 0;
  const fetchFn = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const strategy = url.searchParams.get("strategy") as "MOBILE" | "DESKTOP";
    const pageUrl = url.searchParams.get("url") ?? "";
    calls.push({ strategy, pageUrl });
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 2));
    inFlight -= 1;
    return responder(strategy, pageUrl);
  }) as typeof fetch;
  return { fetchFn, calls, peakInFlight: () => peak };
}

const slowMobileFastDesktop: PsiResponder = (strategy) =>
  strategy === "MOBILE" ? json(MOBILE_SLOW) : json(DESKTOP_FAST);

const TIMINGS = JSON.stringify({
  ttfbMs: 180,
  fcpMs: 900,
  lcpMs: 1500,
  cls: 0.02,
});

const SITE_PAGES = [
  {
    id: "p_home",
    url: "https://shop.example.test/",
    templateType: "home",
    loadTimingsJson: TIMINGS,
  },
  {
    id: "p_pricing",
    url: "https://shop.example.test/pricing",
    templateType: "pricing",
    loadTimingsJson: TIMINGS,
  },
  {
    id: "p_blog",
    url: "https://shop.example.test/blog",
    templateType: "blog",
    loadTimingsJson: TIMINGS,
  },
  {
    id: "p_other",
    url: "https://shop.example.test/about",
    templateType: "other",
    loadTimingsJson: TIMINGS,
  },
  {
    id: "p_skipped",
    url: "https://shop.example.test/private",
    templateType: "contact",
    captureStatus: "skipped",
  },
];

async function setup(options: { withBatch?: boolean } = {}) {
  const d1 = createSqliteD1(undefined, options);
  const r2 = createInMemoryR2();
  await seedScanWithPages(d1, {
    scanId: "scan_1",
    origin: "https://shop.example.test",
    pages: SITE_PAGES,
  });
  return { d1, r2 };
}

function count(
  d1: ReturnType<typeof createSqliteD1>,
  sql: string,
  ...args: unknown[]
): number {
  const row = d1.sqlite.prepare(sql).get(...(args as never[])) as { n: number };
  return row.n;
}

describe("selectPagesForPerformanceAnalysis", () => {
  const page = (
    id: string,
    templateType: PerformanceCandidatePage["templateType"],
    createdAt = 1,
  ): PerformanceCandidatePage => ({
    id,
    url: `https://x.test/${id}`,
    templateType,
    createdAt,
  });

  it("puts the homepage first, then one page per template by priority, capped", () => {
    const selected = selectPagesForPerformanceAnalysis(
      [
        page("a", "blog"),
        page("b", "other"),
        page("c", "home"),
        page("d", "pricing"),
        page("e", "pricing", 2),
      ],
      3,
    );
    expect(selected.map((p) => p.id)).toEqual(["c", "d", "a"]);
  });

  it("keeps only the earliest page of a repeated template", () => {
    const selected = selectPagesForPerformanceAnalysis(
      [page("late", "other", 9), page("early", "other", 1)],
      5,
    );
    expect(selected.map((p) => p.id)).toEqual(["early"]);
  });

  it("handles empty input and non-positive caps", () => {
    expect(selectPagesForPerformanceAnalysis([], 3)).toEqual([]);
    expect(selectPagesForPerformanceAnalysis([page("a", "home")], 0)).toEqual(
      [],
    );
    expect(selectPagesForPerformanceAnalysis([page("a", "home")], -2)).toEqual(
      [],
    );
  });
});

describe("migration 0004 constraints", () => {
  function insertRow(
    d1: ReturnType<typeof createSqliteD1>,
    overrides: Record<string, unknown>,
  ): void {
    const base: Record<string, unknown> = {
      id: "r1",
      scan_id: "scan_1",
      page_id: "p_home",
      strategy: "mobile",
      status: "ok",
      unavailable_reason: null,
      unavailable_message: null,
      lab_json: "{}",
      field_json: "{}",
      ...overrides,
    };
    d1.sqlite
      .prepare(
        `INSERT INTO page_performance_results
           (id, scan_id, page_id, strategy, status, unavailable_reason, unavailable_message,
            lab_json, field_json, created_at, updated_at)
         VALUES (@id, @scan_id, @page_id, @strategy, @status, @unavailable_reason, @unavailable_message,
                 @lab_json, @field_json, 1, 1)`,
      )
      .run(base as never);
  }

  it("rejects an ok row without lab data and an unavailable row without a reason", async () => {
    const { d1 } = await setup();
    expect(() => insertRow(d1, { lab_json: null })).toThrow(/CHECK/i);
    expect(() =>
      insertRow(d1, {
        status: "unavailable",
        lab_json: null,
        field_json: null,
      }),
    ).toThrow(/CHECK/i);
    expect(() =>
      insertRow(d1, {
        status: "unavailable",
        unavailable_reason: "quota_exceeded",
        unavailable_message: "  ",
        lab_json: null,
        field_json: null,
      }),
    ).toThrow(/CHECK/i);
    // An unavailable row must not smuggle lab data in.
    expect(() =>
      insertRow(d1, {
        status: "unavailable",
        unavailable_reason: "timeout",
        unavailable_message: "timed out",
      }),
    ).toThrow(/CHECK/i);
  });

  it("rejects unknown strategies and reasons and enforces one row per page and strategy", async () => {
    const { d1 } = await setup();
    expect(() => insertRow(d1, { strategy: "tablet" })).toThrow(/CHECK/i);
    expect(() =>
      insertRow(d1, {
        status: "unavailable",
        unavailable_reason: "made_up",
        unavailable_message: "x",
        lab_json: null,
        field_json: null,
      }),
    ).toThrow(/CHECK/i);
    insertRow(d1, {});
    expect(() => insertRow(d1, { id: "r2" })).toThrow(/UNIQUE/i);
  });
});

describe("runPerformanceChecks", () => {
  it("analyzes the prioritized pages for both strategies and stores raw evidence, metrics and findings", async () => {
    const { d1, r2 } = await setup();
    const psi = psiFetch(slowMobileFastDesktop);

    const summary = await runPerformanceChecks({
      d1,
      r2,
      scanId: "scan_1",
      apiKey: API_KEY,
      fetchFn: psi.fetchFn,
      sleep: noSleep,
      maxPages: 3,
      concurrency: 2,
      nowMs: 1_760_000_100_000,
    });

    // Captured pages only (the skipped page is not a candidate); cap 3 => home, pricing, blog.
    expect(summary).toMatchObject({
      pagesConsidered: 4,
      pagesAnalyzed: 3,
      resultsOk: 6,
      resultsUnavailable: 0,
      psiCalls: 6,
      partial: false,
      unavailable: [],
    });
    expect(new Set(psi.calls.map((c) => c.pageUrl))).toEqual(
      new Set([
        "https://shop.example.test/",
        "https://shop.example.test/pricing",
        "https://shop.example.test/blog",
      ]),
    );
    expect(psi.calls.filter((c) => c.strategy === "MOBILE")).toHaveLength(3);
    expect(psi.peakInFlight()).toBeLessThanOrEqual(2);

    // Raw responses are stored verbatim in R2 with matching D1 checksums.
    const evidence = d1.sqlite
      .prepare(
        `SELECT id, page_id, r2_key, sha256, byte_size, metadata_json FROM evidence_artifacts WHERE kind = 'psi_raw' ORDER BY id`,
      )
      .all() as Array<{
      id: string;
      page_id: string;
      r2_key: string;
      sha256: string;
      byte_size: number;
      metadata_json: string;
    }>;
    expect(evidence).toHaveLength(6);
    for (const row of evidence) {
      const stored = r2.objects.get(row.r2_key);
      expect(stored, row.r2_key).toBeDefined();
      expect(await computeSha256Hex(stored!.bytes)).toBe(row.sha256);
      expect(row.byte_size).toBe(stored!.bytes.byteLength);
      expect(row.r2_key).toMatch(
        /^scans\/scan_1\/pages\/p_[a-z]+\/psi_raw_(mobile|desktop)\.json$/,
      );
    }
    const mobileBody = r2.objects.get(
      "scans/scan_1/pages/p_home/psi_raw_mobile.json",
    )!;
    expect(new TextDecoder().decode(mobileBody.bytes)).toBe(MOBILE_SLOW);

    // Per-page results: lab and field are separate, the unavailable CrUX case is explicit.
    const results = await listPagePerformanceResults(d1, "scan_1");
    expect(results).toHaveLength(6);
    const homeMobile = results.find(
      (r) => r.pageId === "p_home" && r.strategy === "mobile",
    )!;
    expect(homeMobile).toMatchObject({
      status: "ok",
      lighthouseVersion: "13.6.0",
      psiEvidenceArtifactId: "p_home_ev_psi_raw_mobile",
      navigationTimings: null,
    });
    expect(homeMobile.lab).toMatchObject({
      performanceScore: 36,
      lcpMs: 21367.50368044048,
    });
    expect(homeMobile.field).toMatchObject({ available: true, scope: "url" });
    expect(homeMobile.audits.map((a) => a.auditId)).toHaveLength(6);

    const homeDesktop = results.find(
      (r) => r.pageId === "p_home" && r.strategy === "desktop",
    )!;
    expect(homeDesktop.field).toMatchObject({
      available: true,
      scope: "url",
    });
    // Browser Run timings supplement the desktop row only and are labelled as such.
    expect(homeDesktop.navigationTimings).toMatchObject({
      source: "browser_run",
      viewport: "desktop",
      ttfbMs: 180,
    });

    // Findings: one per fired rule, with an occurrence per page for the slow mobile strategy.
    expect(summary.findingsWritten).toBe(9);
    expect(summary.occurrencesWritten).toBe(9 * 3);
    const checkIds = (
      d1.sqlite
        .prepare(`SELECT check_id FROM findings WHERE scan_id = 'scan_1'`)
        .all() as Array<{ check_id: string }>
    ).map((r) => r.check_id);
    expect(new Set(checkIds).size).toBe(9);
    for (const id of checkIds) expect(PERFORMANCE_RULE_IDS).toContain(id);

    // Every occurrence cites a stored mobile psi_raw artifact of its own page.
    const occurrences = d1.sqlite
      .prepare(
        `SELECT o.page_id, o.evidence_artifact_id, o.excerpt, a.kind, a.page_id AS evidence_page
         FROM finding_occurrences o JOIN evidence_artifacts a ON a.id = o.evidence_artifact_id`,
      )
      .all() as Array<{
      page_id: string;
      evidence_artifact_id: string;
      excerpt: string;
      kind: string;
      evidence_page: string;
    }>;
    expect(occurrences).toHaveLength(27);
    for (const occurrence of occurrences) {
      expect(occurrence.kind).toBe("psi_raw");
      expect(occurrence.evidence_page).toBe(occurrence.page_id);
      expect(occurrence.evidence_artifact_id).toMatch(/_ev_psi_raw_mobile$/);
    }

    // Usage the worker records against quota.
    expect(summary.r2BytesWritten).toBeGreaterThan(0);
  });

  it("returns partial data with an explicit reason when one strategy hits the daily quota", async () => {
    const { d1, r2 } = await setup();
    const psi = psiFetch((strategy) =>
      strategy === "MOBILE" ? json(MOBILE_SLOW) : json(QUOTA_429, 429),
    );

    const summary = await runPerformanceChecks({
      d1,
      r2,
      scanId: "scan_1",
      apiKey: API_KEY,
      fetchFn: psi.fetchFn,
      sleep: noSleep,
      maxPages: 1,
    });

    expect(summary).toMatchObject({
      pagesAnalyzed: 1,
      resultsOk: 1,
      resultsUnavailable: 1,
      partial: true,
      psiCalls: 2, // one mobile call, one desktop call (daily quota is not retried)
    });
    expect(summary.unavailable[0]).toMatchObject({
      pageId: "p_home",
      strategy: "desktop",
      reason: "quota_exceeded",
    });

    const results = await listPagePerformanceResults(d1, "scan_1");
    const desktop = results.find((r) => r.strategy === "desktop")!;
    // No Lighthouse score, no field data, no evidence — but the supplementary timings remain.
    expect(desktop).toMatchObject({
      status: "unavailable",
      unavailableReason: "quota_exceeded",
      lab: null,
      field: null,
      psiEvidenceArtifactId: null,
    });
    expect(desktop.unavailableMessage).toContain("Queries per day");
    expect(desktop.navigationTimings).toMatchObject({
      source: "browser_run",
      ttfbMs: 180,
    });
    // Mobile data still produced findings.
    expect(summary.findingsWritten).toBeGreaterThan(0);
    expect(
      count(
        d1,
        `SELECT COUNT(*) AS n FROM evidence_artifacts WHERE kind = 'psi_raw'`,
      ),
    ).toBe(1);
  });

  it("records api_key_missing for every result and never calls the network without a key", async () => {
    const { d1, r2 } = await setup();
    const fetchFn = vi.fn() as unknown as typeof fetch;

    const summary = await runPerformanceChecks({
      d1,
      r2,
      scanId: "scan_1",
      apiKey: undefined,
      fetchFn,
      maxPages: 3,
    });

    expect(fetchFn).not.toHaveBeenCalled();
    expect(summary).toMatchObject({
      resultsOk: 0,
      resultsUnavailable: 6,
      psiCalls: 0,
      findingsWritten: 0,
      partial: true,
    });
    expect(
      summary.unavailable.every((u) => u.reason === "api_key_missing"),
    ).toBe(true);
    expect(r2.objects.size).toBe(0);
    expect(count(d1, `SELECT COUNT(*) AS n FROM findings`)).toBe(0);
    expect(
      count(
        d1,
        `SELECT COUNT(*) AS n FROM page_performance_results WHERE status = 'unavailable'`,
      ),
    ).toBe(6);
  });

  it("keeps the raw response as evidence when Lighthouse reports a runtime error, without inventing metrics", async () => {
    const { d1, r2 } = await setup();
    const psi = psiFetch(() => json(RUNTIME_ERROR));

    const summary = await runPerformanceChecks({
      d1,
      r2,
      scanId: "scan_1",
      apiKey: API_KEY,
      fetchFn: psi.fetchFn,
      sleep: noSleep,
      maxPages: 1,
    });

    expect(summary).toMatchObject({
      resultsOk: 0,
      resultsUnavailable: 2,
      findingsWritten: 0,
    });
    expect(
      summary.unavailable.every((u) => u.reason === "target_unreachable"),
    ).toBe(true);
    const results = await listPagePerformanceResults(d1, "scan_1");
    for (const result of results) {
      expect(result.lab).toBeNull();
      expect(result.psiEvidenceArtifactId).toMatch(/_ev_psi_raw_/);
    }
    expect(r2.objects.size).toBe(2);
  });

  it("is idempotent: running the same scan twice yields identical rows", async () => {
    const { d1, r2 } = await setup();
    const run = () =>
      runPerformanceChecks({
        d1,
        r2,
        scanId: "scan_1",
        apiKey: API_KEY,
        fetchFn: psiFetch(slowMobileFastDesktop).fetchFn,
        sleep: noSleep,
        maxPages: 2,
      });

    const first = await run();
    const snapshot = () => ({
      results: count(d1, `SELECT COUNT(*) AS n FROM page_performance_results`),
      evidence: count(
        d1,
        `SELECT COUNT(*) AS n FROM evidence_artifacts WHERE kind = 'psi_raw'`,
      ),
      findings: count(d1, `SELECT COUNT(*) AS n FROM findings`),
      occurrences: count(d1, `SELECT COUNT(*) AS n FROM finding_occurrences`),
      objects: r2.objects.size,
    });
    const afterFirst = snapshot();
    const second = await run();

    expect(snapshot()).toEqual(afterFirst);
    expect(second.findingsWritten).toBe(first.findingsWritten);
    expect(afterFirst).toEqual({
      results: 4,
      evidence: 4,
      findings: 9,
      occurrences: 18,
      objects: 4,
    });
  });

  it("clears stale performance findings when a re-run no longer breaches, leaving other categories alone", async () => {
    const { d1, r2 } = await setup();
    await runPerformanceChecks({
      d1,
      r2,
      scanId: "scan_1",
      apiKey: API_KEY,
      fetchFn: psiFetch(slowMobileFastDesktop).fetchFn,
      sleep: noSleep,
      maxPages: 1,
    });
    expect(count(d1, `SELECT COUNT(*) AS n FROM findings`)).toBe(9);

    // A finding owned by another check must survive a performance rewrite.
    d1.sqlite
      .prepare(
        `INSERT INTO findings (id, scan_id, check_id, category, severity, effort, impact, priority_score,
                               title, measured_value_json, threshold_json, fix_role, created_at, updated_at)
         VALUES ('f_seo', 'scan_1', 'seo.title.missing', 'seo', 'high', 'low', 'high', 70,
                 'Missing title', '{}', '{}', 'content', 1, 1)`,
      )
      .run();

    const summary = await runPerformanceChecks({
      d1,
      r2,
      scanId: "scan_1",
      apiKey: API_KEY,
      fetchFn: psiFetch(() => json(DESKTOP_FAST)).fetchFn,
      sleep: noSleep,
      maxPages: 1,
    });

    expect(summary.findingsWritten).toBe(0);
    expect(
      count(
        d1,
        `SELECT COUNT(*) AS n FROM findings WHERE check_id LIKE 'perf.%'`,
      ),
    ).toBe(0);
    expect(
      count(
        d1,
        `SELECT COUNT(*) AS n FROM findings WHERE check_id = 'seo.title.missing'`,
      ),
    ).toBe(1);
    expect(count(d1, `SELECT COUNT(*) AS n FROM finding_occurrences`)).toBe(0);
  });

  it("does nothing (and calls nothing) when the scan has no captured pages", async () => {
    const d1 = createSqliteD1();
    const r2 = createInMemoryR2();
    await seedScanWithPages(d1, {
      scanId: "scan_empty",
      origin: "https://empty.example.test",
      pages: [
        {
          id: "p_fail",
          url: "https://empty.example.test/",
          templateType: "home",
          captureStatus: "failed",
        },
      ],
    });
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const summary = await runPerformanceChecks({
      d1,
      r2,
      scanId: "scan_empty",
      apiKey: API_KEY,
      fetchFn,
    });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(summary).toMatchObject({
      pagesConsidered: 0,
      pagesAnalyzed: 0,
      psiCalls: 0,
      partial: false,
      findingsWritten: 0,
    });
  });

  it("surfaces D1 write failures as a typed PlatformBindingError instead of swallowing them", async () => {
    // Migration 0004 deliberately not applied: the result table does not exist.
    const d1 = createSqliteD1([MIGRATION_FILES.auth, MIGRATION_FILES.scans]);
    const r2 = createInMemoryR2();
    await seedScanWithPages(d1, {
      scanId: "scan_1",
      origin: "https://shop.example.test",
      pages: [
        {
          id: "p_home",
          url: "https://shop.example.test/",
          templateType: "home",
        },
      ],
    });
    await expect(
      runPerformanceChecks({
        d1,
        r2,
        scanId: "scan_1",
        apiKey: API_KEY,
        fetchFn: psiFetch(slowMobileFastDesktop).fetchFn,
        sleep: noSleep,
        maxPages: 1,
      }),
    ).rejects.toMatchObject({
      name: "PlatformBindingError",
      code: "DATABASE_QUERY_FAILED",
    });
  });

  it("cascades result rows away when the scan is deleted", async () => {
    const { d1, r2 } = await setup();
    await runPerformanceChecks({
      d1,
      r2,
      scanId: "scan_1",
      apiKey: API_KEY,
      fetchFn: psiFetch(slowMobileFastDesktop).fetchFn,
      sleep: noSleep,
      maxPages: 1,
    });
    expect(
      count(d1, `SELECT COUNT(*) AS n FROM page_performance_results`),
    ).toBe(2);
    d1.sqlite.prepare(`DELETE FROM scans WHERE id = 'scan_1'`).run();
    expect(
      count(d1, `SELECT COUNT(*) AS n FROM page_performance_results`),
    ).toBe(0);
    expect(count(d1, `SELECT COUNT(*) AS n FROM findings`)).toBe(0);
  });
});

describe("replacePerformanceFindings", () => {
  async function parsedInput(pageId: string) {
    const parsed = parsePsiResponse(JSON.parse(MOBILE_SLOW), "mobile");
    if (!parsed.ok) throw new Error("fixture must parse");
    return {
      pageId,
      pageUrl: "https://shop.example.test/",
      strategy: "mobile" as const,
      evidenceArtifactId: `${pageId}_ev_psi_raw_mobile`,
      data: parsed.data,
    };
  }

  it("writes the delete and all inserts in a single atomic batch when D1 supports it", async () => {
    const { d1, r2 } = await setup({ withBatch: true });
    await runPerformanceChecks({
      d1,
      r2,
      scanId: "scan_1",
      apiKey: API_KEY,
      fetchFn: psiFetch(slowMobileFastDesktop).fetchFn,
      sleep: noSleep,
      maxPages: 1,
    });
    expect(d1.batchCalls).toBe(1);
    expect(count(d1, `SELECT COUNT(*) AS n FROM findings`)).toBe(9);
  });

  it("rolls back entirely, keeping the previous findings, if any statement in the batch fails", async () => {
    const { d1, r2 } = await setup({ withBatch: true });
    await runPerformanceChecks({
      d1,
      r2,
      scanId: "scan_1",
      apiKey: API_KEY,
      fetchFn: psiFetch(slowMobileFastDesktop).fetchFn,
      sleep: noSleep,
      maxPages: 1,
    });
    const before = count(d1, `SELECT COUNT(*) AS n FROM findings`);

    // Evidence id that does not exist => FK violation on the occurrence insert.
    const input = await parsedInput("p_home");
    await expect(
      replacePerformanceFindings({
        d1,
        scanId: "scan_1",
        inputs: [{ ...input, evidenceArtifactId: "does_not_exist" }],
        nowMs: 2,
      }),
    ).rejects.toBeInstanceOf(PlatformBindingError);

    expect(count(d1, `SELECT COUNT(*) AS n FROM findings`)).toBe(before);
  });
});

describe("runPerformanceChecks stage time budget", () => {
  it("records timeout for calls that cannot start within the budget instead of running past it", async () => {
    const { d1, r2 } = await setup();
    const fetchFn = vi.fn() as unknown as typeof fetch;

    const summary = await runPerformanceChecks({
      d1,
      r2,
      scanId: "scan_1",
      apiKey: API_KEY,
      fetchFn,
      maxPages: 2,
      budgetMs: 5_000, // less than the 10 s minimum needed to start any call
    });

    expect(fetchFn).not.toHaveBeenCalled();
    expect(summary).toMatchObject({
      resultsOk: 0,
      resultsUnavailable: 4,
      psiCalls: 0,
      partial: true,
    });
    expect(summary.unavailable.every((u) => u.reason === "timeout")).toBe(true);
    expect(
      count(
        d1,
        `SELECT COUNT(*) AS n FROM page_performance_results WHERE unavailable_reason = 'timeout' AND lab_json IS NULL`,
      ),
    ).toBe(4);
  });

  it("lets early calls finish and records only the ones that ran out of budget", async () => {
    const { d1, r2 } = await setup();
    let clock = 1_000_000;
    const psi = psiFetch(slowMobileFastDesktop);
    const slowFetch = (async (input: RequestInfo | URL) => {
      const response = await psi.fetchFn(input);
      clock += 400_000; // each real-world call can take minutes
      return response;
    }) as typeof fetch;

    const summary = await runPerformanceChecks({
      d1,
      r2,
      scanId: "scan_1",
      apiKey: API_KEY,
      fetchFn: slowFetch,
      sleep: noSleep,
      maxPages: 2,
      concurrency: 1,
      budgetMs: 600_000,
      clock: () => clock,
    });

    // Call 1 ends at +400 s, call 2 at +800 s (it started in time); calls 3-4 cannot start.
    expect(psi.calls).toHaveLength(2);
    expect(summary).toMatchObject({ resultsOk: 2, resultsUnavailable: 2 });
    expect(summary.unavailable.map((u) => u.reason)).toEqual([
      "timeout",
      "timeout",
    ]);
  });
});
