import {
  PlatformBindingError,
  type BrowserBindingLike,
  type D1DatabaseLike,
} from "./cloudflare";
import type {
  BrowserLauncherFn,
  PlaywrightBrowserContextLike,
  PlaywrightBrowserLike,
  PlaywrightContextOptions,
  PlaywrightPageLike,
} from "./browser-capture";
import { ScanIntakeError } from "./intake";
import type {
  ScanBudgetsJson,
  ScanFailureClass,
  ScanOptionsJson,
  ScanUsageJson,
} from "./schema/scans";
import { resolvePlanPageCap } from "./site-discovery";
import type { WorkspacePlan } from "./workspaces";

export interface ResolvedScanBudgets {
  maxPages: number;
  maxWallTimeMs: number;
  maxBytesPerPage: number;
  maxBrowserMs: number;
  maxExternalLinkChecks: number;
  perFetchTimeoutMs: number;
  perPageTimeoutMs: number;
  maxAiInputTokens: number;
  maxAiOutputTokens: number;
}

export const DEFAULT_SCAN_BUDGETS: Readonly<
  Omit<ResolvedScanBudgets, "maxPages">
> = {
  maxWallTimeMs: 90_000,
  maxBytesPerPage: 10 * 1024 * 1024, // 10 MB per page HTML/payload cap
  maxBrowserMs: 60_000,
  maxExternalLinkChecks: 50,
  perFetchTimeoutMs: 10_000,
  perPageTimeoutMs: 25_000,
  maxAiInputTokens: 24_000,
  maxAiOutputTokens: 4_000,
};

/**
 * Resolves hard crawl and execution budgets for a scan from the workspace plan,
 * `scans.budgets_json`, and `scans.options_json`.
 */
export function resolveScanBudgets(params: {
  plan?: WorkspacePlan | "preview" | string | null;
  budgetsJson?: ScanBudgetsJson | string | null;
  optionsJson?: ScanOptionsJson | string | null;
}): ResolvedScanBudgets {
  let parsedBudgets: ScanBudgetsJson = {};
  if (typeof params.budgetsJson === "string" && params.budgetsJson.trim()) {
    try {
      parsedBudgets = JSON.parse(params.budgetsJson) as ScanBudgetsJson;
    } catch {
      parsedBudgets = {};
    }
  } else if (params.budgetsJson && typeof params.budgetsJson === "object") {
    parsedBudgets = params.budgetsJson;
  }

  let parsedOptions: ScanOptionsJson = {};
  if (typeof params.optionsJson === "string" && params.optionsJson.trim()) {
    try {
      parsedOptions = JSON.parse(params.optionsJson) as ScanOptionsJson;
    } catch {
      parsedOptions = {};
    }
  } else if (params.optionsJson && typeof params.optionsJson === "object") {
    parsedOptions = params.optionsJson;
  }

  const requestedMaxPages = parsedBudgets.maxPages ?? parsedOptions.maxPages;
  const maxPages = resolvePlanPageCap(
    (params.plan ?? undefined) as WorkspacePlan | "preview" | undefined,
    requestedMaxPages,
  );

  const rawWallTime =
    parsedBudgets.maxWallTimeMs ??
    parsedBudgets.maxWallClockMs ??
    DEFAULT_SCAN_BUDGETS.maxWallTimeMs;

  return {
    maxPages,
    maxWallTimeMs: Math.max(1_000, Math.floor(rawWallTime)),
    maxBytesPerPage: Math.max(
      1_024,
      Math.floor(
        parsedBudgets.maxBytesPerPage ?? DEFAULT_SCAN_BUDGETS.maxBytesPerPage,
      ),
    ),
    maxBrowserMs: Math.max(
      500,
      Math.floor(
        parsedBudgets.maxBrowserMs ?? DEFAULT_SCAN_BUDGETS.maxBrowserMs,
      ),
    ),
    maxExternalLinkChecks: Math.max(
      0,
      Math.floor(
        parsedBudgets.maxExternalLinkChecks ??
          DEFAULT_SCAN_BUDGETS.maxExternalLinkChecks,
      ),
    ),
    perFetchTimeoutMs: Math.max(
      500,
      Math.floor(
        parsedBudgets.perFetchTimeoutMs ??
          DEFAULT_SCAN_BUDGETS.perFetchTimeoutMs,
      ),
    ),
    perPageTimeoutMs: Math.max(
      1_000,
      Math.floor(
        parsedBudgets.perPageTimeoutMs ?? DEFAULT_SCAN_BUDGETS.perPageTimeoutMs,
      ),
    ),
    maxAiInputTokens: Math.max(
      0,
      Math.floor(
        parsedBudgets.maxAiInputTokens ?? DEFAULT_SCAN_BUDGETS.maxAiInputTokens,
      ),
    ),
    maxAiOutputTokens: Math.max(
      0,
      Math.floor(
        parsedBudgets.maxAiOutputTokens ??
          DEFAULT_SCAN_BUDGETS.maxAiOutputTokens,
      ),
    ),
  };
}

export type ExceededBudgetKind =
  | "maxWallTimeMs"
  | "maxBrowserMs"
  | "maxPages"
  | "maxBytesPerPage"
  | "maxExternalLinkChecks";

export interface BudgetCheckResult {
  allowed: boolean;
  exceededBudget: ExceededBudgetKind | null;
  reason: string | null;
}

export interface HtmlPayloadBudgetResult {
  html: string;
  originalBytes: number;
  byteSize: number;
  truncated: boolean;
  reason: string | null;
}

export class CrawlBudgetEnforcer {
  readonly budgets: ResolvedScanBudgets;
  readonly startedAtMs: number;
  private _pagesCaptured = 0;
  private _browserMs = 0;
  private _r2BytesWritten = 0;
  private _psiCalls = 0;
  private _externalLinkChecks = 0;

  constructor(budgets: ResolvedScanBudgets, startedAtMs = Date.now()) {
    this.budgets = budgets;
    this.startedAtMs = startedAtMs;
  }

  get pagesCaptured(): number {
    return this._pagesCaptured;
  }

  get browserMs(): number {
    return this._browserMs;
  }

  get r2BytesWritten(): number {
    return this._r2BytesWritten;
  }

  get psiCalls(): number {
    return this._psiCalls;
  }

  get externalLinkChecks(): number {
    return this._externalLinkChecks;
  }

  checkBeforeNextPage(nowMs = Date.now()): BudgetCheckResult {
    const elapsedWallMs = Math.max(0, nowMs - this.startedAtMs);
    if (elapsedWallMs >= this.budgets.maxWallTimeMs) {
      return {
        allowed: false,
        exceededBudget: "maxWallTimeMs",
        reason: `Scan wall-clock budget exceeded (${elapsedWallMs}ms >= ${this.budgets.maxWallTimeMs}ms).`,
      };
    }

    if (this._browserMs >= this.budgets.maxBrowserMs) {
      return {
        allowed: false,
        exceededBudget: "maxBrowserMs",
        reason: `Scan browser execution budget exceeded (${this._browserMs}ms >= ${this.budgets.maxBrowserMs}ms).`,
      };
    }

    if (this._pagesCaptured >= this.budgets.maxPages) {
      return {
        allowed: false,
        exceededBudget: "maxPages",
        reason: `Scan maxPages cap reached (${this._pagesCaptured} >= ${this.budgets.maxPages}).`,
      };
    }

    return {
      allowed: true,
      exceededBudget: null,
      reason: null,
    };
  }

  checkBeforeExternalLinkCheck(nowMs = Date.now()): BudgetCheckResult {
    const elapsedWallMs = Math.max(0, nowMs - this.startedAtMs);
    if (elapsedWallMs >= this.budgets.maxWallTimeMs) {
      return {
        allowed: false,
        exceededBudget: "maxWallTimeMs",
        reason: `Scan wall-clock budget exceeded (${elapsedWallMs}ms >= ${this.budgets.maxWallTimeMs}ms).`,
      };
    }
    if (this._externalLinkChecks >= this.budgets.maxExternalLinkChecks) {
      return {
        allowed: false,
        exceededBudget: "maxExternalLinkChecks",
        reason: `External link check budget reached (${this._externalLinkChecks} >= ${this.budgets.maxExternalLinkChecks}).`,
      };
    }
    return {
      allowed: true,
      exceededBudget: null,
      reason: null,
    };
  }

  enforceHtmlPayloadBudget(rawHtml: string): HtmlPayloadBudgetResult {
    const encoded = new TextEncoder().encode(rawHtml);
    const originalBytes = encoded.byteLength;
    if (originalBytes <= this.budgets.maxBytesPerPage) {
      return {
        html: rawHtml,
        originalBytes,
        byteSize: originalBytes,
        truncated: false,
        reason: null,
      };
    }

    const sliced = encoded.subarray(0, this.budgets.maxBytesPerPage);
    const truncatedHtml = new TextDecoder("utf-8", { fatal: false }).decode(
      sliced,
    );
    return {
      html: truncatedHtml,
      originalBytes,
      byteSize: sliced.byteLength,
      truncated: true,
      reason: `Rendered HTML size (${originalBytes} bytes) exceeded maxBytesPerPage budget (${this.budgets.maxBytesPerPage} bytes) and was truncated.`,
    };
  }

  recordPageCapture(params: {
    browserMs: number;
    r2BytesWritten?: number;
    captured: boolean;
  }): void {
    this._browserMs += Math.max(0, Math.round(params.browserMs));
    this._r2BytesWritten += Math.max(0, Math.round(params.r2BytesWritten ?? 0));
    if (params.captured) {
      this._pagesCaptured += 1;
    }
  }

  recordPsiCall(count = 1): void {
    this._psiCalls += Math.max(0, count);
  }

  recordExternalLinkCheck(count = 1): void {
    this._externalLinkChecks += Math.max(0, count);
  }
}

/**
 * Executes an HTTP `fetch` with a hard `AbortSignal.timeout(timeoutMs)` budget.
 */
export async function fetchWithAbortTimeout(
  url: string | URL,
  init: RequestInit = {},
  timeoutMs = DEFAULT_SCAN_BUDGETS.perFetchTimeoutMs,
  fetchFn: typeof fetch = fetch,
): Promise<Response> {
  const safeTimeoutMs = Math.max(100, Math.floor(timeoutMs));
  const timeoutSignal = AbortSignal.timeout(safeTimeoutMs);
  const combinedSignal = init.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal;

  return fetchFn(url, {
    ...init,
    signal: combinedSignal,
  });
}

export interface ErrorRetryClassification {
  retryable: boolean;
  failureClass: ScanFailureClass;
  failureReason: string;
  statusCode?: number;
}

/**
 * Classifies an error encountered during scan queue processing as either:
 * - **Transient (`retryable: true`)**: Network blips, navigation timeouts, R2/D1 transient errors,
 *   or Browser Run capacity/rate-limit errors (`429`, `503`), which should be retried with exponential backoff.
 * - **Permanent (`retryable: false`)**: SSRF blocks (`ssrf_blocked`), DNS NXDOMAIN (`dns_resolution_failed`),
 *   `robots_disallowed`, invalid TLS certificates, infinite redirect loops, or HTTP `404`/`410` on the target,
 *   which should skip retries and immediately transition the scan to `failed` or `partial`.
 */
export function classifyScanErrorForRetry(
  error: unknown,
): ErrorRetryClassification {
  if (error instanceof ScanIntakeError) {
    if (error.code === "dns_failed") {
      return {
        retryable: false,
        failureClass: "dns_resolution_failed",
        failureReason: error.message,
      };
    }
    return {
      retryable: false,
      failureClass: "ssrf_blocked",
      failureReason: error.message,
    };
  }

  const rawMessage =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Unknown scan execution error";
  const lower = rawMessage.toLowerCase();

  // 1. Permanent SSRF blocks
  if (
    lower.includes("ssrf_blocked") ||
    lower.includes("blocked by ssrf guard") ||
    lower.includes("private or reserved ip") ||
    lower.includes("loopback")
  ) {
    return {
      retryable: false,
      failureClass: "ssrf_blocked",
      failureReason: rawMessage,
    };
  }

  // 2. Permanent robots.txt disallow
  if (lower.includes("robots_disallowed") || lower.includes("disallowed by")) {
    return {
      retryable: false,
      failureClass: "robots_disallowed",
      failureReason: rawMessage,
    };
  }

  // 3. Permanent invalid TLS / SSL certificate errors
  if (
    lower.includes("err_cert_") ||
    lower.includes("cert_has_expired") ||
    lower.includes("unable_to_verify_leaf_signature") ||
    lower.includes("depth_zero_self_signed_cert") ||
    lower.includes("self_signed_cert_in_chain") ||
    lower.includes("err_ssl_") ||
    lower.includes("ssl_error") ||
    lower.includes("invalid tls") ||
    lower.includes("tls handshake failed")
  ) {
    return {
      retryable: false,
      failureClass: "upstream_blocked",
      failureReason: `Target TLS/SSL verification failed: ${rawMessage}`,
    };
  }

  // 4. Permanent DNS resolution failure (NXDOMAIN / ENOTFOUND)
  if (
    lower.includes("enotfound") ||
    lower.includes("nxdomain") ||
    lower.includes("err_name_not_resolved") ||
    lower.includes("dns_resolution_failed")
  ) {
    return {
      retryable: false,
      failureClass: "dns_resolution_failed",
      failureReason: rawMessage,
    };
  }

  // 5. Permanent infinite redirect loop
  if (
    lower.includes("redirect loop") ||
    lower.includes("too many redirects") ||
    lower.includes("err_too_many_redirects") ||
    lower.includes("exceeded maximum redirects")
  ) {
    return {
      retryable: false,
      failureClass: "navigation_timeout",
      failureReason: rawMessage,
    };
  }

  // 6. Permanent HTTP 404 / 410 Not Found on entry target
  if (
    /\b(?:http\s+404|status\s+404|404\s+not\s+found|http\s+410|status\s+410)\b/i.test(
      rawMessage,
    )
  ) {
    return {
      retryable: false,
      failureClass: "upstream_blocked",
      failureReason: rawMessage,
      statusCode: lower.includes("410") ? 410 : 404,
    };
  }

  // 7. Transient Browser Run capacity / 429 / 503 errors
  if (
    /\b(?:429|503)\b/.test(rawMessage) ||
    lower.includes("too many requests") ||
    lower.includes("service unavailable") ||
    lower.includes("browser run capacity") ||
    lower.includes("concurrent browser") ||
    lower.includes("rate limit")
  ) {
    return {
      retryable: true,
      failureClass: "browser_crash",
      failureReason: rawMessage,
      statusCode: lower.includes("429") ? 429 : 503,
    };
  }

  // 8. Transient navigation / abort / socket timeouts
  if (
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("aborted") ||
    lower.includes("etimedout") ||
    lower.includes("econnreset")
  ) {
    return {
      retryable: true,
      failureClass: "navigation_timeout",
      failureReason: rawMessage,
    };
  }

  // 9. Platform binding errors (R2/D1/Browser transient errors are retryable unless missing binding)
  if (error instanceof PlatformBindingError) {
    if (error.code === "MISSING_BINDING") {
      return {
        retryable: false,
        failureClass: "internal_error",
        failureReason: error.message,
      };
    }
    return {
      retryable: true,
      failureClass:
        error.code === "BROWSER_RENDER_FAILED"
          ? "browser_crash"
          : "internal_error",
      failureReason: error.message,
    };
  }

  return {
    retryable: true,
    failureClass: "internal_error",
    failureReason: rawMessage,
  };
}

export interface BrowserSessionPoolStats {
  maxConcurrentBrowsers: number;
  activeBrowsers: number;
  activeContexts: number;
  activePages: number;
  totalBrowsersLaunched: number;
  totalBrowsersClosed: number;
  totalContextsOpened: number;
  totalContextsClosed: number;
  totalPagesOpened: number;
  totalPagesClosed: number;
  sessionReuses: number;
}

export interface BrowserSessionPool {
  getStats(): BrowserSessionPoolStats;
  createTrackedLauncher(baseLauncher: BrowserLauncherFn): BrowserLauncherFn;
  withBrowserSession<T>(
    baseLauncher: BrowserLauncherFn,
    browserBinding: BrowserBindingLike | undefined,
    fn: (browser: PlaywrightBrowserLike) => Promise<T>,
  ): Promise<T>;
  closeIdleBrowsers(): Promise<void>;
}

/**
 * Creates a Browser Run session pool & leak-free lifecycle tracker that:
 * 1. Enforces `maxConcurrentBrowsers` (default `2`) so concurrent scans respect Cloudflare Browser Run limits.
 * 2. Optionally reuses a warm browser session across sequential captures (`reuseWarmSession: true`) while
 *    always isolating every viewport in a fresh `BrowserContext` that is guaranteed to close in `finally`.
 * 3. Tracks every opened/closed `Browser`, `BrowserContext`, and `Page` so zero contexts or pages ever leak.
 */
export function createBrowserSessionPool(options?: {
  maxConcurrentBrowsers?: number;
  reuseWarmSession?: boolean;
}): BrowserSessionPool {
  const maxConcurrentBrowsers = Math.max(
    1,
    Math.floor(options?.maxConcurrentBrowsers ?? 2),
  );
  const reuseWarmSession = options?.reuseWarmSession ?? false;

  let activeBrowsers = 0;
  let activeContexts = 0;
  let activePages = 0;
  let totalBrowsersLaunched = 0;
  let totalBrowsersClosed = 0;
  let totalContextsOpened = 0;
  let totalContextsClosed = 0;
  let totalPagesOpened = 0;
  let totalPagesClosed = 0;
  let sessionReuses = 0;

  let warmBrowser: PlaywrightBrowserLike | null = null;
  let warmBrowserRawClose: (() => Promise<void>) | null = null;
  const waitQueue: Array<() => void> = [];

  async function acquireSlot(): Promise<void> {
    if (activeBrowsers < maxConcurrentBrowsers) {
      activeBrowsers += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      waitQueue.push(resolve);
    });
    activeBrowsers += 1;
  }

  function releaseSlot(): void {
    activeBrowsers = Math.max(0, activeBrowsers - 1);
    const next = waitQueue.shift();
    if (next) {
      next();
    }
  }

  function wrapPage(rawPage: PlaywrightPageLike): PlaywrightPageLike {
    activePages += 1;
    totalPagesOpened += 1;
    let pageClosed = false;

    const closePageOnce = async (): Promise<void> => {
      if (pageClosed) return;
      pageClosed = true;
      activePages = Math.max(0, activePages - 1);
      totalPagesClosed += 1;
      await rawPage.close().catch(() => undefined);
    };

    return {
      ...rawPage,
      addInitScript: rawPage.addInitScript.bind(rawPage),
      route: rawPage.route.bind(rawPage),
      on: rawPage.on.bind(rawPage),
      goto: rawPage.goto.bind(rawPage),
      waitForLoadState: rawPage.waitForLoadState.bind(rawPage),
      evaluate: rawPage.evaluate.bind(rawPage),
      content: rawPage.content.bind(rawPage),
      title: rawPage.title.bind(rawPage),
      url: rawPage.url.bind(rawPage),
      screenshot: rawPage.screenshot.bind(rawPage),
      close: closePageOnce,
    };
  }

  function wrapContext(
    rawContext: PlaywrightBrowserContextLike,
  ): PlaywrightBrowserContextLike & { forceCleanupPages(): Promise<void> } {
    activeContexts += 1;
    totalContextsOpened += 1;
    let contextClosed = false;
    const contextPages: PlaywrightPageLike[] = [];

    const closeContextOnce = async (): Promise<void> => {
      if (contextClosed) return;
      contextClosed = true;
      for (const p of contextPages) {
        await p.close().catch(() => undefined);
      }
      activeContexts = Math.max(0, activeContexts - 1);
      totalContextsClosed += 1;
      await rawContext.close().catch(() => undefined);
    };

    return {
      async newPage(): Promise<PlaywrightPageLike> {
        const rawPage = await rawContext.newPage();
        const trackedPage = wrapPage(rawPage);
        contextPages.push(trackedPage);
        return trackedPage;
      },
      close: closeContextOnce,
      forceCleanupPages: closeContextOnce,
    };
  }

  function createTrackedLauncher(
    baseLauncher: BrowserLauncherFn,
  ): BrowserLauncherFn {
    return async (
      browserBinding?: BrowserBindingLike,
    ): Promise<PlaywrightBrowserLike> => {
      await acquireSlot();

      let rawBrowser: PlaywrightBrowserLike;
      let isReused = false;
      try {
        if (reuseWarmSession && warmBrowser) {
          rawBrowser = warmBrowser;
          isReused = true;
          sessionReuses += 1;
        } else {
          rawBrowser = await baseLauncher(browserBinding);
          totalBrowsersLaunched += 1;
          if (reuseWarmSession) {
            warmBrowser = rawBrowser;
            warmBrowserRawClose = () => rawBrowser.close();
          }
        }
      } catch (err) {
        releaseSlot();
        throw err;
      }

      const openContexts: Array<
        PlaywrightBrowserContextLike & { forceCleanupPages(): Promise<void> }
      > = [];
      let released = false;

      return {
        async newContext(
          ctxOptions: PlaywrightContextOptions,
        ): Promise<PlaywrightBrowserContextLike> {
          const rawCtx = await rawBrowser.newContext(ctxOptions);
          const trackedCtx = wrapContext(rawCtx);
          openContexts.push(trackedCtx);
          return trackedCtx;
        },
        async close(): Promise<void> {
          if (released) return;
          released = true;
          try {
            // Guarantee any contexts opened on this browser handle are closed even if caller forgot
            for (const ctx of openContexts) {
              await ctx.forceCleanupPages().catch(() => undefined);
            }
            if (!reuseWarmSession) {
              totalBrowsersClosed += 1;
              await rawBrowser.close().catch(() => undefined);
            }
          } finally {
            releaseSlot();
            if (isReused) {
              // Keep warmBrowser reference alive until closeIdleBrowsers()
            }
          }
        },
      };
    };
  }

  return {
    getStats(): BrowserSessionPoolStats {
      return {
        maxConcurrentBrowsers,
        activeBrowsers,
        activeContexts,
        activePages,
        totalBrowsersLaunched,
        totalBrowsersClosed,
        totalContextsOpened,
        totalContextsClosed,
        totalPagesOpened,
        totalPagesClosed,
        sessionReuses,
      };
    },
    createTrackedLauncher,
    async withBrowserSession<T>(
      baseLauncher: BrowserLauncherFn,
      browserBinding: BrowserBindingLike | undefined,
      fn: (browser: PlaywrightBrowserLike) => Promise<T>,
    ): Promise<T> {
      const trackedLauncher = createTrackedLauncher(baseLauncher);
      const browser = await trackedLauncher(browserBinding);
      try {
        return await fn(browser);
      } finally {
        await browser.close().catch(() => undefined);
      }
    },
    async closeIdleBrowsers(): Promise<void> {
      if (warmBrowser && warmBrowserRawClose) {
        const closeFn = warmBrowserRawClose;
        warmBrowser = null;
        warmBrowserRawClose = null;
        totalBrowsersClosed += 1;
        await closeFn().catch(() => undefined);
      }
    },
  };
}

/**
 * Updates `scans.usage_json` in D1 with accumulated or explicit telemetry values
 * (`browserMs`, `browserDurationMs`, `r2BytesWritten`, `psiCalls`, `psiRequests`,
 * `pagesDiscovered`, `pagesCaptured`).
 */
export async function updateScanUsageInD1(params: {
  d1: D1DatabaseLike;
  scanId: string;
  increment?: {
    browserMs?: number;
    r2BytesWritten?: number;
    psiCalls?: number;
  };
  set?: {
    pagesDiscovered?: number;
    pagesCaptured?: number;
    browserMs?: number;
    r2BytesWritten?: number;
    psiCalls?: number;
  };
  nowMs?: number;
}): Promise<ScanUsageJson> {
  const nowMs = params.nowMs ?? Date.now();
  const row = await params.d1
    .prepare(`SELECT usage_json FROM scans WHERE id = ? LIMIT 1`)
    .bind(params.scanId)
    .first<{ usage_json: string }>();

  let current: ScanUsageJson = {};
  if (row?.usage_json) {
    try {
      current = JSON.parse(row.usage_json) as ScanUsageJson;
    } catch {
      current = {};
    }
  }

  const prevBrowserMs = current.browserMs ?? current.browserDurationMs ?? 0;
  const nextBrowserMs =
    params.set?.browserMs !== undefined
      ? params.set.browserMs
      : prevBrowserMs + (params.increment?.browserMs ?? 0);

  const prevR2Bytes = current.r2BytesWritten ?? 0;
  const nextR2Bytes =
    params.set?.r2BytesWritten !== undefined
      ? params.set.r2BytesWritten
      : prevR2Bytes + (params.increment?.r2BytesWritten ?? 0);

  const prevPsiCalls = current.psiCalls ?? current.psiRequests ?? 0;
  const nextPsiCalls =
    params.set?.psiCalls !== undefined
      ? params.set.psiCalls
      : prevPsiCalls + (params.increment?.psiCalls ?? 0);

  const nextPagesDiscovered =
    params.set?.pagesDiscovered !== undefined
      ? params.set.pagesDiscovered
      : (current.pagesDiscovered ?? 0);

  const nextPagesCaptured =
    params.set?.pagesCaptured !== undefined
      ? params.set.pagesCaptured
      : (current.pagesCaptured ?? 0);

  const updated: ScanUsageJson = {
    ...current,
    pagesDiscovered: nextPagesDiscovered,
    pagesCaptured: nextPagesCaptured,
    browserMs: nextBrowserMs,
    browserDurationMs: nextBrowserMs,
    r2BytesWritten: nextR2Bytes,
    psiCalls: nextPsiCalls,
    psiRequests: nextPsiCalls,
  };

  await params.d1
    .prepare(`UPDATE scans SET usage_json = ?, updated_at = ? WHERE id = ?`)
    .bind(JSON.stringify(updated), nowMs, params.scanId)
    .run();

  return updated;
}
