import type { D1DatabaseLike, R2BucketLike } from "./cloudflare";
import { readEvidenceText } from "./evidence-read";
import { writeEvidenceArtifactToR2AndD1 } from "./evidence-storage";
import { fetchWithAbortTimeout } from "./crawl-budgets";
import { replaceFindingsByPrefix, wrapDbError } from "./findings-store";
import { preflightAndValidateTargetUrl } from "./intake";
import {
  evaluateSecurityRules,
  mixedContentFromInsecureRequest,
  parseMixedContentConsoleMessage,
  type DocumentSecurityEvidence,
  type HttpsRedirectProbe,
  type MixedContentItem,
  type SecurityPageFacts,
} from "./security-checks";

/**
 * Runs the passive security checks (THE-183) over stored evidence, plus one
 * plain request to the homepage's `http://` address to see whether it
 * redirects to HTTPS.
 */

/** Follows `http://…` redirects (no body is read). Throws when it cannot complete. */
export type HttpsRedirectProbeFn = (httpUrl: string) => Promise<{
  finalUrl: string;
  redirectChain: ReadonlyArray<{
    fromUrl: string;
    toUrl: string;
    statusCode: number;
  }>;
  statusCode: number | null;
}>;

/** Per-request timeout for the http:// check (a filtered port would otherwise hang). */
export const HTTPS_PROBE_REQUEST_TIMEOUT_MS = 10_000;

/**
 * The production probe: the intake preflight (HEAD, GET fallback, at most 5
 * redirects, SSRF and DNS checks on every hop) with a timeout on each request.
 */
export function createPreflightHttpsRedirectProbe(
  options: { fetchFn?: typeof fetch; timeoutMs?: number } = {},
): HttpsRedirectProbeFn {
  const timeoutMs = options.timeoutMs ?? HTTPS_PROBE_REQUEST_TIMEOUT_MS;
  const baseFetch = options.fetchFn ?? fetch;
  return async (httpUrl) => {
    const result = await preflightAndValidateTargetUrl(httpUrl, {
      maxRedirects: 5,
      fetchFn: ((input: RequestInfo | URL, init?: RequestInit) =>
        fetchWithAbortTimeout(
          input instanceof Request ? input.url : input,
          init,
          timeoutMs,
          baseFetch,
        )) as typeof fetch,
    });
    return {
      finalUrl: result.finalUrl,
      redirectChain: result.redirectChain,
      statusCode: result.statusCode,
    };
  };
}

export interface RunSecurityChecksParams {
  d1: D1DatabaseLike;
  r2: R2BucketLike;
  scanId: string;
  nowMs?: number;
  /** `null` skips the HTTP → HTTPS check (recorded in the summary). */
  probe: HttpsRedirectProbeFn | null;
}

export interface SecuritySkippedPage {
  pageId: string;
  pageUrl: string;
  reason: string;
}

export interface SecurityChecksSummary {
  pagesConsidered: number;
  pagesChecked: number;
  pagesSkipped: SecuritySkippedPage[];
  /** Pages whose capture predates TLS/cookie evidence (header rules still ran). */
  pagesWithoutSecurityEvidence: number;
  probe: {
    status: HttpsRedirectProbe["status"] | "not_run";
    probedUrl: string | null;
    finalUrl: string | null;
    hops: number;
    reason: string | null;
  };
  findingsWritten: number;
  occurrencesWritten: number;
  rulesFired: string[];
}

interface PageRow {
  id: string;
  url: string;
  template_type: string | null;
}

interface EvidenceRow {
  id: string;
  page_id: string;
  kind: "headers" | "console_log";
  r2_key: string;
}

interface StoredHeadersJson {
  finalUrl?: unknown;
  desktop?: unknown;
  security?: unknown;
}

function parseJson<T>(text: string | null): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
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

function isSecurityEvidence(value: unknown): value is DocumentSecurityEvidence {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return Array.isArray(v.setCookies) && Array.isArray(v.insecureRequests);
}

function lowerCaseKeys(
  headers: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
}

function mixedContentFromConsole(consoleJson: unknown): MixedContentItem[] {
  const desktop = (consoleJson as { desktop?: unknown } | null)?.desktop;
  if (!Array.isArray(desktop)) return [];
  return desktop
    .map((entry) =>
      typeof (entry as { text?: unknown })?.text === "string"
        ? parseMixedContentConsoleMessage((entry as { text: string }).text)
        : null,
    )
    .filter((m): m is MixedContentItem => m !== null);
}

export async function runSecurityChecks(
  params: RunSecurityChecksParams,
): Promise<SecurityChecksSummary> {
  const { d1, r2, scanId } = params;
  const nowMs = params.nowMs ?? Date.now();

  let pages: PageRow[];
  let evidence: EvidenceRow[];
  try {
    const pagesStmt = d1
      .prepare(
        `SELECT id, url, template_type
         FROM pages
         WHERE scan_id = ? AND capture_status IN ('captured', 'partial')
         ORDER BY created_at ASC, id ASC`,
      )
      .bind(scanId);
    pages =
      (pagesStmt.all ? await pagesStmt.all<PageRow>() : { results: [] })
        .results ?? [];
    const evidenceStmt = d1
      .prepare(
        `SELECT id, page_id, kind, r2_key
         FROM evidence_artifacts
         WHERE scan_id = ? AND kind IN ('headers', 'console_log') AND page_id IS NOT NULL`,
      )
      .bind(scanId);
    evidence =
      (evidenceStmt.all
        ? await evidenceStmt.all<EvidenceRow>()
        : { results: [] }
      ).results ?? [];
  } catch (err) {
    throw wrapDbError("load pages and evidence for security checks", err);
  }

  const evidenceFor = (pageId: string, kind: EvidenceRow["kind"]) =>
    evidence.find((row) => row.page_id === pageId && row.kind === kind) ?? null;

  const facts: SecurityPageFacts[] = [];
  const skipped: SecuritySkippedPage[] = [];
  let pagesWithoutSecurityEvidence = 0;

  for (const page of pages) {
    const headersRow = evidenceFor(page.id, "headers");
    const headersText = headersRow
      ? await readEvidenceText(r2, headersRow.r2_key, "security checks")
      : null;
    const stored = parseJson<StoredHeadersJson>(headersText);
    if (!headersRow || !stored) {
      skipped.push({
        pageId: page.id,
        pageUrl: page.url,
        reason: "No response headers were stored for this page.",
      });
      continue;
    }

    const security = isSecurityEvidence(stored.security)
      ? stored.security
      : undefined;
    if (!security) pagesWithoutSecurityEvidence += 1;

    const consoleRow = evidenceFor(page.id, "console_log");
    const consoleText = consoleRow
      ? await readEvidenceText(r2, consoleRow.r2_key, "security checks")
      : null;
    const mixedContent = [
      ...mixedContentFromConsole(parseJson<unknown>(consoleText)),
      ...(security?.insecureRequests ?? []).map(
        mixedContentFromInsecureRequest,
      ),
    ];

    facts.push({
      pageId: page.id,
      pageUrl: page.url,
      finalUrl:
        typeof stored.finalUrl === "string" && stored.finalUrl
          ? stored.finalUrl
          : page.url,
      headers: isStringRecord(stored.desktop)
        ? lowerCaseKeys(stored.desktop)
        : null,
      security,
      mixedContent,
      evidence: {
        headers: headersRow.id,
        consoleLog: consoleText !== null && consoleRow ? consoleRow.id : null,
      },
    });
  }

  const probe = await runHttpsRedirectProbe({
    d1,
    r2,
    scanId,
    nowMs,
    probeFn: params.probe,
    home:
      facts.find(
        (f) => pages.find((p) => p.id === f.pageId)?.template_type === "home",
      ) ?? facts[0],
  });

  const candidates = evaluateSecurityRules({
    pages: facts,
    probe: probe.result,
    nowMs,
  });
  const written = await replaceFindingsByPrefix({
    d1,
    scanId,
    checkIdPrefix: "sec.",
    label: "security",
    nowMs,
    candidates: candidates.map((candidate) => ({
      ...candidate,
      occurrences: candidate.occurrences.map((o) => ({
        pageId: o.pageId,
        evidenceArtifactId: o.evidenceArtifactId,
        excerpt: o.excerpt,
        ...(o.occurrenceKey ? { occurrenceKey: o.occurrenceKey } : {}),
      })),
    })),
  });

  return {
    pagesConsidered: pages.length,
    pagesChecked: facts.length,
    pagesSkipped: skipped,
    pagesWithoutSecurityEvidence,
    probe: probe.summary,
    findingsWritten: written.findings,
    occurrencesWritten: written.occurrences,
    rulesFired: candidates.map((c) => c.ruleId),
  };
}

async function runHttpsRedirectProbe(params: {
  d1: D1DatabaseLike;
  r2: R2BucketLike;
  scanId: string;
  nowMs: number;
  probeFn: HttpsRedirectProbeFn | null;
  home: SecurityPageFacts | undefined;
}): Promise<{
  result: HttpsRedirectProbe | null;
  summary: SecurityChecksSummary["probe"];
}> {
  const notRun = (reason: string) => ({
    result: null,
    summary: {
      status: "not_run" as const,
      probedUrl: null,
      finalUrl: null,
      hops: 0,
      reason,
    },
  });
  const home = params.home;
  if (!home) return notRun("No captured page to check.");
  if (!home.finalUrl.toLowerCase().startsWith("https://")) {
    return notRun(
      "The homepage is not served over HTTPS (reported as sec.https.not-used).",
    );
  }
  if (!params.probeFn) return notRun("The HTTP → HTTPS check is disabled.");

  let host: string;
  try {
    host = new URL(home.finalUrl).host;
  } catch {
    return notRun(`The homepage URL could not be parsed: ${home.finalUrl}`);
  }
  const probedUrl = `http://${host}/`;

  let status: HttpsRedirectProbe["status"];
  let finalUrl: string | null = null;
  let hops = 0;
  let reason: string | null = null;
  let redirectChain: unknown[] = [];
  let statusCode: number | null = null;
  try {
    const outcome = await params.probeFn(probedUrl);
    finalUrl = outcome.finalUrl;
    hops = outcome.redirectChain.length;
    redirectChain = [...outcome.redirectChain];
    statusCode = outcome.statusCode;
    status = finalUrl.toLowerCase().startsWith("https://")
      ? "redirects_to_https"
      : "serves_http";
  } catch (err) {
    // Connection refused, SSRF guard, timeout, bot block: no finding, reason kept.
    status = "unavailable";
    reason = err instanceof Error ? err.message : String(err);
  }

  const artifact = await writeEvidenceArtifactToR2AndD1({
    d1: params.d1,
    r2: params.r2,
    scanId: params.scanId,
    pageId: null,
    kind: "headers",
    suffix: "http_probe",
    payload: JSON.stringify(
      {
        check: "http_to_https_redirect",
        probedUrl,
        status,
        statusCode,
        finalUrl,
        hops,
        redirectChain,
        reason,
        checkedAt: new Date(params.nowMs).toISOString(),
      },
      null,
      2,
    ),
    contentType: "application/json; charset=utf-8",
    extension: "json",
    metadata: { probedUrl, status, hops },
    nowMs: params.nowMs,
  });

  return {
    result: {
      status,
      probedUrl,
      finalUrl,
      hops,
      reason,
      pageId: home.pageId,
      pageUrl: home.pageUrl,
      evidenceArtifactId: artifact.id,
    },
    summary: { status, probedUrl, finalUrl, hops, reason },
  };
}
