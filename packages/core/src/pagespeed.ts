import type { MeasuredValueJson, ThresholdJson } from "./schema/scans";

/**
 * PageSpeed Insights (PSI) v5 integration for THE-180.
 *
 * Lighthouse cannot run inside Cloudflare Workers, so lab metrics
 * (`lighthouseResult`) and real-user field metrics (`loadingExperience`, CrUX)
 * both come from Google's PSI API. Lab and field data are kept strictly
 * separate, and anything PSI does not return is reported as unavailable with an
 * explicit reason — never estimated.
 *
 * This module is pure (no D1/R2): HTTP is injected, parsing is deterministic.
 */

export const PSI_ENDPOINT =
  "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";

export const PSI_STRATEGIES = ["mobile", "desktop"] as const;
export type PsiStrategy = (typeof PSI_STRATEGIES)[number];

export const CRUX_UNAVAILABLE_MESSAGE =
  "Not enough real-user traffic (CrUX unavailable)";

/**
 * Per-call timeout. Live calls recorded for THE-180 took between 7 s (a tiny
 * page) and 215 s (a heavy news homepage), so this is deliberately generous;
 * the stage budget below is what bounds total wall time.
 */
export const PSI_DEFAULT_TIMEOUT_MS = 240_000;
/** One retry: live transient failures (HTTP 500, dropped connection) recovered on the next call. */
export const PSI_DEFAULT_MAX_ATTEMPTS = 2;
export const PSI_DEFAULT_BASE_BACKOFF_MS = 1_000;
export const PSI_MAX_RETRY_AFTER_MS = 30_000;
/** Concurrent PSI requests per scan (PSI is quota-limited, not CPU-limited). */
export const PSI_DEFAULT_CONCURRENCY = 3;
/**
 * Wall-time budget for all PSI work in one `checking` stage, kept below the
 * 15-minute Cloudflare Queue consumer limit. Each attempt's timeout shrinks to
 * the time left; calls that cannot start in time are recorded as `timeout`.
 */
export const PSI_STAGE_BUDGET_MS = 600_000;
/** An attempt is not started with less than this left in the stage budget. */
export const PSI_MIN_ATTEMPT_MS = 10_000;
/** Prioritized pages (homepage + top templates) sent to PSI per scan. */
export const PSI_MAX_PAGES_PER_SCAN = 3;

export const PSI_UNAVAILABLE_REASONS = [
  "api_key_missing",
  "api_key_rejected",
  "quota_exceeded",
  "timeout",
  "network_error",
  "upstream_error",
  "invalid_request",
  "target_unreachable",
  "lighthouse_runtime_error",
  "invalid_response",
] as const;
export type PsiUnavailableReason = (typeof PSI_UNAVAILABLE_REASONS)[number];

// ---------------------------------------------------------------------------
// Request + fetch with retry
// ---------------------------------------------------------------------------

export interface PsiRequestUrlParams {
  url: string;
  strategy: PsiStrategy;
  apiKey?: string | null;
}

/**
 * Builds the PSI request URL. The returned URL contains the API key, so it must
 * never be logged or placed in an error message — see {@link redactPsiSecrets}.
 */
export function buildPsiRequestUrl(params: PsiRequestUrlParams): string {
  const search = new URLSearchParams();
  search.set("url", params.url);
  search.set("strategy", params.strategy.toUpperCase());
  search.set("category", "PERFORMANCE");
  if (params.apiKey) {
    search.set("key", params.apiKey);
  }
  return `${PSI_ENDPOINT}?${search.toString()}`;
}

/** Removes the API key (and any `key=` query value) from text destined for logs or storage. */
export function redactPsiSecrets(text: string, apiKey?: string | null): string {
  let out = text.replace(/([?&]key=)[^&\s"']+/gi, "$1REDACTED");
  if (apiKey && apiKey.length >= 4) {
    out = out.split(apiKey).join("REDACTED");
  }
  return out;
}

export type PsiFetchResult =
  | {
      status: "ok";
      /** Exact response body, stored verbatim in R2 as `psi_raw`. */
      rawText: string;
      raw: unknown;
      httpStatus: number;
      attempts: number;
    }
  | {
      status: "unavailable";
      reason: PsiUnavailableReason;
      message: string;
      httpStatus: number | null;
      attempts: number;
    };

export interface FetchPageSpeedInsightsParams extends PsiRequestUrlParams {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  maxAttempts?: number;
  baseBackoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Epoch ms after which no attempt may start or keep running (the stage budget). */
  deadlineAt?: number;
  /** Clock used with `deadlineAt` (injectable for tests). */
  now?: () => number;
}

interface ClassifiedPsiFailure {
  reason: PsiUnavailableReason;
  message: string;
  retryable: boolean;
}

const TARGET_UNREACHABLE_MARKERS = [
  "FAILED_DOCUMENT_REQUEST",
  "ERRORED_DOCUMENT_REQUEST",
  "DNS_FAILURE",
  "INSECURE_DOCUMENT_REQUEST",
  "UNABLE_TO_RELIABLY_LOAD",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function extractPsiErrorMessage(bodyText: string): {
  message: string;
  reason: string | null;
} {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (isRecord(parsed) && isRecord(parsed.error)) {
      const message = asString(parsed.error.message) ?? bodyText.slice(0, 300);
      const firstError = Array.isArray(parsed.error.errors)
        ? parsed.error.errors[0]
        : undefined;
      const reason =
        isRecord(firstError) && typeof firstError.reason === "string"
          ? firstError.reason
          : null;
      return { message, reason };
    }
  } catch {
    // Non-JSON error body (HTML error page, empty body): fall through to raw text.
  }
  return { message: bodyText.slice(0, 300), reason: null };
}

function classifyPsiHttpFailure(
  status: number,
  bodyText: string,
  apiKey?: string | null,
): ClassifiedPsiFailure {
  const { message: rawMessage, reason: googleReason } =
    extractPsiErrorMessage(bodyText);
  const message = redactPsiSecrets(rawMessage, apiKey);
  const upper = rawMessage.toUpperCase();

  if (TARGET_UNREACHABLE_MARKERS.some((marker) => upper.includes(marker))) {
    return { reason: "target_unreachable", message, retryable: false };
  }

  // Lighthouse failures on the page itself arrive as HTTP 4xx with reason
  // `lighthouseUserError` (recorded live: NO_FCP returned as HTTP 400).
  if (
    status < 500 &&
    (/lighthouse returned error/i.test(rawMessage) ||
      googleReason?.toLowerCase().startsWith("lighthouse") === true)
  ) {
    return { reason: "lighthouse_runtime_error", message, retryable: false };
  }

  if (status === 429) {
    const dailyQuota =
      /per day/i.test(rawMessage) || googleReason === "dailyLimitExceeded";
    return {
      reason: "quota_exceeded",
      message,
      // A daily quota cannot recover within this scan; a per-minute limit can.
      retryable: !dailyQuota,
    };
  }

  if (status === 401 || status === 403 || /api key/i.test(rawMessage)) {
    return { reason: "api_key_rejected", message, retryable: false };
  }

  if (status >= 500) {
    return { reason: "upstream_error", message, retryable: true };
  }

  if (status >= 400) {
    return { reason: "invalid_request", message, retryable: false };
  }

  return { reason: "upstream_error", message, retryable: false };
}

function parseRetryAfterMs(headers: Headers): number | null {
  const header = headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(seconds * 1000, PSI_MAX_RETRY_AFTER_MS);
}

function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Calls PSI v5 once per strategy with a hard timeout and bounded retries.
 *
 * Retries only transient failures (429 per-minute limits, 5xx, network errors).
 * Daily quota exhaustion, rejected keys, bad requests, unreachable targets and
 * timeouts are returned immediately as `unavailable` with an explicit reason.
 * The API key never appears in a returned message.
 */
export async function fetchPageSpeedInsights(
  params: FetchPageSpeedInsightsParams,
): Promise<PsiFetchResult> {
  const apiKey = params.apiKey?.trim();
  if (!apiKey) {
    return {
      status: "unavailable",
      reason: "api_key_missing",
      message:
        "PAGESPEED_API_KEY is not configured, so PageSpeed Insights was not called.",
      httpStatus: null,
      attempts: 0,
    };
  }

  const fetchFn = params.fetchFn ?? fetch;
  const timeoutMs = params.timeoutMs ?? PSI_DEFAULT_TIMEOUT_MS;
  const maxAttempts = Math.max(
    1,
    Math.floor(params.maxAttempts ?? PSI_DEFAULT_MAX_ATTEMPTS),
  );
  const baseBackoffMs = params.baseBackoffMs ?? PSI_DEFAULT_BASE_BACKOFF_MS;
  const sleep = params.sleep ?? defaultSleep;
  const requestUrl = buildPsiRequestUrl({
    url: params.url,
    strategy: params.strategy,
    apiKey,
  });

  const now = params.now ?? Date.now;

  let last: Extract<PsiFetchResult, { status: "unavailable" }> | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let retryAfterMs: number | null = null;
    let retryable = false;

    const remainingMs =
      params.deadlineAt === undefined
        ? Number.POSITIVE_INFINITY
        : params.deadlineAt - now();
    if (remainingMs < PSI_MIN_ATTEMPT_MS) {
      // Out of stage budget: keep the real failure if a previous attempt had one.
      return (
        last ?? {
          status: "unavailable",
          reason: "timeout",
          message:
            "The PageSpeed Insights time budget for this scan ran out before this page could be analyzed.",
          httpStatus: null,
          attempts: attempt - 1,
        }
      );
    }
    const attemptTimeoutMs = Math.min(timeoutMs, remainingMs);

    try {
      const response = await fetchFn(requestUrl, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(attemptTimeoutMs),
      });
      const bodyText = await response.text();

      if (response.ok) {
        try {
          const raw: unknown = JSON.parse(bodyText);
          return {
            status: "ok",
            rawText: bodyText,
            raw,
            httpStatus: response.status,
            attempts: attempt,
          };
        } catch {
          return {
            status: "unavailable",
            reason: "invalid_response",
            message: "PageSpeed Insights returned a non-JSON response body.",
            httpStatus: response.status,
            attempts: attempt,
          };
        }
      }

      const failure = classifyPsiHttpFailure(response.status, bodyText, apiKey);
      last = {
        status: "unavailable",
        reason: failure.reason,
        message: failure.message,
        httpStatus: response.status,
        attempts: attempt,
      };
      retryable = failure.retryable;
      retryAfterMs = parseRetryAfterMs(response.headers);
    } catch (error) {
      if (isTimeoutError(error)) {
        // Not retried: a call that used its whole window will not fit in what is left.
        return {
          status: "unavailable",
          reason: "timeout",
          message: `PageSpeed Insights did not answer within ${attemptTimeoutMs} ms.`,
          httpStatus: null,
          attempts: attempt,
        };
      }
      last = {
        status: "unavailable",
        reason: "network_error",
        message: redactPsiSecrets(
          error instanceof Error ? error.message : "Unknown network error",
          apiKey,
        ),
        httpStatus: null,
        attempts: attempt,
      };
      retryable = true;
    }

    if (!retryable || attempt === maxAttempts) {
      break;
    }
    await sleep(retryAfterMs ?? baseBackoffMs * 2 ** (attempt - 1));
  }

  return (
    last ?? {
      status: "unavailable",
      reason: "upstream_error",
      message: "PageSpeed Insights request did not complete.",
      httpStatus: null,
      attempts: maxAttempts,
    }
  );
}

/**
 * Runs `worker` over `items` with at most `limit` in flight, preserving input order.
 */
export async function runWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const lanes = Math.max(1, Math.min(Math.floor(limit), items.length));

  async function lane(): Promise<void> {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index] as T, index);
    }
  }

  await Promise.all(Array.from({ length: lanes }, () => lane()));
  return results;
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

export interface PsiLabMetrics {
  /** Lighthouse performance category score, 0–100. `null` when Lighthouse did not score it. */
  performanceScore: number | null;
  lcpMs: number | null;
  cls: number | null;
  tbtMs: number | null;
  fcpMs: number | null;
  speedIndexMs: number | null;
  /** Root-document server response time from the `server-response-time` audit. */
  ttfbMs: number | null;
}

export interface PsiFieldMetric {
  /** 75th-percentile value. LCP/INP in ms, CLS as a unitless score. */
  p75: number;
  googleCategory: string | null;
}

export type PsiFieldResult =
  | {
      available: true;
      scope: "url" | "origin";
      overallCategory: string | null;
      lcp: PsiFieldMetric | null;
      inp: PsiFieldMetric | null;
      cls: PsiFieldMetric | null;
    }
  | { available: false; message: string };

/**
 * Lighthouse audits Mortem turns into findings, verified against live PSI
 * responses (Lighthouse 13.6.0, recorded for THE-180). Lighthouse 13 replaced
 * `render-blocking-resources`, `uses-optimized-images` + `modern-image-formats`
 * and `dom-size` with the `*-insight` audits below and removed
 * `offscreen-images` without a replacement.
 */
export const PSI_MAPPED_AUDIT_IDS = [
  "render-blocking-insight",
  "image-delivery-insight",
  "unused-javascript",
  "unused-css-rules",
  "server-response-time",
  "dom-size-insight",
] as const;
export type PsiMappedAuditId = (typeof PSI_MAPPED_AUDIT_IDS)[number];

export type PsiAuditStatus =
  | "passed"
  | "opportunity"
  | "informational"
  | "not_applicable"
  | "error"
  | "missing";

export interface PsiAuditItem {
  /** A real http(s) asset URL, or `null`. */
  url: string | null;
  /** True when Lighthouse reported inline code (no URL) for this row. */
  inlineCode: boolean;
  wastedBytes: number | null;
  wastedMs: number | null;
  totalBytes: number | null;
  /** Used by `server-response-time` (root document response time). */
  durationMs: number | null;
}

export interface PsiAuditResult {
  auditId: PsiMappedAuditId;
  status: PsiAuditStatus;
  score: number | null;
  displayValue: string | null;
  numericValue: number | null;
  savingsMs: number | null;
  savingsBytes: number | null;
  items: PsiAuditItem[];
}

export interface ParsedPsiData {
  strategy: PsiStrategy;
  requestedUrl: string | null;
  finalUrl: string | null;
  lighthouseVersion: string | null;
  fetchTime: string | null;
  runWarnings: string[];
  lab: PsiLabMetrics;
  field: PsiFieldResult;
  audits: PsiAuditResult[];
}

export type PsiParseResult =
  | { ok: true; data: ParsedPsiData }
  | {
      ok: false;
      reason: Extract<
        PsiUnavailableReason,
        "target_unreachable" | "lighthouse_runtime_error" | "invalid_response"
      >;
      message: string;
    };

const MAX_AUDIT_ITEMS = 10;
/** Lighthouse treats an audit score at or above this as passing. */
const AUDIT_PASS_SCORE = 0.9;
/** Mortem's threshold for an excessive DOM (Lighthouse's long-standing ~1,400-element guidance). */
const DOM_SIZE_EXCESSIVE_ELEMENTS = 1400;

function auditNumeric(
  audits: Record<string, unknown>,
  id: string,
): number | null {
  const audit = audits[id];
  if (!isRecord(audit)) return null;
  if (audit.scoreDisplayMode === "error") return null;
  return asFiniteNumber(audit.numericValue);
}

function parseLab(
  lighthouse: Record<string, unknown>,
  audits: Record<string, unknown>,
): PsiLabMetrics {
  let performanceScore: number | null = null;
  if (isRecord(lighthouse.categories)) {
    const performance = lighthouse.categories.performance;
    if (isRecord(performance)) {
      const score = asFiniteNumber(performance.score);
      performanceScore = score === null ? null : Math.round(score * 100);
    }
  }

  return {
    performanceScore,
    lcpMs: auditNumeric(audits, "largest-contentful-paint"),
    cls: auditNumeric(audits, "cumulative-layout-shift"),
    tbtMs: auditNumeric(audits, "total-blocking-time"),
    fcpMs: auditNumeric(audits, "first-contentful-paint"),
    speedIndexMs: auditNumeric(audits, "speed-index"),
    ttfbMs: auditNumeric(audits, "server-response-time"),
  };
}

function parseFieldMetric(
  metrics: Record<string, unknown>,
  key: string,
  divisor = 1,
): PsiFieldMetric | null {
  const metric = metrics[key];
  if (!isRecord(metric)) return null;
  const percentile = asFiniteNumber(metric.percentile);
  if (percentile === null) return null;
  return {
    p75: percentile / divisor,
    googleCategory: asString(metric.category),
  };
}

function parseFieldExperience(
  experience: unknown,
  scope: "url" | "origin",
): Extract<PsiFieldResult, { available: true }> | null {
  if (!isRecord(experience) || !isRecord(experience.metrics)) return null;
  const metrics = experience.metrics;

  const lcp = parseFieldMetric(metrics, "LARGEST_CONTENTFUL_PAINT_MS");
  const inp = parseFieldMetric(metrics, "INTERACTION_TO_NEXT_PAINT");
  // PSI reports the CLS percentile multiplied by 100 (e.g. 5 means 0.05).
  const cls = parseFieldMetric(metrics, "CUMULATIVE_LAYOUT_SHIFT_SCORE", 100);

  if (!lcp && !inp && !cls) return null;
  return {
    available: true,
    scope,
    overallCategory: asString(experience.overall_category),
    lcp,
    inp,
    cls,
  };
}

function parseField(raw: Record<string, unknown>): PsiFieldResult {
  const urlExperience = raw.loadingExperience;
  const originFallback =
    isRecord(urlExperience) && urlExperience.origin_fallback === true;

  const fromUrl = parseFieldExperience(
    urlExperience,
    originFallback ? "origin" : "url",
  );
  if (fromUrl) return fromUrl;

  const fromOrigin = parseFieldExperience(
    raw.originLoadingExperience,
    "origin",
  );
  if (fromOrigin) return fromOrigin;

  return { available: false, message: CRUX_UNAVAILABLE_MESSAGE };
}

function asHttpUrl(value: string | null): string | null {
  return value !== null && /^https?:\/\//i.test(value) ? value : null;
}

/**
 * Lighthouse puts a code snippet (for example `@font-face { … }`) in the `url`
 * column for inline CSS/JS. Only real http(s) URLs are treated as citable assets.
 */
function readItemSource(value: unknown): {
  url: string | null;
  inlineCode: boolean;
} {
  const raw =
    typeof value === "string"
      ? value
      : isRecord(value)
        ? (asString(value.url) ?? asString(value.value))
        : null;
  const url = asHttpUrl(raw && raw.length > 0 ? raw : null);
  return { url, inlineCode: url === null && raw !== null && raw.length > 0 };
}

function parseAuditItems(details: unknown): PsiAuditItem[] {
  if (!isRecord(details) || !Array.isArray(details.items)) return [];
  const items: PsiAuditItem[] = [];
  for (const item of details.items) {
    if (!isRecord(item)) continue;
    const { url, inlineCode } = readItemSource(item.url);
    const parsed: PsiAuditItem = {
      url,
      inlineCode,
      wastedBytes: asFiniteNumber(item.wastedBytes),
      wastedMs: asFiniteNumber(item.wastedMs),
      totalBytes: asFiniteNumber(item.totalBytes),
      durationMs: asFiniteNumber(item.responseTime),
    };
    // Skip rows that carry no citable URL or measurement (e.g. dom-size statistics).
    if (
      parsed.url === null &&
      parsed.wastedBytes === null &&
      parsed.wastedMs === null &&
      parsed.durationMs === null
    ) {
      continue;
    }
    items.push(parsed);
  }
  items.sort(
    (a, b) =>
      (b.wastedBytes ?? b.wastedMs ?? b.durationMs ?? 0) -
      (a.wastedBytes ?? a.wastedMs ?? a.durationMs ?? 0),
  );
  return items.slice(0, MAX_AUDIT_ITEMS);
}

function classifyAuditStatus(audit: Record<string, unknown>): PsiAuditStatus {
  const mode = audit.scoreDisplayMode;
  const score = asFiniteNumber(audit.score);

  if (mode === "notApplicable") return "not_applicable";
  if (mode === "error") return "error";
  if (mode === "informative" || mode === "manual") return "informational";
  if (mode === "binary") {
    if (score === null) return "error";
    return score >= 1 ? "passed" : "opportunity";
  }
  if (mode === "numeric" || mode === "metricSavings") {
    if (score === null) return "error";
    return score >= AUDIT_PASS_SCORE ? "passed" : "opportunity";
  }
  return "informational";
}

function parseAudit(
  audits: Record<string, unknown>,
  auditId: PsiMappedAuditId,
): PsiAuditResult {
  const audit = audits[auditId];
  if (!isRecord(audit)) {
    return {
      auditId,
      status: "missing",
      score: null,
      displayValue: null,
      numericValue: null,
      savingsMs: null,
      savingsBytes: null,
      items: [],
    };
  }

  const details = isRecord(audit.details) ? audit.details : null;
  const debugData =
    details && isRecord(details.debugData) ? details.debugData : null;
  let status = classifyAuditStatus(audit);
  let numericValue = asFiniteNumber(audit.numericValue);

  if (auditId === "dom-size-insight" && status === "informational") {
    // Lighthouse 13 always reports DOM size as informative, so Mortem applies
    // its own documented threshold to the measured element count.
    numericValue = numericValue ?? asFiniteNumber(debugData?.totalElements);
    status =
      numericValue === null
        ? "error"
        : numericValue > DOM_SIZE_EXCESSIVE_ELEMENTS
          ? "opportunity"
          : "passed";
  }

  return {
    auditId,
    status,
    score: asFiniteNumber(audit.score),
    displayValue: asString(audit.displayValue),
    numericValue,
    // Lighthouse 13 insights report time savings only in `metricSavings`.
    savingsMs:
      (details ? asFiniteNumber(details.overallSavingsMs) : null) ??
      maxMetricSavingsMs(audit.metricSavings),
    // ...and byte savings only in `details.debugData.wastedBytes`.
    savingsBytes:
      (details ? asFiniteNumber(details.overallSavingsBytes) : null) ??
      asFiniteNumber(debugData?.wastedBytes),
    items: parseAuditItems(details),
  };
}

/** Largest millisecond saving Lighthouse estimates across timing metrics (CLS is unitless, so excluded). */
function maxMetricSavingsMs(metricSavings: unknown): number | null {
  if (!isRecord(metricSavings)) return null;
  const values = (["LCP", "FCP", "TBT", "INP"] as const)
    .map((key) => asFiniteNumber(metricSavings[key]))
    .filter((value): value is number => value !== null);
  return values.length > 0 ? Math.max(...values) : null;
}

/**
 * Converts a PSI v5 JSON response into lab metrics, CrUX field metrics and the
 * mapped Lighthouse audit results. Never invents a value: anything absent or
 * errored in the response is `null`, `missing` or `unavailable`.
 */
export function parsePsiResponse(
  raw: unknown,
  strategy: PsiStrategy,
): PsiParseResult {
  if (!isRecord(raw)) {
    return {
      ok: false,
      reason: "invalid_response",
      message: "PageSpeed Insights response was not a JSON object.",
    };
  }

  const lighthouse = raw.lighthouseResult;
  if (!isRecord(lighthouse)) {
    return {
      ok: false,
      reason: "invalid_response",
      message: "PageSpeed Insights response had no lighthouseResult.",
    };
  }

  if (isRecord(lighthouse.runtimeError)) {
    const code = asString(lighthouse.runtimeError.code) ?? "UNKNOWN";
    const message =
      asString(lighthouse.runtimeError.message) ??
      "Lighthouse reported a runtime error.";
    const unreachable = TARGET_UNREACHABLE_MARKERS.some((marker) =>
      code.toUpperCase().includes(marker),
    );
    return {
      ok: false,
      reason: unreachable ? "target_unreachable" : "lighthouse_runtime_error",
      message: `${code}: ${message}`,
    };
  }

  if (!isRecord(lighthouse.audits)) {
    return {
      ok: false,
      reason: "invalid_response",
      message: "PageSpeed Insights response had no Lighthouse audits.",
    };
  }
  const audits = lighthouse.audits;

  return {
    ok: true,
    data: {
      strategy,
      requestedUrl: asString(lighthouse.requestedUrl),
      finalUrl: asString(lighthouse.finalUrl),
      lighthouseVersion: asString(lighthouse.lighthouseVersion),
      fetchTime: asString(lighthouse.fetchTime),
      runWarnings: Array.isArray(lighthouse.runWarnings)
        ? lighthouse.runWarnings.filter(
            (warning): warning is string => typeof warning === "string",
          )
        : [],
      lab: parseLab(lighthouse, audits),
      field: parseField(raw),
      audits: PSI_MAPPED_AUDIT_IDS.map((id) => parseAudit(audits, id)),
    },
  };
}

// ---------------------------------------------------------------------------
// Rule catalog + finding candidates
// ---------------------------------------------------------------------------

export const PERFORMANCE_RULE_VERSION = "1.0.0";

export type PerformanceSeverity = "high" | "medium" | "low";
export type PerformanceRating = "good" | "needs_improvement" | "poor";

export interface PerformanceMetricRule {
  ruleId: string;
  source: "lab" | "field";
  metric: "lcp" | "cls" | "tbt" | "fcp" | "speed_index" | "ttfb" | "inp";
  label: string;
  title: string;
  unit: "ms" | "score";
  /** Values at or below this are rated good. */
  good: number;
  /** Values above this are rated poor. */
  poor: number;
  effort: "low" | "medium" | "high";
  impact: "low" | "medium" | "high" | "critical";
  fixRole: "developer" | "designer" | "devops";
}

/** Core Web Vitals and Lighthouse thresholds (web.dev "good" / "poor" bands). */
export const PERFORMANCE_METRIC_RULES: readonly PerformanceMetricRule[] = [
  {
    ruleId: "perf.lab.lcp",
    source: "lab",
    metric: "lcp",
    label: "LCP",
    title: "Largest Contentful Paint is slow (lab)",
    unit: "ms",
    good: 2500,
    poor: 4000,
    effort: "medium",
    impact: "high",
    fixRole: "developer",
  },
  {
    ruleId: "perf.lab.cls",
    source: "lab",
    metric: "cls",
    label: "CLS",
    title: "Layout shifts while loading (lab)",
    unit: "score",
    good: 0.1,
    poor: 0.25,
    effort: "medium",
    impact: "medium",
    fixRole: "developer",
  },
  {
    ruleId: "perf.lab.tbt",
    source: "lab",
    metric: "tbt",
    label: "TBT",
    title: "Main thread is blocked too long (lab)",
    unit: "ms",
    good: 200,
    poor: 600,
    effort: "high",
    impact: "high",
    fixRole: "developer",
  },
  {
    ruleId: "perf.lab.fcp",
    source: "lab",
    metric: "fcp",
    label: "FCP",
    title: "First Contentful Paint is slow (lab)",
    unit: "ms",
    good: 1800,
    poor: 3000,
    effort: "medium",
    impact: "medium",
    fixRole: "developer",
  },
  {
    ruleId: "perf.lab.speed-index",
    source: "lab",
    metric: "speed_index",
    label: "Speed Index",
    title: "Page content appears slowly (lab)",
    unit: "ms",
    good: 3400,
    poor: 5800,
    effort: "medium",
    impact: "medium",
    fixRole: "developer",
  },
  {
    ruleId: "perf.lab.ttfb",
    source: "lab",
    metric: "ttfb",
    label: "Server response time",
    title: "Server responds slowly (lab)",
    unit: "ms",
    good: 800,
    poor: 1800,
    effort: "medium",
    impact: "high",
    fixRole: "devops",
  },
  {
    ruleId: "perf.field.lcp",
    source: "field",
    metric: "lcp",
    label: "LCP",
    title: "Real visitors see slow Largest Contentful Paint (field)",
    unit: "ms",
    good: 2500,
    poor: 4000,
    effort: "medium",
    impact: "high",
    fixRole: "developer",
  },
  {
    ruleId: "perf.field.inp",
    source: "field",
    metric: "inp",
    label: "INP",
    title: "Real visitors see slow interactions (field)",
    unit: "ms",
    good: 200,
    poor: 500,
    effort: "high",
    impact: "high",
    fixRole: "developer",
  },
  {
    ruleId: "perf.field.cls",
    source: "field",
    metric: "cls",
    label: "CLS",
    title: "Real visitors see layout shifts (field)",
    unit: "score",
    good: 0.1,
    poor: 0.25,
    effort: "medium",
    impact: "medium",
    fixRole: "developer",
  },
];

export interface PerformanceAuditRule {
  ruleId: string;
  auditId: PsiMappedAuditId;
  title: string;
  effort: "low" | "medium" | "high";
  impact: "low" | "medium" | "high" | "critical";
  fixRole: "developer" | "designer" | "devops";
}

export const PERFORMANCE_AUDIT_RULES: readonly PerformanceAuditRule[] = [
  {
    ruleId: "perf.audit.render-blocking",
    auditId: "render-blocking-insight",
    title: "Render-blocking requests delay first paint",
    effort: "medium",
    impact: "high",
    fixRole: "developer",
  },
  {
    ruleId: "perf.audit.image-delivery",
    auditId: "image-delivery-insight",
    title: "Images are larger than they need to be",
    effort: "low",
    impact: "medium",
    fixRole: "developer",
  },
  {
    ruleId: "perf.audit.unused-javascript",
    auditId: "unused-javascript",
    title: "Unused JavaScript is shipped to visitors",
    effort: "medium",
    impact: "high",
    fixRole: "developer",
  },
  {
    ruleId: "perf.audit.unused-css-rules",
    auditId: "unused-css-rules",
    title: "Unused CSS is shipped to visitors",
    effort: "medium",
    impact: "medium",
    fixRole: "developer",
  },
  {
    ruleId: "perf.audit.server-response-time",
    auditId: "server-response-time",
    title: "Initial server response is slow",
    effort: "medium",
    impact: "high",
    fixRole: "devops",
  },
  {
    ruleId: "perf.audit.dom-size",
    auditId: "dom-size-insight",
    title: "Page has an excessively large DOM",
    effort: "high",
    impact: "medium",
    fixRole: "developer",
  },
];

/** Provisional until severity/effort/impact ranking lands in THE-191. */
export const PERFORMANCE_PROVISIONAL_PRIORITY: Readonly<
  Record<PerformanceSeverity, number>
> = {
  high: 70,
  medium: 45,
  low: 20,
};

export function rateMetric(
  rule: Pick<PerformanceMetricRule, "good" | "poor">,
  value: number,
): PerformanceRating {
  if (value <= rule.good) return "good";
  if (value > rule.poor) return "poor";
  return "needs_improvement";
}

function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

function formatMetricValue(unit: "ms" | "score", value: number): string {
  return unit === "ms" ? formatMs(value) : String(Number(value.toFixed(3)));
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
    : `${(bytes / 1024).toFixed(1)} KiB`;
}

const MAX_EXCERPT_LENGTH = 500;

function truncateExcerpt(text: string): string {
  return text.length > MAX_EXCERPT_LENGTH
    ? `${text.slice(0, MAX_EXCERPT_LENGTH - 1)}…`
    : text;
}

export interface PerformanceRuleInput {
  pageId: string;
  pageUrl: string;
  strategy: PsiStrategy;
  /** `evidence_artifacts.id` of the stored `psi_raw` response these numbers came from. */
  evidenceArtifactId: string;
  data: ParsedPsiData;
}

export interface PerformanceFindingOccurrence {
  pageId: string;
  pageUrl: string;
  strategy: PsiStrategy;
  evidenceArtifactId: string;
  excerpt: string;
  /** The comparable numeric value behind this occurrence (ms, bytes or score). */
  value: number;
}

export interface PerformanceFindingCandidate {
  ruleId: string;
  ruleVersion: string;
  category: "performance";
  severity: PerformanceSeverity;
  effort: "low" | "medium" | "high";
  impact: "low" | "medium" | "high" | "critical";
  priorityScore: number;
  title: string;
  measured: MeasuredValueJson;
  threshold: ThresholdJson;
  fixRole: "developer" | "designer" | "devops";
  occurrences: PerformanceFindingOccurrence[];
}

const SEVERITY_ORDER: Readonly<Record<PerformanceSeverity, number>> = {
  low: 0,
  medium: 1,
  high: 2,
};

function maxSeverity(
  a: PerformanceSeverity,
  b: PerformanceSeverity,
): PerformanceSeverity {
  return SEVERITY_ORDER[a] >= SEVERITY_ORDER[b] ? a : b;
}

function ratingToSeverity(rating: PerformanceRating): PerformanceSeverity {
  return rating === "poor" ? "high" : "medium";
}

function readMetricValue(
  rule: PerformanceMetricRule,
  data: ParsedPsiData,
): { value: number; context: Record<string, unknown> } | null {
  if (rule.source === "lab") {
    const lab = data.lab;
    const value =
      rule.metric === "lcp"
        ? lab.lcpMs
        : rule.metric === "cls"
          ? lab.cls
          : rule.metric === "tbt"
            ? lab.tbtMs
            : rule.metric === "fcp"
              ? lab.fcpMs
              : rule.metric === "speed_index"
                ? lab.speedIndexMs
                : rule.metric === "ttfb"
                  ? lab.ttfbMs
                  : null;
    return value === null ? null : { value, context: {} };
  }

  if (!data.field.available) return null;
  const metric =
    rule.metric === "lcp"
      ? data.field.lcp
      : rule.metric === "inp"
        ? data.field.inp
        : rule.metric === "cls"
          ? data.field.cls
          : null;
  return metric
    ? {
        value: metric.p75,
        context: {
          scope: data.field.scope,
          googleCategory: metric.googleCategory,
        },
      }
    : null;
}

function evaluateMetricRule(
  rule: PerformanceMetricRule,
  inputs: readonly PerformanceRuleInput[],
): PerformanceFindingCandidate | null {
  const occurrences: PerformanceFindingOccurrence[] = [];
  let severity: PerformanceSeverity = "medium";

  for (const input of inputs) {
    const reading = readMetricValue(rule, input.data);
    if (!reading) continue;
    const rating = rateMetric(rule, reading.value);
    if (rating === "good") continue;

    severity = maxSeverity(severity, ratingToSeverity(rating));
    const origin =
      rule.source === "field" && input.data.field.available
        ? ` (${input.data.field.scope}-level CrUX p75)`
        : "";
    occurrences.push({
      pageId: input.pageId,
      pageUrl: input.pageUrl,
      strategy: input.strategy,
      evidenceArtifactId: input.evidenceArtifactId,
      value: reading.value,
      excerpt: truncateExcerpt(
        `${input.strategy} ${rule.source}: ${rule.label} ${formatMetricValue(rule.unit, reading.value)}${origin} — ${rating === "poor" ? "poor" : "needs improvement"} (good ≤ ${formatMetricValue(rule.unit, rule.good)}, poor > ${formatMetricValue(rule.unit, rule.poor)})`,
      ),
    });
  }

  if (occurrences.length === 0) return null;
  const worst = occurrences.reduce((a, b) => (b.value > a.value ? b : a));

  return {
    ruleId: rule.ruleId,
    ruleVersion: PERFORMANCE_RULE_VERSION,
    category: "performance",
    severity,
    effort: rule.effort,
    impact: rule.impact,
    priorityScore: PERFORMANCE_PROVISIONAL_PRIORITY[severity],
    title: rule.title,
    measured: {
      metric: `${rule.source}_${rule.metric}`,
      value: worst.value,
      unit: rule.unit,
      rawContext: {
        worstPageUrl: worst.pageUrl,
        worstStrategy: worst.strategy,
        occurrenceCount: occurrences.length,
        poorThreshold: rule.poor,
      },
    },
    threshold: { operator: "lte", target: rule.good, unit: rule.unit },
    fixRole: rule.fixRole,
    occurrences,
  };
}

const HIGH_SAVINGS_MS = 1000;
const MEDIUM_SAVINGS_MS = 300;
const HIGH_SAVINGS_BYTES = 500 * 1024;
const MEDIUM_SAVINGS_BYTES = 100 * 1024;

function auditSeverity(audit: PsiAuditResult): PerformanceSeverity {
  if (audit.auditId === "dom-size-insight") {
    return (audit.numericValue ?? 0) > DOM_SIZE_EXCESSIVE_ELEMENTS
      ? "medium"
      : "low";
  }
  const ms = audit.savingsMs ?? 0;
  const bytes = audit.savingsBytes ?? 0;
  if (ms >= HIGH_SAVINGS_MS || bytes >= HIGH_SAVINGS_BYTES) return "high";
  if (ms >= MEDIUM_SAVINGS_MS || bytes >= MEDIUM_SAVINGS_BYTES) return "medium";
  return "low";
}

function auditComparableValue(audit: PsiAuditResult): {
  value: number;
  unit: "ms" | "bytes" | "elements";
} {
  if (audit.auditId === "dom-size-insight") {
    return { value: audit.numericValue ?? 0, unit: "elements" };
  }
  if (audit.savingsMs !== null && audit.savingsMs > 0) {
    return { value: audit.savingsMs, unit: "ms" };
  }
  if (audit.savingsBytes !== null && audit.savingsBytes > 0) {
    return { value: audit.savingsBytes, unit: "bytes" };
  }
  return { value: audit.numericValue ?? 0, unit: "ms" };
}

function describeAuditItems(audit: PsiAuditResult): string {
  const cited = audit.items
    .filter((item) => item.url !== null || item.inlineCode)
    .slice(0, 3)
    .map((item) => {
      const savings: string[] = [];
      if (item.wastedBytes !== null && item.wastedBytes > 0) {
        savings.push(`${formatBytes(item.wastedBytes)} wasted`);
      }
      if (item.wastedMs !== null && item.wastedMs > 0) {
        savings.push(`${formatMs(item.wastedMs)} wasted`);
      }
      if (item.durationMs !== null) {
        savings.push(formatMs(item.durationMs));
      }
      const label = item.url ?? "inline code on the page";
      return `${label}${savings.length > 0 ? ` (${savings.join(", ")})` : ""}`;
    });
  return cited.join("; ");
}

function evaluateAuditRule(
  rule: PerformanceAuditRule,
  inputs: readonly PerformanceRuleInput[],
): PerformanceFindingCandidate | null {
  const occurrences: PerformanceFindingOccurrence[] = [];
  let severity: PerformanceSeverity = "low";
  let unit: "ms" | "bytes" | "elements" = "ms";

  for (const input of inputs) {
    const audit = input.data.audits.find((a) => a.auditId === rule.auditId);
    if (!audit || audit.status !== "opportunity") continue;

    severity = maxSeverity(severity, auditSeverity(audit));
    const comparable = auditComparableValue(audit);
    unit = comparable.unit;

    const savings: string[] = [];
    if (audit.savingsMs !== null && audit.savingsMs > 0) {
      savings.push(`${formatMs(audit.savingsMs)} potential savings`);
    }
    if (audit.savingsBytes !== null && audit.savingsBytes > 0) {
      savings.push(`${formatBytes(audit.savingsBytes)} potential savings`);
    }
    if (savings.length === 0 && audit.displayValue) {
      savings.push(audit.displayValue);
    }
    const cited = describeAuditItems(audit);

    occurrences.push({
      pageId: input.pageId,
      pageUrl: input.pageUrl,
      strategy: input.strategy,
      evidenceArtifactId: input.evidenceArtifactId,
      value: comparable.value,
      excerpt: truncateExcerpt(
        `${input.strategy}: ${savings.join(", ") || "flagged by Lighthouse"}${cited ? ` — ${cited}` : ""}`,
      ),
    });
  }

  if (occurrences.length === 0) return null;
  const worst = occurrences.reduce((a, b) => (b.value > a.value ? b : a));
  const metricName =
    unit === "ms"
      ? "savings_ms"
      : unit === "bytes"
        ? "savings_bytes"
        : "dom_elements";

  return {
    ruleId: rule.ruleId,
    ruleVersion: PERFORMANCE_RULE_VERSION,
    category: "performance",
    severity,
    effort: rule.effort,
    impact: rule.impact,
    priorityScore: PERFORMANCE_PROVISIONAL_PRIORITY[severity],
    title: rule.title,
    measured: {
      metric: metricName,
      value: worst.value,
      unit,
      rawContext: {
        auditId: rule.auditId,
        worstPageUrl: worst.pageUrl,
        worstStrategy: worst.strategy,
        occurrenceCount: occurrences.length,
      },
    },
    threshold:
      unit === "elements"
        ? { operator: "lte", target: DOM_SIZE_EXCESSIVE_ELEMENTS, unit }
        : { operator: "lte", target: 0, unit },
    fixRole: rule.fixRole,
    occurrences,
  };
}

/**
 * Evaluates every performance rule over the successfully parsed PSI results and
 * returns one finding candidate per rule that fired (with one occurrence per
 * page + strategy). Rules with no breach produce nothing.
 */
export function evaluatePerformanceRules(
  inputs: readonly PerformanceRuleInput[],
): PerformanceFindingCandidate[] {
  const candidates: PerformanceFindingCandidate[] = [];
  for (const rule of PERFORMANCE_METRIC_RULES) {
    const candidate = evaluateMetricRule(rule, inputs);
    if (candidate) candidates.push(candidate);
  }
  for (const rule of PERFORMANCE_AUDIT_RULES) {
    const candidate = evaluateAuditRule(rule, inputs);
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

export const PERFORMANCE_RULE_IDS: readonly string[] = [
  ...PERFORMANCE_METRIC_RULES.map((rule) => rule.ruleId),
  ...PERFORMANCE_AUDIT_RULES.map((rule) => rule.ruleId),
];
