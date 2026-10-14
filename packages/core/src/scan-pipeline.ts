import type { D1DatabaseLike, QueueLike } from "./cloudflare";
import type { ScanStage } from "./index";
import { SCAN_FAILURE_CLASSES, type ScanFailureClass } from "./schema/scans";

export const ORDERED_ACTIVE_SCAN_STAGES = [
  "discovering",
  "capturing",
  "checking",
  "scoring",
  "generating_report",
] as const;

export type ActiveScanStage = (typeof ORDERED_ACTIVE_SCAN_STAGES)[number];

export const TERMINAL_SCAN_STAGES = ["complete", "partial", "failed"] as const;

export type TerminalScanStage = (typeof TERMINAL_SCAN_STAGES)[number];

export interface ScanPipelineQueueMessage {
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

export interface ScanStageHandlerContext {
  d1: D1DatabaseLike;
  scanId: string;
  workspaceId: string;
  siteId: string;
  targetUrl: string;
  stage: ActiveScanStage;
  attempt: number;
  pageId?: string;
  idempotencyKey: string;
  nowMs: number;
}

export interface ScanStageExecutionResult {
  outcome?: "continue" | "complete" | "partial" | "failed";
  message?: string;
  pagesDiscovered?: number;
  pagesCaptured?: number;
  checksCompleted?: number;
  metadata?: Record<string, unknown>;
  failureClass?: ScanFailureClass;
  failureReason?: string;
}

export type ScanStageHandler = (
  context: ScanStageHandlerContext,
) => Promise<ScanStageExecutionResult> | ScanStageExecutionResult;

export type ScanStageHandlerMap = Partial<
  Record<ActiveScanStage, ScanStageHandler>
>;

export interface AdvanceScanStageOptions {
  d1: D1DatabaseLike;
  scanQueue?: QueueLike<ScanPipelineQueueMessage>;
  message: ScanPipelineQueueMessage;
  stageHandlers?: ScanStageHandlerMap;
  now?: () => number;
}

export interface AdvanceScanStageResult {
  action:
    "advanced" | "completed" | "failed" | "skipped_idempotent" | "missing_scan";
  scanId: string;
  executedStage: ActiveScanStage;
  currentStatus: ScanStage;
  nextStage: ActiveScanStage | null;
  idempotencyKey: string;
}

export interface DeadLetterScanResult {
  action: "marked_failed" | "skipped_already_terminal" | "missing_scan";
  scanId: string;
  failedStage: ScanStage;
  failureClass: ScanFailureClass;
  failureReason: string;
  idempotencyKey: string;
}

const STAGE_ORDER_INDEX: Readonly<Record<ScanStage, number>> = {
  queued: 0,
  discovering: 1,
  capturing: 2,
  checking: 3,
  scoring: 4,
  generating_report: 5,
  complete: 6,
  partial: 6,
  failed: 6,
};

const DEFAULT_STAGE_MESSAGES: Readonly<
  Record<ActiveScanStage, (targetUrl: string) => string>
> = {
  discovering: (targetUrl) =>
    `Discovering high-value pages and robots policy for ${targetUrl}`,
  capturing: (targetUrl) =>
    `Capturing desktop and mobile evidence artifacts for ${targetUrl}`,
  checking: (targetUrl) =>
    `Running deterministic diagnostic checks for ${targetUrl}`,
  scoring: (targetUrl) =>
    `Calculating transparent category and overall health scores for ${targetUrl}`,
  generating_report: (targetUrl) =>
    `Assembling structured diagnostic report for ${targetUrl}`,
};

export function isTerminalScanStage(
  stage: string | null | undefined,
): stage is TerminalScanStage {
  return stage === "complete" || stage === "partial" || stage === "failed";
}

export function resolveActiveScanStage(
  stage: ScanStage | undefined,
): ActiveScanStage {
  if (!stage || stage === "queued") {
    return "discovering";
  }
  if (
    stage === "discovering" ||
    stage === "capturing" ||
    stage === "checking" ||
    stage === "scoring" ||
    stage === "generating_report"
  ) {
    return stage;
  }
  return "discovering";
}

export function getNextActiveScanStage(
  stage: ActiveScanStage,
): ActiveScanStage | null {
  const index = ORDERED_ACTIVE_SCAN_STAGES.indexOf(stage);
  if (index < 0 || index + 1 >= ORDERED_ACTIVE_SCAN_STAGES.length) {
    return null;
  }
  return ORDERED_ACTIVE_SCAN_STAGES[index + 1] ?? null;
}

export function buildScanStageIdempotencyKey(
  scanId: string,
  stage: ScanStage,
  pageId?: string,
): string {
  const trimmedPageId = pageId?.trim();
  if (trimmedPageId) {
    return `${scanId}:${stage}:${trimmedPageId}`;
  }
  return `${scanId}:${stage}`;
}

/**
 * Exponential retry delay in seconds for transient Cloudflare Queue failures.
 * Attempt 1 -> 5s, Attempt 2 -> 15s, Attempt 3 -> 45s (capped at 120s).
 */
export function computeRetryBackoffSeconds(attempt = 1): number {
  const normalizedAttempt = Math.max(1, Math.floor(attempt));
  const delay = 5 * Math.pow(3, normalizedAttempt - 1);
  return Math.min(120, delay);
}

function normalizeFailureClass(
  candidate: string | undefined,
  fallback: ScanFailureClass = "internal_error",
): ScanFailureClass {
  if (
    candidate &&
    (SCAN_FAILURE_CLASSES as readonly string[]).includes(candidate)
  ) {
    return candidate as ScanFailureClass;
  }
  return fallback;
}

interface ScanLifecycleRow {
  id: string;
  workspace_id: string;
  site_id: string;
  target_url: string;
  normalized_url: string;
  status: ScanStage;
  started_at: number | null;
  completed_at: number | null;
}

interface ExistingScanEventRow {
  id: string;
  stage: ScanStage;
  pages_discovered: number;
  pages_captured: number;
  checks_completed: number;
  metadata_json: string;
}

function hasIdempotencyKeyInEvents(
  events: readonly ExistingScanEventRow[],
  idempotencyKey: string,
): boolean {
  for (const event of events) {
    try {
      const parsed = JSON.parse(event.metadata_json) as Record<string, unknown>;
      if (parsed && parsed.idempotencyKey === idempotencyKey) {
        return true;
      }
    } catch {
      // Ignore malformed metadata JSON
    }
  }
  return false;
}

function getLatestEventCounters(events: readonly ExistingScanEventRow[]): {
  pagesDiscovered: number;
  pagesCaptured: number;
  checksCompleted: number;
} {
  let pagesDiscovered = 0;
  let pagesCaptured = 0;
  let checksCompleted = 0;

  for (const event of events) {
    pagesDiscovered = Math.max(
      pagesDiscovered,
      Number(event.pages_discovered) || 0,
    );
    pagesCaptured = Math.max(pagesCaptured, Number(event.pages_captured) || 0);
    checksCompleted = Math.max(
      checksCompleted,
      Number(event.checks_completed) || 0,
    );
  }

  return { pagesDiscovered, pagesCaptured, checksCompleted };
}

function createEventId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

/**
 * Claims and executes a single scan stage in D1, writes an idempotent scan_events record,
 * updates scan lifecycle timestamps/status, and enqueues the next stage onto SCAN_QUEUE.
 */
export async function advanceScanStageInD1(
  options: AdvanceScanStageOptions,
): Promise<AdvanceScanStageResult> {
  const nowMs = options.now ? options.now() : Date.now();
  const { d1, scanQueue, message } = options;
  const executedStage = resolveActiveScanStage(message.stage);
  const attempt = Math.max(1, Math.floor(message.attempt ?? 1));
  const idempotencyKey =
    message.idempotencyKey?.trim() ||
    buildScanStageIdempotencyKey(message.scanId, executedStage, message.pageId);

  const scanRow = await d1
    .prepare(
      `SELECT
        id,
        workspace_id,
        site_id,
        target_url,
        normalized_url,
        status,
        started_at,
        completed_at
       FROM scans
       WHERE id = ?
       LIMIT 1`,
    )
    .bind(message.scanId)
    .first<ScanLifecycleRow>();

  if (!scanRow) {
    return {
      action: "missing_scan",
      scanId: message.scanId,
      executedStage,
      currentStatus: message.stage ?? "queued",
      nextStage: null,
      idempotencyKey,
    };
  }

  const eventsStmt = d1
    .prepare(
      `SELECT
        id,
        stage,
        pages_discovered,
        pages_captured,
        checks_completed,
        metadata_json
       FROM scan_events
       WHERE scan_id = ?
       ORDER BY created_at ASC`,
    )
    .bind(scanRow.id);
  const eventsResult = eventsStmt.all
    ? await eventsStmt.all<ExistingScanEventRow>()
    : { success: true, results: [] };
  const existingEvents = eventsResult.results ?? [];

  const currentStageIndex = STAGE_ORDER_INDEX[scanRow.status] ?? 0;
  const requestedStageIndex = STAGE_ORDER_INDEX[executedStage] ?? 1;

  // Idempotency guard: if this exact stage/page idempotency key already succeeded,
  // or if the scan has already progressed beyond this stage (and no pageId sub-task is set),
  // skip duplicate execution so retried messages never duplicate events or work.
  if (
    isTerminalScanStage(scanRow.status) ||
    hasIdempotencyKeyInEvents(existingEvents, idempotencyKey) ||
    (!message.pageId && currentStageIndex > requestedStageIndex)
  ) {
    return {
      action: "skipped_idempotent",
      scanId: scanRow.id,
      executedStage,
      currentStatus: scanRow.status,
      nextStage: null,
      idempotencyKey,
    };
  }

  const startedAt = scanRow.started_at ?? nowMs;

  // 1. Claim the stage in D1 (`scans.status = executedStage`, set `started_at` on first active stage)
  await d1
    .prepare(
      `UPDATE scans
       SET status = ?,
           started_at = ?,
           updated_at = ?
       WHERE id = ?`,
    )
    .bind(executedStage, startedAt, nowMs, scanRow.id)
    .run();

  // 2. Run stage handler (or default stage step)
  const canonicalTargetUrl = scanRow.normalized_url || message.targetUrl;
  const handler = options.stageHandlers?.[executedStage];
  const latestCounters = getLatestEventCounters(existingEvents);

  const stageResult: ScanStageExecutionResult = handler
    ? await handler({
        d1,
        scanId: scanRow.id,
        workspaceId: scanRow.workspace_id,
        siteId: scanRow.site_id,
        targetUrl: canonicalTargetUrl,
        stage: executedStage,
        attempt,
        pageId: message.pageId,
        idempotencyKey,
        nowMs,
      })
    : {
        outcome: "continue",
        message: DEFAULT_STAGE_MESSAGES[executedStage](canonicalTargetUrl),
      };

  const pagesDiscovered =
    stageResult.pagesDiscovered ?? latestCounters.pagesDiscovered;
  const pagesCaptured =
    stageResult.pagesCaptured ?? latestCounters.pagesCaptured;
  const checksCompleted =
    stageResult.checksCompleted ?? latestCounters.checksCompleted;
  const stageMessage =
    stageResult.message ??
    DEFAULT_STAGE_MESSAGES[executedStage](canonicalTargetUrl);

  const stageEventMetadata = JSON.stringify({
    ...(stageResult.metadata ?? {}),
    idempotencyKey,
    attempt,
    ...(message.pageId ? { pageId: message.pageId } : {}),
  });

  await d1
    .prepare(
      `INSERT INTO scan_events (
        id, scan_id, stage, message, pages_discovered, pages_captured, checks_completed, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      createEventId("evt"),
      scanRow.id,
      executedStage,
      stageMessage,
      pagesDiscovered,
      pagesCaptured,
      checksCompleted,
      stageEventMetadata,
      nowMs,
    )
    .run();

  // 3. Determine whether the stage failed, completed early, or advances to the next stage
  if (stageResult.outcome === "failed") {
    const failureClass = normalizeFailureClass(
      stageResult.failureClass,
      "internal_error",
    );
    const failureReason =
      stageResult.failureReason ??
      `Scan failed during ${executedStage} stage for ${canonicalTargetUrl}.`;
    const failedEventKey = buildScanStageIdempotencyKey(scanRow.id, "failed");

    await d1
      .prepare(
        `UPDATE scans
         SET status = 'failed',
             failure_class = ?,
             failure_reason = ?,
             completed_at = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .bind(failureClass, failureReason, nowMs, nowMs, scanRow.id)
      .run();

    await d1
      .prepare(
        `INSERT INTO scan_events (
          id, scan_id, stage, message, pages_discovered, pages_captured, checks_completed, metadata_json, created_at
        ) VALUES (?, ?, 'failed', ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        createEventId("evt"),
        scanRow.id,
        failureReason,
        pagesDiscovered,
        pagesCaptured,
        checksCompleted,
        JSON.stringify({
          idempotencyKey: failedEventKey,
          failedStage: executedStage,
          failureClass,
          attempt,
        }),
        nowMs + 1,
      )
      .run();

    return {
      action: "failed",
      scanId: scanRow.id,
      executedStage,
      currentStatus: "failed",
      nextStage: null,
      idempotencyKey,
    };
  }

  const nextStage =
    stageResult.outcome === "complete" || stageResult.outcome === "partial"
      ? null
      : getNextActiveScanStage(executedStage);

  if (!nextStage) {
    const terminalStatus: TerminalScanStage =
      stageResult.outcome === "partial" ? "partial" : "complete";
    const terminalKey = buildScanStageIdempotencyKey(
      scanRow.id,
      terminalStatus,
    );
    const terminalMessage =
      terminalStatus === "partial"
        ? `Scan completed with partial coverage for ${canonicalTargetUrl}`
        : `Scan completed for ${canonicalTargetUrl}`;

    await d1
      .prepare(
        `UPDATE scans
         SET status = ?,
             failure_class = NULL,
             failure_reason = NULL,
             completed_at = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .bind(terminalStatus, nowMs, nowMs, scanRow.id)
      .run();

    await d1
      .prepare(
        `INSERT INTO scan_events (
          id, scan_id, stage, message, pages_discovered, pages_captured, checks_completed, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        createEventId("evt"),
        scanRow.id,
        terminalStatus,
        terminalMessage,
        pagesDiscovered,
        pagesCaptured,
        checksCompleted,
        JSON.stringify({
          idempotencyKey: terminalKey,
          completedFromStage: executedStage,
          attempt,
        }),
        nowMs + 1,
      )
      .run();

    return {
      action: "completed",
      scanId: scanRow.id,
      executedStage,
      currentStatus: terminalStatus,
      nextStage: null,
      idempotencyKey,
    };
  }

  // 4. Re-enqueue the next stage onto SCAN_QUEUE
  if (scanQueue) {
    await scanQueue.send({
      kind: "website_scan",
      scanId: scanRow.id,
      workspaceId: scanRow.workspace_id,
      siteId: scanRow.site_id,
      targetUrl: canonicalTargetUrl,
      stage: nextStage,
      attempt: 1,
      idempotencyKey: buildScanStageIdempotencyKey(scanRow.id, nextStage),
    });
  }

  return {
    action: "advanced",
    scanId: scanRow.id,
    executedStage,
    currentStatus: executedStage,
    nextStage,
    idempotencyKey,
  };
}

/**
 * Handles dead-lettered scan queue messages (`mortem-scans-dlq`) by transitioning
 * any non-terminal scan to `status = 'failed'` with a valid `failure_class` and
 * `failure_reason` so no scan is ever left stuck in `capturing` or `checking`.
 */
export async function handleDeadLetterScanMessageInD1(params: {
  d1: D1DatabaseLike;
  message: ScanPipelineQueueMessage;
  queueName?: string;
  now?: () => number;
}): Promise<DeadLetterScanResult> {
  const nowMs = params.now ? params.now() : Date.now();
  const { d1, message } = params;
  const failedStage: ScanStage = message.stage ?? "queued";
  const idempotencyKey = `dlq:${
    message.idempotencyKey?.trim() ||
    buildScanStageIdempotencyKey(message.scanId, failedStage, message.pageId)
  }`;

  const failureClass = normalizeFailureClass(
    message.failureClass,
    failedStage === "capturing" || failedStage === "discovering"
      ? "navigation_timeout"
      : "internal_error",
  );
  const failureReason =
    message.failureReason?.trim() ||
    `Scan stage '${failedStage}' exhausted retry attempts and was routed to dead-letter queue (${params.queueName ?? "mortem-scans-dlq"}).`;

  const scanRow = await d1
    .prepare(
      `SELECT
        id,
        workspace_id,
        site_id,
        target_url,
        normalized_url,
        status,
        started_at,
        completed_at
       FROM scans
       WHERE id = ?
       LIMIT 1`,
    )
    .bind(message.scanId)
    .first<ScanLifecycleRow>();

  if (!scanRow) {
    return {
      action: "missing_scan",
      scanId: message.scanId,
      failedStage,
      failureClass,
      failureReason,
      idempotencyKey,
    };
  }

  const eventsStmt = d1
    .prepare(
      `SELECT
        id,
        stage,
        pages_discovered,
        pages_captured,
        checks_completed,
        metadata_json
       FROM scan_events
       WHERE scan_id = ?
       ORDER BY created_at ASC`,
    )
    .bind(scanRow.id);
  const eventsResult = eventsStmt.all
    ? await eventsStmt.all<ExistingScanEventRow>()
    : { success: true, results: [] };
  const existingEvents = eventsResult.results ?? [];

  if (
    isTerminalScanStage(scanRow.status) ||
    hasIdempotencyKeyInEvents(existingEvents, idempotencyKey)
  ) {
    return {
      action: "skipped_already_terminal",
      scanId: scanRow.id,
      failedStage: scanRow.status,
      failureClass,
      failureReason,
      idempotencyKey,
    };
  }

  const counters = getLatestEventCounters(existingEvents);

  await d1
    .prepare(
      `UPDATE scans
       SET status = 'failed',
           failure_class = ?,
           failure_reason = ?,
           started_at = COALESCE(started_at, ?),
           completed_at = ?,
           updated_at = ?
       WHERE id = ?`,
    )
    .bind(failureClass, failureReason, nowMs, nowMs, nowMs, scanRow.id)
    .run();

  await d1
    .prepare(
      `INSERT INTO scan_events (
        id, scan_id, stage, message, pages_discovered, pages_captured, checks_completed, metadata_json, created_at
      ) VALUES (?, ?, 'failed', ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      createEventId("evt"),
      scanRow.id,
      failureReason,
      counters.pagesDiscovered,
      counters.pagesCaptured,
      counters.checksCompleted,
      JSON.stringify({
        idempotencyKey,
        deadLetterQueue: params.queueName ?? "mortem-scans-dlq",
        failedStage,
        failureClass,
        attempt: message.attempt ?? 3,
      }),
      nowMs,
    )
    .run();

  return {
    action: "marked_failed",
    scanId: scanRow.id,
    failedStage,
    failureClass,
    failureReason,
    idempotencyKey,
  };
}
