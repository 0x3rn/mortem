import {
  ACCESSIBILITY_COVERAGE_NOTE,
  evaluateAccessibility,
  parseAxeArtifact,
  type AccessibilityPageInput,
} from "./accessibility-checks";
import type { D1DatabaseLike, R2BucketLike } from "./cloudflare";
import { readEvidenceText } from "./evidence-read";
import { replaceFindingsByPrefix, wrapDbError } from "./findings-store";

/**
 * Turns the `axe_raw` evidence captured per page and viewport (THE-182) into
 * `a11y.*` findings. Idempotent like the other check families.
 */

export interface RunAccessibilityChecksParams {
  d1: D1DatabaseLike;
  r2: R2BucketLike;
  scanId: string;
  nowMs?: number;
}

export interface AccessibilityUnavailable {
  pageId: string;
  pageUrl: string;
  viewport: "desktop" | "mobile";
  status:
    "error" | "timeout" | "skipped" | "invalid" | "not_captured" | "missing";
  message: string;
}

export interface AccessibilityChecksSummary {
  pagesConsidered: number;
  viewportsAudited: number;
  unavailable: AccessibilityUnavailable[];
  findingsWritten: number;
  occurrencesWritten: number;
  rulesFired: string[];
  /** Rules axe could not decide automatically and that need a manual check. */
  needsReviewRuleCount: number;
  coverageNote: string;
}

interface PageRow {
  id: string;
  url: string;
}

interface EvidenceRow {
  id: string;
  page_id: string;
  kind: "axe_raw" | "screenshot_element";
  r2_key: string;
  metadata_json: string | null;
}

function meta(row: EvidenceRow): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(row.metadata_json ?? "{}");
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {}; // unreadable metadata means the artifact cannot be matched
  }
}

export async function runAccessibilityChecks(
  params: RunAccessibilityChecksParams,
): Promise<AccessibilityChecksSummary> {
  const { d1, r2, scanId } = params;
  const nowMs = params.nowMs ?? Date.now();

  let pages: PageRow[];
  let evidence: EvidenceRow[];
  try {
    const pageStmt = d1
      .prepare(
        `SELECT id, url FROM pages
         WHERE scan_id = ? AND capture_status IN ('captured', 'partial')
         ORDER BY created_at ASC, id ASC`,
      )
      .bind(scanId);
    pages =
      (pageStmt.all ? await pageStmt.all<PageRow>() : { results: [] })
        .results ?? [];
    const evidenceStmt = d1
      .prepare(
        `SELECT id, page_id, kind, r2_key, metadata_json
         FROM evidence_artifacts
         WHERE scan_id = ? AND kind IN ('axe_raw', 'screenshot_element') AND page_id IS NOT NULL`,
      )
      .bind(scanId);
    evidence =
      (evidenceStmt.all
        ? await evidenceStmt.all<EvidenceRow>()
        : { results: [] }
      ).results ?? [];
  } catch (err) {
    throw wrapDbError("load accessibility evidence", err);
  }

  const inputs: AccessibilityPageInput[] = [];
  const unavailable: AccessibilityUnavailable[] = [];
  let needsReviewRuleCount = 0;

  for (const page of pages) {
    for (const viewport of ["desktop", "mobile"] as const) {
      const axeRow = evidence.find(
        (row) =>
          row.page_id === page.id &&
          row.kind === "axe_raw" &&
          meta(row).viewport === viewport,
      );
      const base = { pageId: page.id, pageUrl: page.url, viewport };
      if (!axeRow) {
        unavailable.push({
          ...base,
          status: "not_captured",
          message:
            "No accessibility results were stored for this page and viewport.",
        });
        continue;
      }
      const text = await readEvidenceText(
        r2,
        axeRow.r2_key,
        "accessibility checks",
      );
      if (text === null) {
        unavailable.push({
          ...base,
          status: "missing",
          message: `axe results ${axeRow.r2_key} are recorded in D1 but missing from R2.`,
        });
        continue;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        raw = null; // reported as invalid below
      }
      const parsed = parseAxeArtifact(raw);
      if (!parsed.ok) {
        unavailable.push({
          ...base,
          status: parsed.status,
          message: parsed.message,
        });
        continue;
      }
      needsReviewRuleCount += parsed.data.incompleteRuleCount;
      inputs.push({
        ...base,
        axeArtifactId: axeRow.id,
        data: parsed.data,
        crops: evidence
          .filter(
            (row) =>
              row.page_id === page.id && row.kind === "screenshot_element",
          )
          .map((row) => ({ row, m: meta(row) }))
          .filter(
            ({ m }) =>
              m.source === "axe" &&
              m.viewport === viewport &&
              typeof m.ruleId === "string" &&
              typeof m.selector === "string",
          )
          .map(({ row, m }) => ({
            ruleId: m.ruleId as string,
            target: m.selector as string,
            artifactId: row.id,
          })),
      });
    }
  }

  const candidates = evaluateAccessibility(inputs);
  const written = await replaceFindingsByPrefix({
    d1,
    scanId,
    checkIdPrefix: "a11y.",
    label: "accessibility",
    nowMs,
    candidates: candidates.map((candidate) => ({
      ...candidate,
      occurrences: candidate.occurrences.map((occurrence) => ({
        pageId: occurrence.pageId,
        evidenceArtifactId: occurrence.evidenceArtifactId,
        excerpt: occurrence.excerpt,
        selector: occurrence.selector,
        bbox: occurrence.bbox,
        occurrenceKey: occurrence.occurrenceKey,
      })),
    })),
  });

  return {
    pagesConsidered: pages.length,
    viewportsAudited: inputs.length,
    unavailable,
    findingsWritten: written.findings,
    occurrencesWritten: written.occurrences,
    rulesFired: candidates.map((c) => c.ruleId),
    needsReviewRuleCount,
    coverageNote: ACCESSIBILITY_COVERAGE_NOTE,
  };
}
