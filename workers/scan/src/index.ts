import {
  CrawlBudgetEnforcer,
  DIAGNOSTIC_CATEGORIES,
  PlatformBindingError,
  READ_ONLY_SCAN_POLICY,
  SCAN_STAGES,
  advanceScanStageInD1,
  buildSmokeArtifactKey,
  capturePageAcrossViewports,
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
  stageHandlers?: ScanStageHandlerMap;
  now?: () => number;
}

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
                      `SELECT started_at, options_json, budgets_json FROM scans WHERE id = ? LIMIT 1`,
                    )
                    .bind(ctx.scanId)
                    .first<{
                      started_at: number | null;
                      options_json: string;
                      budgets_json: string;
                    }>();

                  const budgets = resolveScanBudgets({
                    plan: workspaceRow?.plan ?? "single",
                    budgetsJson: scanConfigRow?.budgets_json,
                    optionsJson: scanConfigRow?.options_json,
                  });

                  const budgetEnforcer = new CrawlBudgetEnforcer(
                    budgets,
                    scanConfigRow?.started_at ?? ctx.nowMs,
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
                  const pendingPages =
                    !ctx.pageId && (pendingRes.results?.length ?? 0) > 0
                      ? pendingRes.results!
                      : [
                          {
                            id: ctx.pageId ?? "",
                            url: ctx.targetUrl,
                            normalized_url: ctx.targetUrl,
                            template_type: "home" as PageTemplateType,
                          },
                        ];

                  let capturedCount = 0;
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

                      const capture = await capturePageAcrossViewports({
                        targetUrl: targetPage.url,
                        browserBinding: env.BROWSER,
                        browserLauncher: trackedLauncher,
                        navigationTimeoutMs: budgets.perPageTimeoutMs,
                        maxBytesPerPage: budgets.maxBytesPerPage,
                        now: options.now,
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

                      if (capture.captureStatus === "blocked") {
                        budgetEnforcer.recordPageCapture({
                          browserMs: capture.browserMs ?? 2,
                          captured: false,
                        });
                        if (idx === 0 && pendingPages.length === 1) {
                          await updateScanUsageInD1({
                            d1: ctx.d1,
                            scanId: ctx.scanId,
                            increment: {
                              browserMs: budgetEnforcer.browserMs,
                            },
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
                    }
                  } finally {
                    await sessionPool.closeIdleBrowsers();
                  }

                  await updateScanUsageInD1({
                    d1: ctx.d1,
                    scanId: ctx.scanId,
                    increment: {
                      browserMs: budgetEnforcer.browserMs,
                    },
                    set: {
                      pagesDiscovered: pendingPages.length,
                      pagesCaptured: capturedCount,
                    },
                    nowMs: ctx.nowMs,
                  });

                  if (capturedCount === 0) {
                    return {
                      outcome: "failed",
                      failureClass: budgetExceededReason
                        ? "budget_exceeded"
                        : "upstream_blocked",
                      failureReason:
                        budgetExceededReason ??
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
                    return {
                      outcome: "partial",
                      failureClass: "budget_exceeded",
                      failureReason: budgetExceededReason,
                      pagesDiscovered: pendingPages.length,
                      pagesCaptured: capturedCount,
                      message: `Completed partial capture (${capturedCount}/${pendingPages.length} page(s)) within crawl budget: ${budgetExceededReason}`,
                      metadata: {
                        pageId: lastCapturePageId,
                        pagesAttempted: pendingPages.length,
                        pagesCaptured: capturedCount,
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
                    pagesDiscovered: pendingPages.length,
                    pagesCaptured: capturedCount,
                    message:
                      pendingPages.length > 1
                        ? `Captured desktop (1440x900) and mobile (390x844) evidence across ${capturedCount}/${pendingPages.length} discovered page(s)`
                        : lastCaptureStatus === "partial"
                          ? `Captured desktop and mobile viewports at network-idle timeout mark (partial) for ${lastFinalUrl}`
                          : `Captured desktop (1440x900) and mobile (390x844) evidence for ${lastFinalUrl}`,
                    metadata: {
                      pageId: lastCapturePageId,
                      pagesAttempted: pendingPages.length,
                      pagesCaptured: capturedCount,
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
