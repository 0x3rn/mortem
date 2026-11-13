import {
  BROWSER_DAILY_LIMIT_REASON,
  CrawlBudgetEnforcer,
  DIAGNOSTIC_CATEGORIES,
  PlatformBindingError,
  READ_ONLY_SCAN_POLICY,
  SCAN_FAILURE_CLASSES,
  SCAN_STAGES,
  advanceScanStageInD1,
  buildSmokeArtifactKey,
  capturePageAcrossViewports,
  classifyBrowserRunLimitError,
  classifyScanErrorForRetry,
  computeRetryBackoffSeconds,
  createBrowserSessionPool,
  discoverSitePages,
  fetchWithAbortTimeout,
  handleDeadLetterScanMessageInD1,
  isAllowedScanMethod,
  normalizeUrlInput,
  persistDiscoveredPagesInD1,
  persistPageCaptureEvidenceToR2AndD1,
  recordCapturedPageInD1,
  requireScanWorkerBindings,
  runAccessibilityChecks,
  runPerformanceChecks,
  runMobileChecks,
  runSecurityChecks,
  runSeoChecks,
  createPreflightHttpsRedirectProbe,
  type HttpsRedirectProbeFn,
  resolveScanBudgets,
  updateScanUsageInD1,
  type BrowserBindingLike,
  type BrowserLauncherFn,
  type MortemScanBindings,
  type PageTemplateType,
  type PlaywrightBrowserLike,
  type ScanFailureClass,
  type ScanPipelineQueueMessage,
  type ScanStage,
  type ScanStageHandlerMap,
  type WorkspacePlan,
} from "@mortem/core";
import { AXE_SOURCE } from "./axe-source";

export interface ScanQueueMessage extends ScanPipelineQueueMessage {
  kind?: "website_scan" | "scan" | "platform_smoke";
  smokeId?: string;
  scanId: string;
  workspaceId?: string;
  siteId?: string;
  targetUrl: string;
  stage?: ScanStage;
  attempt?: number;
  pageId?: string;
  idempotencyKey?: string;
  failureClass?: ScanFailureClass;
  failureReason?: string;
}

export interface QueueMessageEnvelope<T> {
  id: string;
  body: T;
  attempts?: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

export interface QueueBatch<T> {
  queue: string;
  messages: readonly QueueMessageEnvelope<T>[];
}

export interface ScheduledControllerLike {
  cron: string;
  scheduledTime: number;
}

export type ScanWorkerEnv = MortemScanBindings;

export interface BrowserSmokeCaptureResult {
  screenshot: Uint8Array;
  title: string;
}

export type BrowserSmokeCaptureFn = (
  browserBinding: BrowserBindingLike,
  targetUrl: string,
) => Promise<BrowserSmokeCaptureResult>;

export interface QueueExecutionOptions {
  browserCapture?: BrowserSmokeCaptureFn;
  browserLauncher?: BrowserLauncherFn;
  discoveryFetch?: typeof fetch;
  /** Injected `fetch` for PageSpeed Insights calls (tests); defaults to global `fetch`. */
  psiFetch?: typeof fetch;
  /** Injected backoff sleeper for PageSpeed Insights retries (tests). */
  psiSleep?: (ms: number) => Promise<void>;
  /** axe-core source for capture; defaults to the bundled build, `null` disables it (tests). */
  axeSource?: string | null;
  /** HTTP → HTTPS redirect check for security (tests); `null` disables it. */
  securityProbe?: HttpsRedirectProbeFn | null;
  /** Pages captured per queue invocation (default `CAPTURE_PAGES_PER_RUN`). */
  capturePagesPerRun?: number;
  /** Delay before the next capture run (default `CAPTURE_REQUEUE_DELAY_SECONDS`). */
  captureRequeueDelaySeconds?: number;
  /** Delay after Browser Run refuses a new browser (default `BROWSER_RATE_LIMIT_DELAY_SECONDS`). */
  browserRateLimitDelaySeconds?: number;
  stageHandlers?: ScanStageHandlerMap;
  now?: () => number;
}

/**
 * Capture one page per Worker invocation. On the Workers Free plan a queue
 * consumer that captures several pages exceeds the CPU limit (seen on staging:
 * `exceededCpu` at 64 ms), and Browser Run allows one new browser every 20 s.
 */
export const CAPTURE_PAGES_PER_RUN = 1;
/** Matches Browser Run's Free-plan rate of one new browser every 20 seconds. */
export const CAPTURE_REQUEUE_DELAY_SECONDS = 20;
/** Wait after a Browser Run 429 before trying the same page again. */
export const BROWSER_RATE_LIMIT_DELAY_SECONDS = 30;

/**
 * A capture stage that reaches the dead-letter queue (for example its run kept
 * exceeding the Worker CPU limit on one page) must not throw away the pages it
 * already captured. The pages still pending are marked failed and the scan
 * continues to the checks, ending `partial`. Returns false when nothing was
 * captured, so the caller fails the scan as before.
 */
async function continueAfterDeadLetteredCapture(params: {
  d1: NonNullable<ScanWorkerEnv["DB"]>;
  scanQueue: ScanWorkerEnv["SCAN_QUEUE"];
  message: ScanQueueMessage;
  now?: () => number;
}): Promise<boolean> {
  const { d1, message } = params;
  if (message.stage !== "capturing") {
    return false;
  }
  const scan = await d1
    .prepare(`SELECT status FROM scans WHERE id = ? LIMIT 1`)
    .bind(message.scanId)
    .first<{ status: string }>();
  if (scan?.status !== "capturing") {
    return false;
  }
  const countPages = async (statuses: string) =>
    (
      await d1
        .prepare(
          `SELECT COUNT(*) AS n FROM pages WHERE scan_id = ? AND capture_status IN (${statuses})`,
        )
        .bind(message.scanId)
        .first<{ n: number }>()
    )?.n ?? 0;
  const captured = await countPages("'captured', 'partial'");
  if (captured === 0) {
    return false;
  }

  const nowMs = params.now ? params.now() : Date.now();
  await d1
    .prepare(
      `UPDATE pages
       SET capture_status = 'failed', failure_reason = ?, updated_at = ?
       WHERE scan_id = ? AND capture_status = 'pending'`,
    )
    .bind(DEAD_LETTERED_CAPTURE_PAGE_REASON, nowMs, message.scanId)
    .run();
  const total = await countPages(
    "'pending', 'captured', 'partial', 'failed', 'skipped'",
  );
  const failed = await countPages("'failed'");
  const reason = `${failed} of ${total} page(s) could not be captured: the capture run failed repeatedly and was stopped (for example it exceeded the Worker CPU limit).`;

  await advanceScanStageInD1({
    d1,
    scanQueue: params.scanQueue as unknown as Parameters<
      typeof advanceScanStageInD1
    >[0]["scanQueue"],
    message,
    stageHandlers: {
      capturing: () => ({
        outcome: "continue",
        partialCoverage: { failureClass: "internal_error", reason },
        pagesDiscovered: total,
        pagesCaptured: captured,
        message: `Partial capture (${captured}/${total} page(s)): ${reason}`,
        metadata: { recoveredFromDeadLetter: true },
      }),
    },
    now: params.now,
  });
  return true;
}

/** Stored on pages still pending when a capture stage is dead-lettered. */
export const DEAD_LETTERED_CAPTURE_PAGE_REASON =
  "internal_error: the capture run failed repeatedly and was stopped before this page was captured (for example it exceeded the Worker CPU limit).";

export interface QueueBatchSummary {
  queue: string;
  environment: string;
  acceptedScanIds: string[];
  rejectedScanIds: string[];
  completedSmokeIds: string[];
}

export interface ScheduledRunSummary {
  cron: string;
  environment: string;
  scheduledAtIso: string;
  status: "idle" | "dispatched";
}

export async function launchCloudflarePlaywrightBrowser(
  browserBinding?: BrowserBindingLike,
): Promise<PlaywrightBrowserLike> {
  if (!browserBinding) {
    throw new PlatformBindingError(
      "MISSING_BINDING",
      "BROWSER",
      "Cloudflare Browser Rendering binding (env.BROWSER) is required to launch Playwright.",
    );
  }
  const { launch } = await import("@cloudflare/playwright");
  const browser = await launch(
    browserBinding as unknown as Parameters<typeof launch>[0],
  );
  return browser as unknown as PlaywrightBrowserLike;
}

export async function captureWithCloudflareBrowserRun(
  browserBinding: BrowserBindingLike,
  targetUrl: string,
): Promise<BrowserSmokeCaptureResult> {
  const { launch } = await import("@cloudflare/playwright");
  const browser = await launch(
    browserBinding as unknown as Parameters<typeof launch>[0],
  );
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: READ_ONLY_SCAN_POLICY.userAgent,
  });

  try {
    const page = await context.newPage();
    await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: 25_000,
    });
    const title = await page.title();
    const buffer = await page.screenshot({ type: "png" });
    return {
      screenshot: new Uint8Array(buffer),
      title: title || targetUrl,
    };
  } finally {
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

export async function executePlatformSmokeJob(
  message: ScanQueueMessage,
  rawEnv: ScanWorkerEnv,
  options: QueueExecutionOptions = {},
): Promise<{
  smokeId: string;
  r2Key: string;
  byteSize: number;
  title: string;
}> {
  const smokeId = message.smokeId;
  if (!smokeId) {
    throw new Error("platform_smoke queue message is missing smokeId.");
  }

  const normalizedUrl = normalizeUrlInput(message.targetUrl);
  if (!normalizedUrl) {
    throw new Error(
      `platform_smoke queue message has invalid targetUrl: ${message.targetUrl}`,
    );
  }

  const env = requireScanWorkerBindings(rawEnv, { requireBrowser: true });
  const browserBinding = env.BROWSER!;
  const captureFn = options.browserCapture ?? captureWithCloudflareBrowserRun;
  const r2Key = buildSmokeArtifactKey(smokeId);

  let capture: BrowserSmokeCaptureResult;
  try {
    capture = await captureFn(browserBinding, normalizedUrl);
  } catch (err) {
    const reason =
      err instanceof Error ? err.message : "Unknown Browser Rendering error";
    await env.DB.prepare(
      `UPDATE _platform_smoke_runs
       SET status = 'failed', error_message = ?, completed_at = ?
       WHERE id = ?`,
    )
      .bind(reason, new Date().toISOString(), smokeId)
      .run()
      .catch(() => undefined);

    throw new PlatformBindingError(
      "BROWSER_RENDER_FAILED",
      "BROWSER",
      `Browser Run capture failed for ${normalizedUrl}: ${reason}`,
      { cause: err },
    );
  }

  try {
    await env.EVIDENCE.put(r2Key, capture.screenshot, {
      httpMetadata: { contentType: "image/png" },
      customMetadata: {
        smokeId,
        targetUrl: normalizedUrl,
      },
    });
  } catch (err) {
    const reason =
      err instanceof Error ? err.message : "Unknown R2 write error";
    await env.DB.prepare(
      `UPDATE _platform_smoke_runs
       SET status = 'failed', error_message = ?, completed_at = ?
       WHERE id = ?`,
    )
      .bind(reason, new Date().toISOString(), smokeId)
      .run()
      .catch(() => undefined);

    throw new PlatformBindingError(
      "STORAGE_WRITE_FAILED",
      "EVIDENCE",
      `Failed to write smoke screenshot to R2 (${r2Key}): ${reason}`,
      { cause: err },
    );
  }

  const completedAt = new Date().toISOString();
  try {
    await env.DB.prepare(
      `UPDATE _platform_smoke_runs
       SET status = 'completed',
           r2_object_key = ?,
           r2_byte_size = ?,
           browser_title = ?,
           error_message = NULL,
           completed_at = ?
       WHERE id = ?`,
    )
      .bind(
        r2Key,
        capture.screenshot.byteLength,
        capture.title,
        completedAt,
        smokeId,
      )
      .run();
  } catch (err) {
    const reason =
      err instanceof Error ? err.message : "Unknown D1 update error";
    throw new PlatformBindingError(
      "DATABASE_QUERY_FAILED",
      "DB",
      `Failed to update _platform_smoke_runs in D1 for ${smokeId}: ${reason}`,
      { cause: err },
    );
  }

  return {
    smokeId,
    r2Key,
    byteSize: capture.screenshot.byteLength,
    title: capture.title,
  };
}

const worker = {
  async fetch(request: Request, env: ScanWorkerEnv = {}): Promise<Response> {
    if (!isAllowedScanMethod(request.method)) {
      return Response.json(
        {
          ok: false,
          error: "Method Not Allowed — scan worker is strictly read-only",
          allowedMethods: READ_ONLY_SCAN_POLICY.allowedHttpMethods,
        },
        {
          status: 405,
          headers: {
            allow: READ_ONLY_SCAN_POLICY.allowedHttpMethods.join(", "),
          },
        },
      );
    }

    const url = new URL(request.url);
    if (url.pathname === "/health") {
      if (request.method.toUpperCase() === "HEAD") {
        return new Response(null, { status: 200 });
      }
      return Response.json({
        ok: true,
        service: "mortem-scan-worker",
        environment: env.ENVIRONMENT ?? "development",
        bindingsConfigured: {
          DB: Boolean(env.DB),
          EVIDENCE: Boolean(env.EVIDENCE),
          BROWSER: Boolean(env.BROWSER),
          SCAN_QUEUE: Boolean(env.SCAN_QUEUE),
          SCAN_DLQ: Boolean(env.SCAN_DLQ),
        },
        policy: READ_ONLY_SCAN_POLICY,
        categories: DIAGNOSTIC_CATEGORIES,
        stages: SCAN_STAGES,
      });
    }

    return Response.json(
      {
        ok: false,
        error: "Not Found",
      },
      { status: 404 },
    );
  },

  async queue(
    batch: QueueBatch<ScanQueueMessage>,
    env: ScanWorkerEnv = {},
    options: QueueExecutionOptions = {},
  ): Promise<QueueBatchSummary> {
    const acceptedScanIds: string[] = [];
    const rejectedScanIds: string[] = [];
    const completedSmokeIds: string[] = [];
    const isDeadLetterBatch = batch.queue.includes("-dlq");

    for (const message of batch.messages) {
      const { kind, smokeId, scanId, targetUrl } = message.body;
      const attempt = message.body.attempt ?? message.attempts ?? 1;

      if (isDeadLetterBatch) {
        if (!scanId) {
          rejectedScanIds.push(message.id);
          message.ack();
          continue;
        }

        if (env.DB) {
          try {
            const salvaged = await continueAfterDeadLetteredCapture({
              d1: env.DB,
              scanQueue: env.SCAN_QUEUE,
              message: { ...message.body, attempt },
              now: options.now,
            });
            if (salvaged) {
              acceptedScanIds.push(scanId);
              message.ack();
              continue;
            }
            await handleDeadLetterScanMessageInD1({
              d1: env.DB,
              message: {
                ...message.body,
                attempt,
              },
              queueName: batch.queue,
              now: options.now,
            });
          } catch (err) {
            message.retry({
              delaySeconds: computeRetryBackoffSeconds(attempt),
            });
            throw err;
          }
        }

        acceptedScanIds.push(scanId);
        message.ack();
        continue;
      }

      const normalized = normalizeUrlInput(targetUrl);

      if (!scanId || !normalized) {
        rejectedScanIds.push(scanId || message.id);
        message.ack();
        continue;
      }

      if (kind === "platform_smoke" && smokeId) {
        try {
          await executePlatformSmokeJob(message.body, env, options);
          acceptedScanIds.push(scanId);
          completedSmokeIds.push(smokeId);
          message.ack();
        } catch (err) {
          message.retry({
            delaySeconds: computeRetryBackoffSeconds(attempt),
          });
          throw err;
        }
        continue;
      }

      if (env.DB) {
        const hasDiscoverySupport = Boolean(
          options.discoveryFetch || env.ENVIRONMENT !== "test",
        );
        const hasBrowserSupport = Boolean(
          options.browserLauncher || env.BROWSER,
        );
        const stageHandlers: ScanStageHandlerMap = {
          ...(hasDiscoverySupport
            ? {
                discovering: async (ctx) => {
                  const workspaceRow = await ctx.d1
                    .prepare(`SELECT plan FROM workspaces WHERE id = ? LIMIT 1`)
                    .bind(ctx.workspaceId)
                    .first<{ plan: WorkspacePlan }>();

                  const scanConfigRow = await ctx.d1
                    .prepare(
                      `SELECT options_json, budgets_json FROM scans WHERE id = ? LIMIT 1`,
                    )
                    .bind(ctx.scanId)
                    .first<{
                      options_json: string;
                      budgets_json: string;
                    }>();

                  const budgets = resolveScanBudgets({
                    plan: workspaceRow?.plan ?? "single",
                    budgetsJson: scanConfigRow?.budgets_json,
                    optionsJson: scanConfigRow?.options_json,
                  });

                  const baseDiscoveryFetch = options.discoveryFetch ?? fetch;
                  const boundedDiscoveryFetch: typeof fetch = (input, init) =>
                    fetchWithAbortTimeout(
                      input as string | URL,
                      init,
                      budgets.perFetchTimeoutMs,
                      baseDiscoveryFetch,
                    );

                  const discovery = await discoverSitePages({
                    targetUrl: ctx.targetUrl,
                    plan: workspaceRow?.plan ?? "single",
                    maxPages: budgets.maxPages,
                    fetchFn: boundedDiscoveryFetch,
                  });

                  if (
                    discovery.entryUrlDisallowed &&
                    discovery.selectedPages.length === 0
                  ) {
                    return {
                      outcome: "failed",
                      failureClass: "robots_disallowed",
                      failureReason: `Target URL ${ctx.targetUrl} is disallowed by ${discovery.origin}/robots.txt.`,
                      pagesDiscovered: 0,
                      metadata: {
                        origin: discovery.origin,
                        robots: discovery.robots,
                        skippedDisallowedUrls: discovery.skippedDisallowedUrls,
                      },
                    };
                  }

                  const persistedPages = await persistDiscoveredPagesInD1({
                    d1: ctx.d1,
                    scanId: ctx.scanId,
                    discovery,
                    nowMs: ctx.nowMs,
                  });

                  await updateScanUsageInD1({
                    d1: ctx.d1,
                    scanId: ctx.scanId,
                    set: {
                      pagesDiscovered: persistedPages.length,
                    },
                    nowMs: ctx.nowMs,
                  });

                  return {
                    outcome: "continue",
                    pagesDiscovered: persistedPages.length,
                    message: `Discovered ${persistedPages.length} high-value page(s) for ${discovery.origin}${
                      discovery.skippedDisallowedUrls.length > 0
                        ? ` (${discovery.skippedDisallowedUrls.length} skipped via robots.txt)`
                        : ""
                    }`,
                    metadata: {
                      origin: discovery.origin,
                      maxPages: discovery.maxPages,
                      robots: discovery.robots,
                      sitemaps: discovery.sitemaps,
                      totalCandidatesInspected:
                        discovery.totalCandidatesInspected,
                      templateBreakdown: discovery.templateBreakdown,
                      selectedUrls: persistedPages.map((p) => ({
                        pageId: p.pageId,
                        url: p.normalizedUrl,
                        category: p.category,
                        templateType: p.templateType,
                      })),
                      skippedDisallowedUrls: discovery.skippedDisallowedUrls,
                    },
                  };
                },
              }
            : {}),
          ...(hasBrowserSupport
            ? {
                capturing: async (ctx) => {
                  const workspaceRow = await ctx.d1
                    .prepare(`SELECT plan FROM workspaces WHERE id = ? LIMIT 1`)
                    .bind(ctx.workspaceId)
                    .first<{ plan: WorkspacePlan }>();

                  const scanConfigRow = await ctx.d1
                    .prepare(
                      `SELECT started_at, options_json, budgets_json, usage_json FROM scans WHERE id = ? LIMIT 1`,
                    )
                    .bind(ctx.scanId)
                    .first<{
                      started_at: number | null;
                      options_json: string;
                      budgets_json: string;
                      usage_json: string | null;
                    }>();

                  const budgets = resolveScanBudgets({
                    plan: workspaceRow?.plan ?? "single",
                    budgetsJson: scanConfigRow?.budgets_json,
                    optionsJson: scanConfigRow?.options_json,
                  });

                  // A queue redelivery starts a fresh invocation: carry over the
                  // browser time and pages that earlier attempts already used.
                  const countPages = async (statuses: string) =>
                    (
                      await ctx.d1
                        .prepare(
                          `SELECT COUNT(*) AS n FROM pages WHERE scan_id = ? AND capture_status IN (${statuses})`,
                        )
                        .bind(ctx.scanId)
                        .first<{ n: number }>()
                    )?.n ?? 0;
                  let priorBrowserMs = 0;
                  try {
                    const usage = JSON.parse(
                      scanConfigRow?.usage_json ?? "{}",
                    ) as { browserMs?: unknown };
                    priorBrowserMs =
                      typeof usage.browserMs === "number" ? usage.browserMs : 0;
                  } catch {
                    priorBrowserMs = 0; // unreadable usage counts as none used
                  }
                  const priorCaptured = await countPages(
                    "'captured', 'partial'",
                  );

                  const budgetEnforcer = new CrawlBudgetEnforcer(
                    budgets,
                    scanConfigRow?.started_at ?? ctx.nowMs,
                    { browserMs: priorBrowserMs, pagesCaptured: priorCaptured },
                  );

                  const sessionPool = createBrowserSessionPool({
                    maxConcurrentBrowsers: 2,
                  });
                  const trackedLauncher = sessionPool.createTrackedLauncher(
                    options.browserLauncher ??
                      launchCloudflarePlaywrightBrowser,
                  );

                  const pendingStmt = ctx.d1
                    .prepare(
                      `SELECT id, url, normalized_url, template_type
                       FROM pages
                       WHERE scan_id = ? AND capture_status = 'pending'
                       ORDER BY created_at ASC`,
                    )
                    .bind(ctx.scanId);
                  const pendingRes = pendingStmt.all
                    ? await pendingStmt.all<{
                        id: string;
                        url: string;
                        normalized_url: string;
                        template_type: PageTemplateType;
                      }>()
                    : { success: true, results: [] };
                  // Scans with discovered pages capture only their pending pages
                  // (a continuation run may find none left). The single-target
                  // fallback is for scans that never recorded any page.
                  const pagesRecordedBefore = await countPages(
                    "'pending', 'captured', 'partial', 'failed', 'skipped'",
                  );
                  const pendingPages =
                    ctx.pageId ||
                    ((pendingRes.results?.length ?? 0) === 0 &&
                      pagesRecordedBefore === 0)
                      ? [
                          {
                            id: ctx.pageId ?? "",
                            url: ctx.targetUrl,
                            normalized_url: ctx.targetUrl,
                            template_type: "home" as PageTemplateType,
                          },
                        ]
                      : (pendingRes.results ?? []);

                  let capturedCount = 0;
                  let processedThisRun = 0;
                  let browserRateLimited = false;
                  const pageFailureClasses: ScanFailureClass[] = [];
                  const pagesPerRun = Math.max(
                    1,
                    Math.floor(
                      options.capturePagesPerRun ?? CAPTURE_PAGES_PER_RUN,
                    ),
                  );
                  let lastCapturePageId = "";
                  let lastFinalUrl = ctx.targetUrl;
                  let lastCaptureStatus: string = "captured";
                  let lastStatusCode: number | null = 200;
                  let anyNetworkIdleTimedOut = false;
                  let totalEvidenceArtifacts = 0;
                  let totalR2BytesWritten = 0;
                  let budgetExceededReason: string | null = null;

                  try {
                    for (let idx = 0; idx < pendingPages.length; idx += 1) {
                      const targetPage = pendingPages[idx]!;
                      // One page per run by default: keeps each Worker invocation
                      // inside the plan's CPU limit and spaces browser launches.
                      if (processedThisRun >= pagesPerRun) {
                        break;
                      }
                      const currentNowMs = options.now
                        ? options.now()
                        : Date.now();
                      const budgetCheck =
                        budgetEnforcer.checkBeforeNextPage(currentNowMs);

                      if (!budgetCheck.allowed) {
                        budgetExceededReason =
                          budgetCheck.reason ?? "Scan crawl budget exceeded.";
                        for (
                          let remIdx = idx;
                          remIdx < pendingPages.length;
                          remIdx += 1
                        ) {
                          const remPage = pendingPages[remIdx]!;
                          if (remPage.id) {
                            await ctx.d1
                              .prepare(
                                `UPDATE pages
                                 SET capture_status = 'skipped',
                                     failure_reason = ?,
                                     updated_at = ?
                                 WHERE id = ?`,
                              )
                              .bind(
                                budgetExceededReason,
                                currentNowMs,
                                remPage.id,
                              )
                              .run();
                          }
                        }
                        break;
                      }

                      processedThisRun += 1;
                      try {
                        const capture = await capturePageAcrossViewports({
                          targetUrl: targetPage.url,
                          browserBinding: env.BROWSER,
                          browserLauncher: trackedLauncher,
                          navigationTimeoutMs: budgets.perPageTimeoutMs,
                          maxBytesPerPage: budgets.maxBytesPerPage,
                          now: options.now,
                          axeSource:
                            options.axeSource === undefined
                              ? AXE_SOURCE
                              : options.axeSource,
                        });
                        const { pageId } = await recordCapturedPageInD1({
                          d1: ctx.d1,
                          scanId: ctx.scanId,
                          pageId: targetPage.id || undefined,
                          templateType: targetPage.template_type,
                          capture,
                          nowMs: ctx.nowMs,
                        });

                        lastCapturePageId = pageId;
                        lastFinalUrl = capture.finalUrl;
                        lastCaptureStatus = capture.captureStatus;
                        lastStatusCode = capture.statusCode;
                        if (
                          capture.desktop.networkIdleTimedOut ||
                          capture.mobile.networkIdleTimedOut
                        ) {
                          anyNetworkIdleTimedOut = true;
                        }
                        if (capture.htmlTruncated && capture.failureReason) {
                          budgetExceededReason = capture.failureReason;
                        }

                        // Record browser time per page, so an interrupted run keeps it.
                        await updateScanUsageInD1({
                          d1: ctx.d1,
                          scanId: ctx.scanId,
                          increment: { browserMs: capture.browserMs ?? 2 },
                          nowMs: ctx.nowMs,
                        });

                        if (capture.captureStatus === "blocked") {
                          budgetEnforcer.recordPageCapture({
                            browserMs: capture.browserMs ?? 2,
                            captured: false,
                          });
                          if (idx === 0 && pendingPages.length === 1) {
                            await updateScanUsageInD1({
                              d1: ctx.d1,
                              scanId: ctx.scanId,
                              set: {
                                pagesDiscovered: pendingPages.length,
                                pagesCaptured: 0,
                              },
                              nowMs: ctx.nowMs,
                            });
                            return {
                              outcome: "failed",
                              failureClass:
                                capture.failureClass ?? "upstream_blocked",
                              failureReason:
                                capture.failureReason ??
                                `Target returned a WAF or bot challenge screen for ${targetPage.url}`,
                              pagesCaptured: 0,
                              metadata: {
                                pageId,
                                captureStatus: capture.captureStatus,
                                botProvider:
                                  capture.desktop.botChallenge.provider ??
                                  capture.mobile.botChallenge.provider,
                              },
                            };
                          }
                          continue;
                        }

                        let pageR2Bytes = 0;
                        if (env.EVIDENCE) {
                          const persistedEvidence =
                            await persistPageCaptureEvidenceToR2AndD1({
                              d1: ctx.d1,
                              r2: env.EVIDENCE,
                              scanId: ctx.scanId,
                              pageId,
                              capture,
                              nowMs: ctx.nowMs,
                            });
                          totalEvidenceArtifacts +=
                            persistedEvidence.artifacts.length;
                          totalR2BytesWritten +=
                            persistedEvidence.totalBytesWritten;
                          pageR2Bytes = persistedEvidence.totalBytesWritten;
                        }

                        budgetEnforcer.recordPageCapture({
                          browserMs: capture.browserMs ?? 2,
                          r2BytesWritten: pageR2Bytes,
                          captured: true,
                        });

                        capturedCount += 1;
                      } catch (pageErr) {
                        const pageErrMessage =
                          pageErr instanceof Error
                            ? pageErr.message
                            : String(pageErr);
                        const browserLimit =
                          classifyBrowserRunLimitError(pageErrMessage);
                        const failNowMs = options.now
                          ? options.now()
                          : Date.now();

                        if (browserLimit === "daily_limit") {
                          // No more browser time today: keep what was captured.
                          budgetExceededReason = BROWSER_DAILY_LIMIT_REASON;
                          for (
                            let remIdx = idx;
                            remIdx < pendingPages.length;
                            remIdx += 1
                          ) {
                            const remPage = pendingPages[remIdx]!;
                            if (remPage.id) {
                              await ctx.d1
                                .prepare(
                                  `UPDATE pages
                                   SET capture_status = 'skipped',
                                       failure_reason = ?,
                                       updated_at = ?
                                   WHERE id = ?`,
                                )
                                .bind(
                                  BROWSER_DAILY_LIMIT_REASON,
                                  failNowMs,
                                  remPage.id,
                                )
                                .run();
                            }
                          }
                          break;
                        }

                        if (browserLimit === "rate_limited") {
                          // Too many new browsers: the page stays pending and
                          // the stage runs again after a longer pause.
                          browserRateLimited = true;
                          break;
                        }

                        const pageClassification =
                          classifyScanErrorForRetry(pageErr);
                        if (
                          !targetPage.id ||
                          pageClassification.failureClass === "internal_error"
                        ) {
                          // Not a page problem (or no page row to record it on):
                          // let the queue retry the stage.
                          throw pageErr;
                        }

                        // One page failing must not discard the others.
                        await ctx.d1
                          .prepare(
                            `UPDATE pages
                             SET capture_status = 'failed',
                                 failure_reason = ?,
                                 updated_at = ?
                             WHERE id = ?`,
                          )
                          .bind(
                            `${pageClassification.failureClass}: ${pageErrMessage}`.slice(
                              0,
                              500,
                            ),
                            failNowMs,
                            targetPage.id,
                          )
                          .run();
                        pageFailureClasses.push(
                          pageClassification.failureClass,
                        );
                      }
                    }
                  } finally {
                    await sessionPool.closeIdleBrowsers();
                  }

                  // Count from D1, not this run: pages captured by an earlier
                  // attempt of this stage still count (production failed a scan
                  // with 2 captured pages because a redelivered run counted 0).
                  const capturedTotal = await countPages(
                    "'captured', 'partial'",
                  );
                  const pagesTotal = await countPages(
                    "'pending', 'captured', 'partial', 'failed', 'skipped'",
                  );
                  const pagesDiscovered = Math.max(
                    pagesTotal,
                    pendingPages.length,
                  );

                  await updateScanUsageInD1({
                    d1: ctx.d1,
                    scanId: ctx.scanId,
                    set: {
                      pagesDiscovered,
                      pagesCaptured: capturedTotal,
                    },
                    nowMs: ctx.nowMs,
                  });

                  const pendingLeft = await countPages("'pending'");
                  if (
                    browserRateLimited ||
                    (!budgetExceededReason && pendingLeft > 0)
                  ) {
                    // More pages to capture: run this stage again later.
                    return {
                      outcome: "requeue",
                      requeueDelaySeconds: browserRateLimited
                        ? (options.browserRateLimitDelaySeconds ??
                          BROWSER_RATE_LIMIT_DELAY_SECONDS)
                        : (options.captureRequeueDelaySeconds ??
                          CAPTURE_REQUEUE_DELAY_SECONDS),
                      pagesDiscovered,
                      pagesCaptured: capturedTotal,
                    };
                  }

                  // Pages that failed in this or an earlier run.
                  const failedTotal = await countPages("'failed'");
                  const firstFailure = await ctx.d1
                    .prepare(
                      `SELECT failure_reason FROM pages
                       WHERE scan_id = ? AND capture_status = 'failed'
                       ORDER BY updated_at ASC LIMIT 1`,
                    )
                    .bind(ctx.scanId)
                    .first<{ failure_reason: string | null }>();
                  const recordedClass = (
                    firstFailure?.failure_reason ?? ""
                  ).split(":")[0] as ScanFailureClass;
                  const pageFailureClass: ScanFailureClass =
                    pageFailureClasses[0] ??
                    (SCAN_FAILURE_CLASSES.includes(recordedClass)
                      ? recordedClass
                      : "navigation_timeout");
                  const pageFailureReason =
                    failedTotal > 0
                      ? `${failedTotal} of ${pagesDiscovered} page(s) could not be captured (first: ${firstFailure?.failure_reason ?? "unknown error"}).`
                      : null;

                  if (capturedTotal === 0) {
                    return {
                      outcome: "failed",
                      failureClass: budgetExceededReason
                        ? "budget_exceeded"
                        : pageFailureReason
                          ? pageFailureClass
                          : "upstream_blocked",
                      failureReason:
                        budgetExceededReason ??
                        pageFailureReason ??
                        `Target returned a WAF or bot challenge screen for ${ctx.targetUrl}`,
                      pagesCaptured: 0,
                      metadata: {
                        pageId: lastCapturePageId,
                        captureStatus: budgetExceededReason
                          ? "budget_exceeded"
                          : "blocked",
                      },
                    };
                  }

                  if (budgetExceededReason) {
                    // Keep going: the captured pages are still checked and scored,
                    // and the scan ends as `partial` with this reason.
                    return {
                      outcome: "continue",
                      partialCoverage: {
                        failureClass: "budget_exceeded",
                        reason: budgetExceededReason,
                      },
                      pagesDiscovered,
                      pagesCaptured: capturedTotal,
                      message: `Partial capture (${capturedTotal}/${pagesDiscovered} page(s)) within crawl budget: ${budgetExceededReason}`,
                      metadata: {
                        pageId: lastCapturePageId,
                        pagesAttempted: pendingPages.length,
                        pagesCaptured: capturedTotal,
                        capturedThisAttempt: capturedCount,
                        captureStatus: "partial",
                        budgetExceededReason,
                        browserMs: budgetEnforcer.browserMs,
                        evidenceArtifactsWritten: totalEvidenceArtifacts,
                        r2BytesWritten: totalR2BytesWritten,
                      },
                    };
                  }

                  return {
                    outcome: "continue",
                    ...(pageFailureReason
                      ? {
                          partialCoverage: {
                            failureClass: pageFailureClass,
                            reason: pageFailureReason,
                          },
                        }
                      : {}),
                    pagesDiscovered,
                    pagesCaptured: capturedTotal,
                    message:
                      pagesDiscovered > 1
                        ? `Captured desktop (1440x900) and mobile (390x844) evidence across ${capturedTotal}/${pagesDiscovered} discovered page(s)`
                        : lastCaptureStatus === "partial"
                          ? `Captured desktop and mobile viewports at network-idle timeout mark (partial) for ${lastFinalUrl}`
                          : `Captured desktop (1440x900) and mobile (390x844) evidence for ${lastFinalUrl}`,
                    metadata: {
                      pageId: lastCapturePageId,
                      pagesAttempted: pendingPages.length,
                      pagesCaptured: capturedTotal,
                      capturedThisAttempt: capturedCount,
                      pagesFailed: failedTotal,
                      captureStatus: lastCaptureStatus,
                      statusCode: lastStatusCode,
                      networkIdleTimedOut: anyNetworkIdleTimedOut,
                      browserMs: budgetEnforcer.browserMs,
                      evidenceArtifactsWritten: totalEvidenceArtifacts,
                      r2BytesWritten: totalR2BytesWritten,
                    },
                  };
                },
              }
            : {}),
          checking: async (ctx) => {
            if (!env.EVIDENCE) {
              // Fail closed: checks read and write R2 evidence, never silently skipped.
              throw new PlatformBindingError(
                "MISSING_BINDING",
                "EVIDENCE",
                "Cloudflare R2 binding 'EVIDENCE' is required to run diagnostic checks (SEO evidence and PageSpeed Insights evidence).",
              );
            }

            // SEO first: it only reads stored evidence and takes seconds, so a
            // slow or failing PageSpeed call can never delay or block it.
            const seo = await runSeoChecks({
              d1: ctx.d1,
              r2: env.EVIDENCE,
              scanId: ctx.scanId,
              nowMs: ctx.nowMs,
            });

            // Accessibility next: it also only reads stored evidence (axe ran during capture).
            const accessibility = await runAccessibilityChecks({
              d1: ctx.d1,
              r2: env.EVIDENCE,
              scanId: ctx.scanId,
              nowMs: ctx.nowMs,
            });

            // Security next: stored evidence plus one plain request to the
            // homepage's http:// address (THE-183). Tests inject or disable it.
            const security = await runSecurityChecks({
              d1: ctx.d1,
              r2: env.EVIDENCE,
              scanId: ctx.scanId,
              nowMs: ctx.nowMs,
              probe:
                options.securityProbe !== undefined
                  ? options.securityProbe
                  : env.ENVIRONMENT === "test"
                    ? null
                    : createPreflightHttpsRedirectProbe(),
            });
            const securityMessage = `Security: ${security.pagesChecked}/${security.pagesConsidered} page(s) checked, ${security.findingsWritten} security finding(s)`;

            // Mobile usability: measured during the mobile capture (THE-184).
            const mobile = await runMobileChecks({
              d1: ctx.d1,
              r2: env.EVIDENCE,
              scanId: ctx.scanId,
              nowMs: ctx.nowMs,
            });
            const mobileMessage = `Mobile: ${mobile.pagesChecked}/${mobile.pagesConsidered} page(s) checked, ${mobile.findingsWritten} mobile finding(s)`;

            const summary = await runPerformanceChecks({
              d1: ctx.d1,
              r2: env.EVIDENCE,
              scanId: ctx.scanId,
              apiKey: env.PAGESPEED_API_KEY,
              fetchFn: options.psiFetch,
              sleep: options.psiSleep,
              nowMs: ctx.nowMs,
            });

            await updateScanUsageInD1({
              d1: ctx.d1,
              scanId: ctx.scanId,
              increment: {
                psiCalls: summary.psiCalls,
                r2BytesWritten: summary.r2BytesWritten,
              },
              nowMs: ctx.nowMs,
            });

            const totalResults = summary.resultsOk + summary.resultsUnavailable;
            const seoMessage = `SEO: ${seo.pagesAnalyzed}/${seo.pagesConsidered} page(s) analyzed, ${seo.findingsWritten} SEO finding(s)${
              seo.pagesSkipped.length > 0
                ? ` (${seo.pagesSkipped.length} skipped)`
                : ""
            }`;
            const a11yMessage = `Accessibility: ${accessibility.viewportsAudited} page view(s) audited, ${accessibility.findingsWritten} accessibility finding(s)${
              accessibility.unavailable.length > 0
                ? ` (${accessibility.unavailable.length} not audited)`
                : ""
            }`;
            const psiMessage =
              totalResults === 0
                ? "No captured pages were eligible for PageSpeed Insights analysis"
                : `PageSpeed Insights: ${summary.resultsOk}/${totalResults} result(s) across ${summary.pagesAnalyzed} page(s), ${summary.findingsWritten} performance finding(s)${
                    summary.partial
                      ? ` — partial: ${summary.resultsUnavailable} result(s) unavailable`
                      : ""
                  }`;
            // Missing PSI data never ends the scan: other checks still run and the
            // scoring stage excludes the performance category with a stated reason.
            return {
              outcome: "continue",
              checksCompleted:
                seo.pagesAnalyzed +
                accessibility.viewportsAudited +
                security.pagesChecked +
                mobile.pagesChecked +
                summary.resultsOk,
              message: `${seoMessage}; ${a11yMessage}; ${securityMessage}; ${mobileMessage}; ${psiMessage}`,
              metadata: {
                mobile: {
                  pagesConsidered: mobile.pagesConsidered,
                  pagesChecked: mobile.pagesChecked,
                  pagesSkipped: mobile.pagesSkipped,
                  findingsWritten: mobile.findingsWritten,
                  rulesFired: mobile.rulesFired,
                },
                security: {
                  pagesConsidered: security.pagesConsidered,
                  pagesChecked: security.pagesChecked,
                  pagesSkipped: security.pagesSkipped,
                  pagesWithoutSecurityEvidence:
                    security.pagesWithoutSecurityEvidence,
                  probe: security.probe,
                  findingsWritten: security.findingsWritten,
                  rulesFired: security.rulesFired,
                },
                accessibility: {
                  viewportsAudited: accessibility.viewportsAudited,
                  findingsWritten: accessibility.findingsWritten,
                  rulesFired: accessibility.rulesFired,
                  needsReviewRuleCount: accessibility.needsReviewRuleCount,
                  unavailable: accessibility.unavailable,
                  coverageNote: accessibility.coverageNote,
                },
                seo: {
                  pagesConsidered: seo.pagesConsidered,
                  pagesAnalyzed: seo.pagesAnalyzed,
                  pagesSkipped: seo.pagesSkipped,
                  findingsWritten: seo.findingsWritten,
                  rulesFired: seo.rulesFired,
                },
                performance: {
                  pagesAnalyzed: summary.pagesAnalyzed,
                  resultsOk: summary.resultsOk,
                  resultsUnavailable: summary.resultsUnavailable,
                  psiCalls: summary.psiCalls,
                  findingsWritten: summary.findingsWritten,
                  partial: summary.partial,
                  unavailable: summary.unavailable.map((entry) => ({
                    pageId: entry.pageId,
                    strategy: entry.strategy,
                    reason: entry.reason,
                    message: entry.message,
                  })),
                },
              },
            };
          },
          ...options.stageHandlers,
        };

        try {
          await advanceScanStageInD1({
            d1: env.DB,
            scanQueue: env.SCAN_QUEUE as unknown as Parameters<
              typeof advanceScanStageInD1
            >[0]["scanQueue"],
            message: {
              ...message.body,
              targetUrl: normalized,
              attempt,
            },
            stageHandlers,
            now: options.now,
          });
        } catch (err) {
          const classification = classifyScanErrorForRetry(err);
          if (!classification.retryable) {
            const failNowMs = options.now ? options.now() : Date.now();
            await handleDeadLetterScanMessageInD1({
              d1: env.DB,
              message: {
                ...message.body,
                targetUrl: normalized,
                attempt,
                failureClass: classification.failureClass,
                failureReason: classification.failureReason,
              },
              queueName: "permanent-error-short-circuit",
              now: () => failNowMs,
            });
            acceptedScanIds.push(scanId);
            message.ack();
            continue;
          }

          message.retry({
            delaySeconds: computeRetryBackoffSeconds(attempt),
          });
          throw err;
        }
      }

      acceptedScanIds.push(scanId);
      message.ack();
    }

    return {
      queue: batch.queue,
      environment: env.ENVIRONMENT ?? "development",
      acceptedScanIds,
      rejectedScanIds,
      completedSmokeIds,
    };
  },

  async scheduled(
    controller: ScheduledControllerLike,
    env: ScanWorkerEnv = {},
  ): Promise<ScheduledRunSummary> {
    return {
      cron: controller.cron,
      environment: env.ENVIRONMENT ?? "development",
      scheduledAtIso: new Date(controller.scheduledTime).toISOString(),
      status: "idle",
    };
  },
};

export default worker;
