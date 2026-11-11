import { type D1DatabaseLike, type R2BucketLike } from "./cloudflare";
import { writeEvidenceArtifactToR2AndD1 } from "./evidence-storage";
import { replaceFindingsByPrefix, wrapDbError } from "./findings-store";
import {
  PSI_DEFAULT_CONCURRENCY,
  PSI_STAGE_BUDGET_MS,
  PSI_MAX_PAGES_PER_SCAN,
  PSI_STRATEGIES,
  evaluatePerformanceRules,
  fetchPageSpeedInsights,
  parsePsiResponse,
  runWithConcurrency,
  type ParsedPsiData,
  type PerformanceRuleInput,
  type PsiFieldResult,
  type PsiLabMetrics,
  type PsiAuditResult,
  type PsiStrategy,
  type PsiUnavailableReason,
} from "./pagespeed";
import type { PageLoadTimingsJson, PageTemplateType } from "./schema/scans";

/**
 * Orchestrates PageSpeed Insights for a scan (THE-180): choose pages, call PSI
 * per strategy, store the raw response in R2 and the extracted metrics in D1,
 * then turn threshold breaches into evidence-backed findings.
 *
 * Idempotent by design — queue stages can run twice: result rows upsert on
 * (page_id, strategy), evidence ids are deterministic, and performance findings
 * (`perf.*`) are rebuilt from scratch on every run.
 */

const TEMPLATE_PRIORITY: Readonly<Record<PageTemplateType, number>> = {
  home: 0,
  pricing: 1,
  product: 2,
  contact: 3,
  auth: 4,
  docs: 5,
  blog: 6,
  legal: 7,
  other: 8,
};

export interface PerformanceCandidatePage {
  id: string;
  url: string;
  templateType: PageTemplateType;
  createdAt: number;
}

/**
 * Picks the pages worth spending PSI quota on: the homepage first, then one page
 * per remaining template type in priority order, capped at `max`.
 */
export function selectPagesForPerformanceAnalysis(
  pages: readonly PerformanceCandidatePage[],
  max: number = PSI_MAX_PAGES_PER_SCAN,
): PerformanceCandidatePage[] {
  const limit = Math.max(0, Math.floor(max));
  const ordered = [...pages].sort(
    (a, b) =>
      TEMPLATE_PRIORITY[a.templateType] - TEMPLATE_PRIORITY[b.templateType] ||
      a.createdAt - b.createdAt ||
      a.id.localeCompare(b.id),
  );
  const seenTemplates = new Set<PageTemplateType>();
  const selected: PerformanceCandidatePage[] = [];
  for (const page of ordered) {
    if (selected.length >= limit) break;
    if (seenTemplates.has(page.templateType)) continue;
    seenTemplates.add(page.templateType);
    selected.push(page);
  }
  return selected;
}

export interface RunPerformanceChecksParams {
  d1: D1DatabaseLike;
  r2: R2BucketLike;
  scanId: string;
  /** `PAGESPEED_API_KEY`. When absent every result is recorded as `api_key_missing`. */
  apiKey?: string | null;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  concurrency?: number;
  maxPages?: number;
  timeoutMs?: number;
  maxAttempts?: number;
  /** Timestamp written to rows (fixed in tests). */
  nowMs?: number;
  /** Wall-time budget for all PSI calls in this run (default 10 minutes). */
  budgetMs?: number;
  /** Clock used for the budget (injectable for tests). */
  clock?: () => number;
}

export interface PerformanceUnavailableEntry {
  pageId: string;
  pageUrl: string;
  strategy: PsiStrategy;
  reason: PsiUnavailableReason;
  message: string;
}

export interface PerformanceChecksSummary {
  pagesConsidered: number;
  pagesAnalyzed: number;
  resultsOk: number;
  resultsUnavailable: number;
  /** HTTP attempts made against PSI (what counts against quota). */
  psiCalls: number;
  findingsWritten: number;
  occurrencesWritten: number;
  /** True when at least one page/strategy has no PSI data. */
  partial: boolean;
  unavailable: PerformanceUnavailableEntry[];
  r2BytesWritten: number;
}

interface CapturedPageRow {
  id: string;
  url: string;
  template_type: PageTemplateType;
  load_timings_json: string | null;
  created_at: number;
}

interface PsiTask {
  page: CapturedPageRow;
  strategy: PsiStrategy;
}

interface PsiTaskOutcome {
  task: PsiTask;
  attempts: number;
  r2BytesWritten: number;
  ruleInput: PerformanceRuleInput | null;
  unavailable: PerformanceUnavailableEntry | null;
}

function parseTimings(json: string | null): PageLoadTimingsJson | null {
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    const timings = parsed as Record<string, unknown>;
    const picked: PageLoadTimingsJson = {};
    for (const key of [
      "ttfbMs",
      "domContentLoadedMs",
      "loadEventMs",
      "fcpMs",
      "lcpMs",
      "cls",
      "inpMs",
    ] as const) {
      const value = timings[key];
      if (typeof value === "number" && Number.isFinite(value)) {
        picked[key] = value;
      }
    }
    return Object.keys(picked).length > 0 ? picked : null;
  } catch {
    return null;
  }
}

/**
 * Browser Run navigation timings are only captured for the desktop viewport, so
 * they supplement the desktop PSI row only. They are never a Lighthouse score.
 */
function buildNavigationTimingsJson(
  page: CapturedPageRow,
  strategy: PsiStrategy,
): string | null {
  if (strategy !== "desktop") return null;
  const timings = parseTimings(page.load_timings_json);
  if (!timings) return null;
  return JSON.stringify({
    source: "browser_run",
    viewport: "desktop",
    note: "Navigation timings measured during capture; not a Lighthouse result.",
    ...timings,
  });
}

async function upsertPerformanceResult(params: {
  d1: D1DatabaseLike;
  scanId: string;
  task: PsiTask;
  attempts: number;
  evidenceArtifactId: string | null;
  data: ParsedPsiData | null;
  unavailable: { reason: PsiUnavailableReason; message: string } | null;
  nowMs: number;
}): Promise<void> {
  const { d1, scanId, task, data, unavailable, nowMs } = params;
  const id = `${task.page.id}_perf_${task.strategy}`;

  const labJson = data
    ? JSON.stringify(data.lab satisfies PsiLabMetrics)
    : null;
  const fieldJson = data
    ? JSON.stringify(data.field satisfies PsiFieldResult)
    : null;
  const auditsJson = JSON.stringify(
    (data?.audits ?? []) satisfies PsiAuditResult[],
  );

  try {
    await d1
      .prepare(
        `INSERT INTO page_performance_results (
           id, scan_id, page_id, strategy, status, unavailable_reason, unavailable_message,
           attempts, lighthouse_version, lighthouse_fetch_time, lab_json, field_json,
           audits_json, navigation_timings_json, psi_evidence_artifact_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(page_id, strategy) DO UPDATE SET
           status = excluded.status,
           unavailable_reason = excluded.unavailable_reason,
           unavailable_message = excluded.unavailable_message,
           attempts = excluded.attempts,
           lighthouse_version = excluded.lighthouse_version,
           lighthouse_fetch_time = excluded.lighthouse_fetch_time,
           lab_json = excluded.lab_json,
           field_json = excluded.field_json,
           audits_json = excluded.audits_json,
           navigation_timings_json = excluded.navigation_timings_json,
           psi_evidence_artifact_id = excluded.psi_evidence_artifact_id,
           updated_at = excluded.updated_at`,
      )
      .bind(
        id,
        scanId,
        task.page.id,
        task.strategy,
        data ? "ok" : "unavailable",
        unavailable?.reason ?? null,
        unavailable?.message ?? null,
        params.attempts,
        data?.lighthouseVersion ?? null,
        data?.fetchTime ?? null,
        labJson,
        fieldJson,
        auditsJson,
        buildNavigationTimingsJson(task.page, task.strategy),
        params.evidenceArtifactId,
        nowMs,
        nowMs,
      )
      .run();
  } catch (err) {
    throw wrapDbError(
      `store PageSpeed result for page ${task.page.id} (${task.strategy})`,
      err,
    );
  }
}

async function analyzeTask(
  params: RunPerformanceChecksParams,
  task: PsiTask,
  nowMs: number,
  deadlineAt: number,
): Promise<PsiTaskOutcome> {
  const fetched = await fetchPageSpeedInsights({
    url: task.page.url,
    strategy: task.strategy,
    apiKey: params.apiKey,
    fetchFn: params.fetchFn,
    sleep: params.sleep,
    timeoutMs: params.timeoutMs,
    maxAttempts: params.maxAttempts,
    deadlineAt,
    now: params.clock,
  });

  let evidenceArtifactId: string | null = null;
  let r2BytesWritten = 0;
  let data: ParsedPsiData | null = null;
  let unavailable: { reason: PsiUnavailableReason; message: string } | null =
    null;

  if (fetched.status === "ok") {
    // Keep the verbatim response even when Lighthouse reported a runtime error:
    // it is the evidence for why the page has no PSI data.
    const artifact = await writeEvidenceArtifactToR2AndD1({
      d1: params.d1,
      r2: params.r2,
      scanId: params.scanId,
      pageId: task.page.id,
      kind: "psi_raw",
      suffix: task.strategy,
      payload: fetched.rawText,
      metadata: {
        strategy: task.strategy,
        requestedUrl: task.page.url,
        httpStatus: fetched.httpStatus,
        attempts: fetched.attempts,
      },
      nowMs,
    });
    evidenceArtifactId = artifact.id;
    r2BytesWritten = artifact.byteSize;

    const parsed = parsePsiResponse(fetched.raw, task.strategy);
    if (parsed.ok) {
      data = parsed.data;
    } else {
      unavailable = { reason: parsed.reason, message: parsed.message };
    }
  } else {
    unavailable = { reason: fetched.reason, message: fetched.message };
  }

  await upsertPerformanceResult({
    d1: params.d1,
    scanId: params.scanId,
    task,
    attempts: fetched.attempts,
    evidenceArtifactId,
    data,
    unavailable,
    nowMs,
  });

  return {
    task,
    attempts: fetched.attempts,
    r2BytesWritten,
    ruleInput:
      data && evidenceArtifactId
        ? {
            pageId: task.page.id,
            pageUrl: task.page.url,
            strategy: task.strategy,
            evidenceArtifactId,
            data,
          }
        : null,
    unavailable: unavailable
      ? {
          pageId: task.page.id,
          pageUrl: task.page.url,
          strategy: task.strategy,
          ...unavailable,
        }
      : null,
  };
}

/**
 * Replaces every `perf.*` finding of the scan with the findings derived from the
 * supplied PSI results, atomically when the database supports `batch`.
 */
export async function replacePerformanceFindings(params: {
  d1: D1DatabaseLike;
  scanId: string;
  inputs: readonly PerformanceRuleInput[];
  nowMs: number;
}): Promise<{ findings: number; occurrences: number }> {
  return replaceFindingsByPrefix({
    d1: params.d1,
    scanId: params.scanId,
    checkIdPrefix: "perf.",
    label: "performance",
    nowMs: params.nowMs,
    candidates: evaluatePerformanceRules(params.inputs).map((candidate) => ({
      ...candidate,
      occurrences: candidate.occurrences.map((occurrence) => ({
        pageId: occurrence.pageId,
        evidenceArtifactId: occurrence.evidenceArtifactId,
        excerpt: occurrence.excerpt,
        occurrenceKey: occurrence.strategy,
      })),
    })),
  });
}

export async function runPerformanceChecks(
  params: RunPerformanceChecksParams,
): Promise<PerformanceChecksSummary> {
  const nowMs = params.nowMs ?? Date.now();
  const clock = params.clock ?? Date.now;
  // One shared budget for the whole run, so slow PSI calls cannot outlive the queue consumer.
  const deadlineAt = clock() + (params.budgetMs ?? PSI_STAGE_BUDGET_MS);

  let pageRows: CapturedPageRow[];
  try {
    const stmt = params.d1
      .prepare(
        `SELECT id, url, template_type, load_timings_json, created_at
         FROM pages
         WHERE scan_id = ? AND capture_status IN ('captured', 'partial')
         ORDER BY created_at ASC, id ASC`,
      )
      .bind(params.scanId);
    const res = stmt.all ? await stmt.all<CapturedPageRow>() : { results: [] };
    pageRows = res.results ?? [];
  } catch (err) {
    throw wrapDbError("load captured pages for performance checks", err);
  }

  const selected = selectPagesForPerformanceAnalysis(
    pageRows.map((row) => ({
      id: row.id,
      url: row.url,
      templateType: row.template_type,
      createdAt: row.created_at,
    })),
    params.maxPages,
  );
  const selectedIds = new Set(selected.map((page) => page.id));
  const pages = pageRows.filter((row) => selectedIds.has(row.id));

  const tasks: PsiTask[] = pages.flatMap((page) =>
    PSI_STRATEGIES.map((strategy) => ({ page, strategy })),
  );

  const outcomes = await runWithConcurrency(
    tasks,
    params.concurrency ?? PSI_DEFAULT_CONCURRENCY,
    (task) => analyzeTask(params, task, nowMs, deadlineAt),
  );

  const inputs = outcomes
    .map((outcome) => outcome.ruleInput)
    .filter((input): input is PerformanceRuleInput => input !== null);
  const unavailable = outcomes
    .map((outcome) => outcome.unavailable)
    .filter((entry): entry is PerformanceUnavailableEntry => entry !== null);

  const written = await replacePerformanceFindings({
    d1: params.d1,
    scanId: params.scanId,
    inputs,
    nowMs,
  });

  return {
    pagesConsidered: pageRows.length,
    pagesAnalyzed: pages.length,
    resultsOk: inputs.length,
    resultsUnavailable: unavailable.length,
    psiCalls: outcomes.reduce((sum, outcome) => sum + outcome.attempts, 0),
    findingsWritten: written.findings,
    occurrencesWritten: written.occurrences,
    partial: unavailable.length > 0,
    unavailable,
    r2BytesWritten: outcomes.reduce(
      (sum, outcome) => sum + outcome.r2BytesWritten,
      0,
    ),
  };
}

export interface StoredPagePerformanceResult {
  id: string;
  pageId: string;
  strategy: PsiStrategy;
  status: "ok" | "unavailable";
  unavailableReason: PsiUnavailableReason | null;
  unavailableMessage: string | null;
  attempts: number;
  lighthouseVersion: string | null;
  lab: PsiLabMetrics | null;
  field: PsiFieldResult | null;
  audits: PsiAuditResult[];
  navigationTimings: Record<string, unknown> | null;
  psiEvidenceArtifactId: string | null;
}

interface PagePerformanceRow {
  id: string;
  page_id: string;
  strategy: PsiStrategy;
  status: "ok" | "unavailable";
  unavailable_reason: PsiUnavailableReason | null;
  unavailable_message: string | null;
  attempts: number;
  lighthouse_version: string | null;
  lab_json: string | null;
  field_json: string | null;
  audits_json: string;
  navigation_timings_json: string | null;
  psi_evidence_artifact_id: string | null;
}

function parseJsonOrNull<T>(json: string | null): T | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

/** Reads stored PSI results for a scan (used by tests now, by the report viewer later). */
export async function listPagePerformanceResults(
  d1: D1DatabaseLike,
  scanId: string,
): Promise<StoredPagePerformanceResult[]> {
  const stmt = d1
    .prepare(
      `SELECT id, page_id, strategy, status, unavailable_reason, unavailable_message, attempts,
              lighthouse_version, lab_json, field_json, audits_json, navigation_timings_json,
              psi_evidence_artifact_id
       FROM page_performance_results
       WHERE scan_id = ?
       ORDER BY page_id ASC, strategy ASC`,
    )
    .bind(scanId);
  const res = stmt.all ? await stmt.all<PagePerformanceRow>() : { results: [] };
  return (res.results ?? []).map((row) => ({
    id: row.id,
    pageId: row.page_id,
    strategy: row.strategy,
    status: row.status,
    unavailableReason: row.unavailable_reason,
    unavailableMessage: row.unavailable_message,
    attempts: row.attempts,
    lighthouseVersion: row.lighthouse_version,
    lab: parseJsonOrNull<PsiLabMetrics>(row.lab_json),
    field: parseJsonOrNull<PsiFieldResult>(row.field_json),
    audits: parseJsonOrNull<PsiAuditResult[]>(row.audits_json) ?? [],
    navigationTimings: parseJsonOrNull<Record<string, unknown>>(
      row.navigation_timings_json,
    ),
    psiEvidenceArtifactId: row.psi_evidence_artifact_id,
  }));
}
