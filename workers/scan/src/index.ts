import {
  DIAGNOSTIC_CATEGORIES,
  PlatformBindingError,
  READ_ONLY_SCAN_POLICY,
  SCAN_STAGES,
  buildSmokeArtifactKey,
  isAllowedScanMethod,
  normalizeUrlInput,
  requireScanWorkerBindings,
  type BrowserBindingLike,
  type MortemScanBindings,
  type ScanStage,
} from "@mortem/core";

export interface ScanQueueMessage {
  kind?: "scan" | "platform_smoke";
  smokeId?: string;
  scanId: string;
  targetUrl: string;
  stage?: ScanStage;
}

export interface QueueMessageEnvelope<T> {
  id: string;
  body: T;
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

    for (const message of batch.messages) {
      const { kind, smokeId, scanId, targetUrl } = message.body;
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
          message.retry({ delaySeconds: 5 });
          throw err;
        }
        continue;
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
