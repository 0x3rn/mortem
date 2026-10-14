# ADR 0007: Cloudflare Queue Scan Stage Pipeline, Idempotency Keys, and Dead-Letter Lifecycle (`THE-175`)

- **Status:** Accepted
- **Date:** 2026-10-14
- **Linear Issue:** `THE-175`

## Context

Mortem website diagnostic scans execute multiple multi-second operations across page discovery, Playwright Desktop/Mobile Browser Rendering capture, deterministic checks, health scoring, and report generation. Running all stages inside a single synchronous HTTP request or a single monolithic Queue invocation risks hitting Cloudflare Worker wall-clock limits, losing partial progress on transient network/browser timeouts, or leaving scans permanently stuck in `capturing` or `checking` when retries are exhausted.

## Decision

1. **Stage-per-Message Pipeline (`packages/core/src/scan-pipeline.ts` & `workers/scan/src/index.ts`):**
   - Each active stage in `ORDERED_ACTIVE_SCAN_STAGES` (`discovering` → `capturing` → `checking` → `scoring` → `generating_report`) executes as an atomic Cloudflare Queue step on `mortem-scans` (`SCAN_QUEUE`).
   - When `advanceScanStageInD1` runs for a stage:
     1. It claims the stage in D1 (`scans.status = executedStage`, setting `started_at = COALESCE(started_at, nowMs)`).
     2. It executes the stage handler (`ScanStageHandler`).
     3. It appends a `scan_events` row with cumulative progress counters (`pages_discovered`, `pages_captured`, `checks_completed`) and `metadata_json` containing `{ idempotencyKey, attempt }`.
     4. It either enqueues the next stage onto `SCAN_QUEUE` (`attempt: 1`, `idempotencyKey: "${scanId}:${nextStage}"`) or transitions the scan to its terminal state (`complete`, `partial`, or `failed`) with `completed_at`.

2. **Idempotency Keys (`buildScanStageIdempotencyKey`):**
   - Every stage message carries a deterministic `idempotencyKey` (`{scanId}:{stage}` or `{scanId}:{stage}:{pageId}`).
   - Before executing a stage handler, `advanceScanStageInD1` inspects the scan's current `status` and existing `scan_events.metadata_json` for a matching `idempotencyKey`. If the stage has already completed or the scan has already advanced beyond that stage, the duplicate delivery is acknowledged (`skipped_idempotent`) without re-running the stage, duplicating `scan_events`, or re-enqueueing downstream messages.

3. **Exponential Backoff Retries and Dead-Letter Queue (`mortem-scans-dlq`):**
   - Transient stage failures call `message.retry({ delaySeconds: computeRetryBackoffSeconds(attempt) })` (`5s` → `15s` → `45s`, capped at `120s`, with `max_retries: 3`).
   - `workers/scan/wrangler.jsonc` binds both `mortem-scans` (with `dead_letter_queue: "mortem-scans-dlq"`, `max_batch_size: 5`, `max_concurrency: 5`) and a consumer for `mortem-scans-dlq` (`mortem-scans-dlq-staging` in staging).
   - When a batch arrives from a `-dlq` queue, `handleDeadLetterScanMessageInD1` transitions any non-terminal scan to `status = 'failed'` with a schema-validated `failure_class` (`navigation_timeout` for `discovering`/`capturing`, `internal_error` otherwise), `failure_reason`, `completed_at`, and a terminal `failed` event in `scan_events`.

## Consequences

- No scan can remain permanently stuck in an in-progress state (`discovering`, `capturing`, `checking`, `scoring`, `generating_report`) after queue retries are exhausted.
- At-least-once Cloudflare Queue delivery never creates duplicate stage events or duplicate downstream jobs.
- Future stage implementations (`THE-176` through `THE-189`) plug directly into `stageHandlers` without duplicating D1 status lifecycle or DLQ recovery logic.
