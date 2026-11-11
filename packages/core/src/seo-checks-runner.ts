import { HTML_TRUNCATION_MARKER } from "./browser-capture";
import {
  PlatformBindingError,
  type D1DatabaseLike,
  type R2BucketLike,
  type R2ObjectBodyLike,
} from "./cloudflare";
import { replaceFindingsByPrefix, wrapDbError } from "./findings-store";
import {
  evaluateSeoRules,
  extractSeoFacts,
  type SeoPageFacts,
} from "./seo-checks";

/**
 * Runs the THE-181 SEO checks for a scan: reads each captured page's HTML and
 * header evidence back from R2, evaluates the rules, and rewrites the scan's
 * `seo.*` findings. Idempotent, like the performance checks.
 */

export interface RunSeoChecksParams {
  d1: D1DatabaseLike;
  r2: R2BucketLike;
  scanId: string;
  nowMs?: number;
}

export interface SeoSkippedPage {
  pageId: string;
  pageUrl: string;
  reason: string;
}

export interface SeoChecksSummary {
  pagesConsidered: number;
  pagesAnalyzed: number;
  pagesSkipped: SeoSkippedPage[];
  findingsWritten: number;
  occurrencesWritten: number;
  rulesFired: string[];
}

interface PageRow {
  id: string;
  url: string;
  discovery_sources_json: string | null;
}

interface EvidenceRow {
  id: string;
  page_id: string;
  kind: "html" | "headers";
  r2_key: string;
  metadata_json: string | null;
}

interface StoredHeadersJson {
  finalUrl?: unknown;
  desktop?: unknown;
}

function parseJson<T>(text: string | null): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null; // corrupt metadata is treated as absent, never guessed
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === "string")
  );
}

async function readObjectText(
  r2: R2BucketLike,
  key: string,
): Promise<string | null> {
  if (typeof r2.get !== "function") {
    throw new PlatformBindingError(
      "MISSING_BINDING",
      "EVIDENCE",
      "The R2 binding 'EVIDENCE' cannot read objects, so SEO checks cannot load captured HTML.",
    );
  }
  let object: R2ObjectBodyLike | null;
  try {
    object = await r2.get(key);
  } catch (err) {
    throw new PlatformBindingError(
      "STORAGE_READ_FAILED",
      "EVIDENCE",
      `Failed to read ${key} from R2: ${err instanceof Error ? err.message : "unknown error"}`,
      { cause: err },
    );
  }
  if (!object) return null;
  return object.text
    ? object.text()
    : new TextDecoder().decode(await object.arrayBuffer());
}

export async function runSeoChecks(
  params: RunSeoChecksParams,
): Promise<SeoChecksSummary> {
  const { d1, r2, scanId } = params;
  const nowMs = params.nowMs ?? Date.now();

  let pages: PageRow[];
  let evidence: EvidenceRow[];
  try {
    const pageStmt = d1
      .prepare(
        `SELECT id, url, discovery_sources_json
         FROM pages
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
         WHERE scan_id = ? AND kind IN ('html', 'headers') AND page_id IS NOT NULL`,
      )
      .bind(scanId);
    evidence =
      (evidenceStmt.all
        ? await evidenceStmt.all<EvidenceRow>()
        : { results: [] }
      ).results ?? [];
  } catch (err) {
    throw wrapDbError("load captured pages for SEO checks", err);
  }

  const evidenceFor = (pageId: string, kind: EvidenceRow["kind"]) =>
    evidence.find((row) => row.page_id === pageId && row.kind === kind) ?? null;

  const facts: SeoPageFacts[] = [];
  const evidenceIds = new Map<
    string,
    { html: string; headers: string | null }
  >();
  const skipped: SeoSkippedPage[] = [];

  for (const page of pages) {
    const htmlRow = evidenceFor(page.id, "html");
    if (!htmlRow) {
      skipped.push({
        pageId: page.id,
        pageUrl: page.url,
        reason: "No HTML snapshot was stored for this page.",
      });
      continue;
    }
    const html = await readObjectText(r2, htmlRow.r2_key);
    if (html === null) {
      skipped.push({
        pageId: page.id,
        pageUrl: page.url,
        reason: `HTML snapshot ${htmlRow.r2_key} is recorded in D1 but missing from R2.`,
      });
      continue;
    }

    const headersRow = evidenceFor(page.id, "headers");
    const headersText = headersRow
      ? await readObjectText(r2, headersRow.r2_key)
      : null;
    const storedHeaders = parseJson<StoredHeadersJson>(headersText);
    const htmlMeta = parseJson<{ finalUrl?: unknown }>(htmlRow.metadata_json);

    const finalUrl =
      (typeof storedHeaders?.finalUrl === "string" && storedHeaders.finalUrl) ||
      (typeof htmlMeta?.finalUrl === "string" && htmlMeta.finalUrl) ||
      page.url;
    const sources = parseJson<unknown>(page.discovery_sources_json);

    facts.push(
      extractSeoFacts({
        pageId: page.id,
        pageUrl: page.url,
        finalUrl,
        html,
        headers: isStringRecord(storedHeaders?.desktop)
          ? storedHeaders.desktop
          : null,
        inSitemap: Array.isArray(sources) && sources.includes("sitemap"),
        htmlTruncated: html.includes(HTML_TRUNCATION_MARKER),
      }),
    );
    evidenceIds.set(page.id, {
      html: htmlRow.id,
      headers: headersText !== null && headersRow ? headersRow.id : null,
    });
  }

  const candidates = evaluateSeoRules(facts);
  const written = await replaceFindingsByPrefix({
    d1,
    scanId,
    checkIdPrefix: "seo.",
    label: "SEO",
    nowMs,
    candidates: candidates.map((candidate) => ({
      ...candidate,
      occurrences: candidate.occurrences.map((occurrence) => {
        const ids = evidenceIds.get(occurrence.pageId)!;
        return {
          pageId: occurrence.pageId,
          // Header-based violations cite the headers artifact when it exists.
          evidenceArtifactId:
            occurrence.evidence === "headers" && ids.headers
              ? ids.headers
              : ids.html,
          excerpt: occurrence.excerpt,
        };
      }),
    })),
  });

  return {
    pagesConsidered: pages.length,
    pagesAnalyzed: facts.length,
    pagesSkipped: skipped,
    findingsWritten: written.findings,
    occurrencesWritten: written.occurrences,
    rulesFired: candidates.map((c) => c.ruleId),
  };
}
