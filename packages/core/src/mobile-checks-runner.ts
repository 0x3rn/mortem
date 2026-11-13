import type { D1DatabaseLike, R2BucketLike } from "./cloudflare";
import { readEvidenceText } from "./evidence-read";
import { replaceFindingsByPrefix, wrapDbError } from "./findings-store";
import type { MobileAuditMeasurements, MobileCheckKind } from "./mobile-audit";
import {
  evaluateMobileRules,
  type MobileCropRef,
  type MobilePageFacts,
} from "./mobile-checks";

/** Runs the mobile usability rules (THE-184) over each page's stored `mobile_raw`. */

export interface RunMobileChecksParams {
  d1: D1DatabaseLike;
  r2: R2BucketLike;
  scanId: string;
  nowMs?: number;
}

export interface MobileSkippedPage {
  pageId: string;
  pageUrl: string;
  reason: string;
}

export interface MobileChecksSummary {
  pagesConsidered: number;
  pagesChecked: number;
  /** No mobile audit stored (for example captured before it existed) or it failed. */
  pagesSkipped: MobileSkippedPage[];
  findingsWritten: number;
  occurrencesWritten: number;
  rulesFired: string[];
}

interface PageRow {
  id: string;
  url: string;
}

interface EvidenceRow {
  id: string;
  page_id: string;
  kind: "mobile_raw" | "screenshot_mobile" | "screenshot_element";
  r2_key: string;
  metadata_json: string | null;
}

const CHECKS: ReadonlySet<string> = new Set<MobileCheckKind>([
  "overflow",
  "tap-target-small",
  "tap-target-crowded",
  "small-text",
  "overlay",
]);

function parseJson<T>(text: string | null): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export async function runMobileChecks(
  params: RunMobileChecksParams,
): Promise<MobileChecksSummary> {
  const { d1, r2, scanId } = params;
  const nowMs = params.nowMs ?? Date.now();

  let pages: PageRow[];
  let evidence: EvidenceRow[];
  try {
    const pagesStmt = d1
      .prepare(
        `SELECT id, url FROM pages
         WHERE scan_id = ? AND capture_status IN ('captured', 'partial')
         ORDER BY created_at ASC, id ASC`,
      )
      .bind(scanId);
    pages =
      (pagesStmt.all ? await pagesStmt.all<PageRow>() : { results: [] })
        .results ?? [];
    const evidenceStmt = d1
      .prepare(
        `SELECT id, page_id, kind, r2_key, metadata_json
         FROM evidence_artifacts
         WHERE scan_id = ? AND page_id IS NOT NULL
           AND kind IN ('mobile_raw', 'screenshot_mobile', 'screenshot_element')`,
      )
      .bind(scanId);
    evidence =
      (evidenceStmt.all
        ? await evidenceStmt.all<EvidenceRow>()
        : { results: [] }
      ).results ?? [];
  } catch (err) {
    throw wrapDbError("load pages and evidence for mobile checks", err);
  }

  const facts: MobilePageFacts[] = [];
  const skipped: MobileSkippedPage[] = [];
  for (const page of pages) {
    const rows = evidence.filter((e) => e.page_id === page.id);
    const rawRow = rows.find((e) => e.kind === "mobile_raw");
    if (!rawRow) {
      skipped.push({
        pageId: page.id,
        pageUrl: page.url,
        reason:
          "No mobile layout audit was stored for this page (captured before the audit existed, or a bot challenge was shown).",
      });
      continue;
    }
    const raw = parseJson<{
      status?: unknown;
      message?: unknown;
      measurements?: MobileAuditMeasurements;
    }>(await readEvidenceText(r2, rawRow.r2_key, "mobile checks"));
    if (!raw || raw.status !== "ok" || !raw.measurements) {
      skipped.push({
        pageId: page.id,
        pageUrl: page.url,
        reason:
          typeof raw?.message === "string"
            ? `The mobile layout audit did not run: ${raw.message}`
            : "The stored mobile layout audit could not be read.",
      });
      continue;
    }

    const crops: MobileCropRef[] = rows
      .filter((e) => e.kind === "screenshot_element")
      .map((e) => ({
        row: e,
        meta: parseJson<Record<string, unknown>>(e.metadata_json),
      }))
      .filter(
        ({ meta }) =>
          meta?.source === "mobile" &&
          typeof meta.check === "string" &&
          CHECKS.has(meta.check) &&
          typeof meta.selector === "string",
      )
      .map(({ row, meta }) => ({
        check: meta!.check as MobileCheckKind,
        selector: meta!.selector as string,
        artifactId: row.id,
      }));

    facts.push({
      pageId: page.id,
      pageUrl: page.url,
      measurements: raw.measurements,
      evidence: {
        raw: rawRow.id,
        screenshot:
          rows.find((e) => e.kind === "screenshot_mobile")?.id ?? null,
        crops,
      },
    });
  }

  const candidates = evaluateMobileRules(facts);
  const written = await replaceFindingsByPrefix({
    d1,
    scanId,
    checkIdPrefix: "mobile.",
    label: "mobile",
    nowMs,
    candidates: candidates.map((candidate) => ({
      ...candidate,
      occurrences: candidate.occurrences.map((o) => ({
        pageId: o.pageId,
        evidenceArtifactId: o.evidenceArtifactId,
        excerpt: o.excerpt,
        ...(o.occurrenceKey ? { occurrenceKey: o.occurrenceKey } : {}),
        ...(o.selector ? { selector: o.selector } : {}),
        ...(o.bbox ? { bbox: o.bbox } : {}),
      })),
    })),
  });

  return {
    pagesConsidered: pages.length,
    pagesChecked: facts.length,
    pagesSkipped: skipped,
    findingsWritten: written.findings,
    occurrencesWritten: written.occurrences,
    rulesFired: candidates.map((c) => c.ruleId),
  };
}
