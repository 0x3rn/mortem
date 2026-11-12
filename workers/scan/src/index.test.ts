import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  BROWSER_DAILY_LIMIT_REASON,
  PlatformBindingError,
  ScanIntakeError,
  listScanEvidenceArtifactsInD1,
  persistPageCaptureEvidenceToR2AndD1,
  runPerformanceChecks,
  verifyScanEvidenceCompletenessInD1,
  type D1BoundStatementLike,
  type D1DatabaseLike,
  type D1ExecResultLike,
  type R2BucketLike,
} from "@mortem/core";
import { describe, expect, it, vi } from "vitest";
import worker, {
  DEAD_LETTERED_CAPTURE_PAGE_REASON,
  type QueueBatch,
  type ScanQueueMessage,
} from "./index";
// Test-only helpers shared with @mortem/core tests (never shipped in the Worker).
import {
  buildCaptureResult,
  createInMemoryR2,
} from "../../../packages/core/src/test-support";

const MIGRATION_0001_SQL = readFileSync(
  join(
    __dirname,
    "../../../packages/core/migrations/0001_auth_and_workspaces.sql",
  ),
  "utf8",
);
const MIGRATION_0002_SQL = readFileSync(
  join(
    __dirname,
    "../../../packages/core/migrations/0002_scans_evidence_findings_reports.sql",
  ),
  "utf8",
);
const MIGRATION_0003_SQL = readFileSync(
  join(
    __dirname,
    "../../../packages/core/migrations/0003_intake_rate_limits.sql",
  ),
  "utf8",
);

const MIGRATION_0004_SQL = readFileSync(
  join(
    __dirname,
    "../../../packages/core/migrations/0004_page_performance_results.sql",
  ),
  "utf8",
);
const MIGRATION_0005_SQL = readFileSync(
  join(
    __dirname,
    "../../../packages/core/migrations/0005_page_discovery_sources.sql",
  ),
  "utf8",
);

const PSI_FIXTURE_DIR = join(
  __dirname,
  "../../../packages/core/src/__fixtures__/psi",
);

function psiFixture(name: string): string {
  return readFileSync(join(PSI_FIXTURE_DIR, name), "utf8");
}

interface SqliteD1WithHandle extends D1DatabaseLike {
  sqlite: DatabaseSync;
}

function createSqliteD1(): SqliteD1WithHandle {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  sqlite.exec(MIGRATION_0001_SQL);
  sqlite.exec(MIGRATION_0002_SQL);
  sqlite.exec(MIGRATION_0003_SQL);
  sqlite.exec(MIGRATION_0004_SQL);
  sqlite.exec(MIGRATION_0005_SQL);

  function createBound(
    query: string,
    params: unknown[],
  ): D1BoundStatementLike & { raw?: () => Promise<unknown[][]> } {
    const normalized = params.map((v) => {
      if (v === undefined) return null;
      if (typeof v === "boolean") return v ? 1 : 0;
      if (v instanceof Date) return v.getTime();
      return v as SQLInputValue;
    });
    return {
      async run(): Promise<D1ExecResultLike> {
        const stmt = sqlite.prepare(query);
        const isReader = /^\s*(SELECT|PRAGMA|WITH|EXPLAIN)\b/i.test(query);
        if (isReader) {
          const rows = stmt.all(...normalized) as Record<string, unknown>[];
          return { success: true, results: rows };
        }
        stmt.run(...normalized);
        return { success: true, results: [] };
      },
      async first<T = Record<string, unknown>>(
        col?: string,
      ): Promise<T | null> {
        const row = sqlite.prepare(query).get(...normalized) as
          Record<string, unknown> | undefined;
        if (!row) return null;
        if (col) return (row[col] as T) ?? null;
        return row as T;
      },
      async all<T = Record<string, unknown>>(): Promise<D1ExecResultLike<T>> {
        const stmt = sqlite.prepare(query);
        const isReader =
          /^\s*(SELECT|PRAGMA|WITH|EXPLAIN)\b/i.test(query) ||
          /\bRETURNING\b/i.test(query);
        if (isReader) {
          const rows = stmt.all(...normalized) as T[];
          return { success: true, results: rows };
        }
        stmt.run(...normalized);
        return { success: true, results: [] };
      },
    };
  }

  return {
    sqlite,
    prepare(query: string) {
      const def = createBound(query, []);
      return {
        ...def,
        bind(...values: unknown[]) {
          return createBound(query, values);
        },
      };
    },
    async batch(statements: D1BoundStatementLike[]) {
      const out: D1ExecResultLike[] = [];
      for (const s of statements) {
        out.push(await s.run());
      }
      return out;
    },
  };
}

async function seedWorkspaceAndQueuedScan(
  d1: D1DatabaseLike,
  scanId = "scan_pipeline_01",
  targetUrl = "https://stripe.com/pricing",
): Promise<{ workspaceId: string; siteId: string; scanId: string }> {
  const userId = "usr_test_pipeline";
  const workspaceId = "ws_test_pipeline";
  const siteId = "site_test_pipeline";
  const now = 1_760_000_000_000;

  await d1
    .prepare(
      `INSERT INTO users (
        id, name, email, email_verified, created_at, updated_at
      ) VALUES (?, 'Test User', 'pipeline@mortem.dev', 1, ?, ?)`,
    )
    .bind(userId, now, now)
    .run();

  await d1
    .prepare(
      `INSERT INTO workspaces (
        id, name, slug, owner_user_id, plan, created_at, updated_at
      ) VALUES (?, 'Test Workspace', 'test-workspace', ?, 'free', ?, ?)`,
    )
    .bind(workspaceId, userId, now, now)
    .run();

  await d1
    .prepare(
      `INSERT INTO sites (
        id, workspace_id, origin, display_name, schedule_enabled, created_at, updated_at
      ) VALUES (?, ?, 'https://stripe.com', 'stripe.com', 0, ?, ?)`,
    )
    .bind(siteId, workspaceId, now, now)
    .run();

  await d1
    .prepare(
      `INSERT INTO scans (
        id, workspace_id, site_id, target_url, normalized_url, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`,
    )
    .bind(scanId, workspaceId, siteId, targetUrl, targetUrl, now, now)
    .run();

  await d1
    .prepare(
      `INSERT INTO scan_events (
        id, scan_id, stage, message, pages_discovered, pages_captured, checks_completed, metadata_json, created_at
      ) VALUES (?, ?, 'queued', ?, 0, 0, 0, ?, ?)`,
    )
    .bind(
      `evt_queued_${scanId}`,
      scanId,
      `Scan queued for ${targetUrl}`,
      JSON.stringify({ idempotencyKey: `${scanId}:queued` }),
      now,
    )
    .run();

  return { workspaceId, siteId, scanId };
}

describe("@mortem/scan-worker handlers", () => {
  it("returns worker readiness and read-only policy on GET /health", async () => {
    const response = await worker.fetch(
      new Request("https://scan-worker.internal/health", { method: "GET" }),
      { ENVIRONMENT: "test" },
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      ok: boolean;
      service: string;
      environment: string;
      bindingsConfigured: Record<string, boolean>;
      policy: { submitForms: boolean; allowedHttpMethods: string[] };
      categories: string[];
    };
    expect(payload.ok).toBe(true);
    expect(payload.service).toBe("mortem-scan-worker");
    expect(payload.environment).toBe("test");
    expect(payload.bindingsConfigured.DB).toBe(false);
    expect(payload.policy.submitForms).toBe(false);
    expect(payload.policy.allowedHttpMethods).toEqual(["GET", "HEAD"]);
    expect(payload.categories).toHaveLength(7);
  });

  it("supports HEAD /health with an empty body", async () => {
    const response = await worker.fetch(
      new Request("https://scan-worker.internal/health", { method: "HEAD" }),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });

  it("rejects mutating HTTP methods with 405 Method Not Allowed", async () => {
    const response = await worker.fetch(
      new Request("https://scan-worker.internal/health", { method: "POST" }),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });

  it("returns 404 for unknown routes", async () => {
    const response = await worker.fetch(
      new Request("https://scan-worker.internal/unknown", { method: "GET" }),
    );
    expect(response.status).toBe(404);
  });

  it("processes queue batches, accepting valid scan targets and rejecting invalid URLs", async () => {
    const ackValid = vi.fn();
    const ackInvalid = vi.fn();

    const batch: QueueBatch<ScanQueueMessage> = {
      queue: "mortem-scans",
      messages: [
        {
          id: "msg-1",
          body: {
            scanId: "scan_01",
            targetUrl: "acme-cloud.io/pricing",
            stage: "queued",
          },
          ack: ackValid,
          retry: vi.fn(),
        },
        {
          id: "msg-2",
          body: {
            scanId: "scan_02",
            targetUrl: "javascript:alert(1)",
            stage: "queued",
          },
          ack: ackInvalid,
          retry: vi.fn(),
        },
      ],
    };

    const summary = await worker.queue(batch, { ENVIRONMENT: "test" });
    expect(summary).toEqual({
      queue: "mortem-scans",
      environment: "test",
      acceptedScanIds: ["scan_01"],
      rejectedScanIds: ["scan_02"],
      completedSmokeIds: [],
    });
    expect(ackValid).toHaveBeenCalledOnce();
    expect(ackInvalid).toHaveBeenCalledOnce();
  });

  it("executes platform_smoke queue jobs across Browser Run, R2, and D1", async () => {
    const ack = vi.fn();
    const retry = vi.fn();
    const r2Put = vi.fn(async (key: string) => ({ key, size: 8 }));
    const d1Run = vi.fn(async () => ({ success: true }));

    const batch: QueueBatch<ScanQueueMessage> = {
      queue: "mortem-scans",
      messages: [
        {
          id: "msg-smoke-1",
          body: {
            kind: "platform_smoke",
            smokeId: "smoke123",
            scanId: "smoke_smoke123",
            targetUrl: "https://example.com/",
            stage: "queued",
          },
          ack,
          retry,
        },
      ],
    };

    const summary = await worker.queue(
      batch,
      {
        ENVIRONMENT: "test",
        DB: {
          prepare: () => ({
            bind: () => ({
              run: d1Run,
              first: async () => null,
            }),
          }),
        },
        EVIDENCE: {
          put: r2Put,
          head: async () => null,
        },
        BROWSER: {
          fetch: async () => new Response(null, { status: 200 }),
        },
      },
      {
        browserCapture: async (_binding, targetUrl) => ({
          screenshot: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
          title: `Example Domain (${targetUrl})`,
        }),
      },
    );

    expect(summary.completedSmokeIds).toEqual(["smoke123"]);
    expect(r2Put).toHaveBeenCalledOnce();
    expect(d1Run).toHaveBeenCalledOnce();
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  });

  it("retries and surfaces PlatformBindingError when R2 storage fails during platform_smoke", async () => {
    const ack = vi.fn();
    const retry = vi.fn();
    const d1Run = vi.fn(async () => ({ success: true }));

    const batch: QueueBatch<ScanQueueMessage> = {
      queue: "mortem-scans",
      messages: [
        {
          id: "msg-smoke-err",
          body: {
            kind: "platform_smoke",
            smokeId: "smoke_err",
            scanId: "smoke_smoke_err",
            targetUrl: "https://example.com/",
          },
          ack,
          retry,
        },
      ],
    };

    await expect(
      worker.queue(
        batch,
        {
          ENVIRONMENT: "test",
          DB: {
            prepare: () => ({
              bind: () => ({
                run: d1Run,
                first: async () => null,
              }),
            }),
          },
          EVIDENCE: {
            put: async () => {
              throw new Error("R2 bucket quota exceeded");
            },
            head: async () => null,
          },
          BROWSER: {
            fetch: async () => new Response(null, { status: 200 }),
          },
        },
        {
          browserCapture: async () => ({
            screenshot: new Uint8Array([1, 2, 3, 4]),
            title: "Example Domain",
          }),
        },
      ),
    ).rejects.toThrowError(PlatformBindingError);

    expect(retry).toHaveBeenCalledWith({ delaySeconds: 5 });
    expect(ack).not.toHaveBeenCalled();
  });

  it("handles scheduled cron triggers deterministically", async () => {
    const fixedTime = Date.UTC(2026, 9, 13, 12, 0, 0);
    const result = await worker.scheduled(
      {
        cron: "0 */6 * * *",
        scheduledTime: fixedTime,
      },
      { ENVIRONMENT: "test" },
    );

    expect(result).toEqual({
      cron: "0 */6 * * *",
      environment: "test",
      scheduledAtIso: "2026-10-13T12:00:00.000Z",
      status: "idle",
    });
  });

  it("advances a website_scan through all stages (queued -> discovering -> capturing -> checking -> scoring -> generating_report -> complete) in D1", async () => {
    const d1 = createSqliteD1();
    const { scanId, workspaceId, siteId } = await seedWorkspaceAndQueuedScan(
      d1,
      "scan_full_01",
      "https://stripe.com/pricing",
    );

    const pendingQueue: ScanQueueMessage[] = [
      {
        kind: "website_scan",
        scanId,
        workspaceId,
        siteId,
        targetUrl: "https://stripe.com/pricing",
        stage: "queued",
        attempt: 1,
        idempotencyKey: `${scanId}:discovering`,
      },
    ];

    let clock = 1_760_000_010_000;
    const env = {
      ENVIRONMENT: "test",
      DB: d1,
      SCAN_QUEUE: {
        send: async (msg: ScanQueueMessage) => {
          pendingQueue.push(msg);
        },
      },
    };

    const visitedStages: string[] = [];

    while (pendingQueue.length > 0) {
      const nextMsg = pendingQueue.shift()!;
      const ack = vi.fn();
      const retry = vi.fn();
      clock += 1_000;

      await worker.queue(
        {
          queue: "mortem-scans",
          messages: [
            {
              id: `msg_${visitedStages.length}`,
              body: nextMsg,
              ack,
              retry,
            },
          ],
        },
        env,
        {
          now: () => clock,
          stageHandlers: {
            discovering: () => {
              visitedStages.push("discovering");
              return { pagesDiscovered: 5 };
            },
            capturing: () => {
              visitedStages.push("capturing");
              return { pagesCaptured: 5 };
            },
            checking: () => {
              visitedStages.push("checking");
              return { checksCompleted: 14 };
            },
            scoring: () => {
              visitedStages.push("scoring");
              return {};
            },
            generating_report: () => {
              visitedStages.push("generating_report");
              return {};
            },
          },
        },
      );

      expect(ack).toHaveBeenCalledOnce();
      expect(retry).not.toHaveBeenCalled();
    }

    expect(visitedStages).toEqual([
      "discovering",
      "capturing",
      "checking",
      "scoring",
      "generating_report",
    ]);

    const scanRow = await d1
      .prepare(
        `SELECT status, started_at, completed_at, failure_class, failure_reason
         FROM scans WHERE id = ?`,
      )
      .bind(scanId)
      .first<{
        status: string;
        started_at: number | null;
        completed_at: number | null;
        failure_class: string | null;
        failure_reason: string | null;
      }>();

    expect(scanRow?.status).toBe("complete");
    expect(scanRow?.started_at).toBe(1_760_000_011_000);
    expect(scanRow?.completed_at).toBe(1_760_000_015_000);
    expect(scanRow?.failure_class).toBeNull();

    const events = await d1
      .prepare(
        `SELECT stage, pages_discovered, pages_captured, checks_completed, metadata_json
         FROM scan_events WHERE scan_id = ? ORDER BY created_at ASC`,
      )
      .bind(scanId).all!<{
      stage: string;
      pages_discovered: number;
      pages_captured: number;
      checks_completed: number;
      metadata_json: string;
    }>();

    expect(events.results?.map((e) => e.stage)).toEqual([
      "queued",
      "discovering",
      "capturing",
      "checking",
      "scoring",
      "generating_report",
      "complete",
    ]);
    const finalEvent = events.results?.[events.results.length - 1];
    expect(finalEvent?.pages_discovered).toBe(5);
    expect(finalEvent?.pages_captured).toBe(5);
    expect(finalEvent?.checks_completed).toBe(14);
  });

  it("enforces idempotency so duplicate or redelivered queue messages do not duplicate scan_events or re-enqueue", async () => {
    const d1 = createSqliteD1();
    const { scanId, workspaceId, siteId } = await seedWorkspaceAndQueuedScan(
      d1,
      "scan_idempotent_01",
      "https://linear.app/",
    );

    const enqueuedMessages: ScanQueueMessage[] = [];
    let discoveringRuns = 0;

    const env = {
      ENVIRONMENT: "test",
      DB: d1,
      SCAN_QUEUE: {
        send: async (msg: ScanQueueMessage) => {
          enqueuedMessages.push(msg);
        },
      },
    };

    const duplicateMessage: ScanQueueMessage = {
      kind: "website_scan",
      scanId,
      workspaceId,
      siteId,
      targetUrl: "https://linear.app/",
      stage: "discovering",
      attempt: 1,
      idempotencyKey: `${scanId}:discovering`,
    };

    // Deliver the exact same message twice
    for (let i = 0; i < 2; i += 1) {
      const ack = vi.fn();
      await worker.queue(
        {
          queue: "mortem-scans",
          messages: [
            {
              id: `dup_${i}`,
              body: duplicateMessage,
              ack,
              retry: vi.fn(),
            },
          ],
        },
        env,
        {
          stageHandlers: {
            discovering: () => {
              discoveringRuns += 1;
              return { pagesDiscovered: 3 };
            },
          },
        },
      );
      expect(ack).toHaveBeenCalledOnce();
    }

    expect(discoveringRuns).toBe(1);
    expect(enqueuedMessages).toHaveLength(1);
    expect(enqueuedMessages[0]?.stage).toBe("capturing");

    const events = await d1
      .prepare(
        `SELECT stage FROM scan_events WHERE scan_id = ? ORDER BY created_at ASC`,
      )
      .bind(scanId).all!<{ stage: string }>();

    expect(events.results?.map((e) => e.stage)).toEqual([
      "queued",
      "discovering",
    ]);
  });

  it("retries transient stage failures with exponential backoff and transitions dead-lettered scans to failed in D1", async () => {
    const d1 = createSqliteD1();
    const { scanId, workspaceId, siteId } = await seedWorkspaceAndQueuedScan(
      d1,
      "scan_dlq_01",
      "https://vercel.com/",
    );

    // 1. Simulate a transient error during capturing on attempt 2 (expected backoff: 15s)
    const ackTransient = vi.fn();
    const retryTransient = vi.fn();

    await expect(
      worker.queue(
        {
          queue: "mortem-scans",
          messages: [
            {
              id: "msg_transient",
              attempts: 2,
              body: {
                kind: "website_scan",
                scanId,
                workspaceId,
                siteId,
                targetUrl: "https://vercel.com/",
                stage: "capturing",
                attempt: 2,
                idempotencyKey: `${scanId}:capturing`,
              },
              ack: ackTransient,
              retry: retryTransient,
            },
          ],
        },
        {
          ENVIRONMENT: "test",
          DB: d1,
        },
        {
          stageHandlers: {
            capturing: () => {
              throw new Error("Playwright navigation timed out after 25000ms");
            },
          },
        },
      ),
    ).rejects.toThrow(/timed out/);

    expect(retryTransient).toHaveBeenCalledWith({ delaySeconds: 15 });
    expect(ackTransient).not.toHaveBeenCalled();

    // Verify scan was claimed as 'capturing' before the transient error
    const midScan = await d1
      .prepare(`SELECT status FROM scans WHERE id = ?`)
      .bind(scanId)
      .first<{ status: string }>();
    expect(midScan?.status).toBe("capturing");

    // 2. Deliver exhausted message to dead-letter queue (`mortem-scans-dlq`)
    const ackDlq = vi.fn();
    const retryDlq = vi.fn();

    const dlqSummary = await worker.queue(
      {
        queue: "mortem-scans-dlq",
        messages: [
          {
            id: "msg_dlq_1",
            attempts: 3,
            body: {
              kind: "website_scan",
              scanId,
              workspaceId,
              siteId,
              targetUrl: "https://vercel.com/",
              stage: "capturing",
              attempt: 3,
              idempotencyKey: `${scanId}:capturing`,
            },
            ack: ackDlq,
            retry: retryDlq,
          },
        ],
      },
      {
        ENVIRONMENT: "test",
        DB: d1,
      },
      {
        now: () => 1_760_000_099_000,
      },
    );

    expect(dlqSummary.acceptedScanIds).toEqual([scanId]);
    expect(ackDlq).toHaveBeenCalledOnce();
    expect(retryDlq).not.toHaveBeenCalled();

    const failedScan = await d1
      .prepare(
        `SELECT status, failure_class, failure_reason, completed_at
         FROM scans WHERE id = ?`,
      )
      .bind(scanId)
      .first<{
        status: string;
        failure_class: string | null;
        failure_reason: string | null;
        completed_at: number | null;
      }>();

    expect(failedScan?.status).toBe("failed");
    expect(failedScan?.failure_class).toBe("navigation_timeout");
    expect(failedScan?.failure_reason).toContain("dead-letter queue");
    expect(failedScan?.completed_at).toBe(1_760_000_099_000);

    const events = await d1
      .prepare(
        `SELECT stage, message FROM scan_events WHERE scan_id = ? ORDER BY created_at ASC`,
      )
      .bind(scanId).all!<{ stage: string; message: string }>();

    expect(events.results?.map((e) => e.stage)).toEqual(["queued", "failed"]);
  });

  it("executes the Browser Run capturing stage across desktop and mobile viewports, persisting D1 page rows and failing upstream_blocked when WAF challenges occur (THE-176)", async () => {
    const d1 = createSqliteD1();
    const { scanId, workspaceId, siteId } = await seedWorkspaceAndQueuedScan(
      d1,
      "scan_capture_blocked_01",
      "https://protected-site.example.com/",
    );

    const enqueuedMessages: ScanQueueMessage[] = [];
    const ack = vi.fn();
    const retry = vi.fn();

    await worker.queue(
      {
        queue: "mortem-scans",
        messages: [
          {
            id: "msg_capture_1",
            body: {
              kind: "website_scan",
              scanId,
              workspaceId,
              siteId,
              targetUrl: "https://protected-site.example.com/",
              stage: "capturing",
              attempt: 1,
              idempotencyKey: `${scanId}:capturing`,
            },
            ack,
            retry,
          },
        ],
      },
      {
        ENVIRONMENT: "test",
        DB: d1,
        SCAN_QUEUE: {
          send: async (msg: ScanQueueMessage) => {
            enqueuedMessages.push(msg);
          },
        },
      },
      {
        now: () => 1_760_000_050_000,
        browserLauncher: async () => ({
          async newContext() {
            return {
              async newPage() {
                const url = "https://protected-site.example.com/";
                return {
                  async addInitScript() {},
                  async route() {},
                  on() {},
                  async goto() {
                    const req = {
                      url: () => url,
                      method: () => "GET",
                      resourceType: () => "document",
                      isNavigationRequest: () => true,
                      redirectedFrom: () => null,
                    };
                    return {
                      url: () => url,
                      status: () => 403,
                      headers: () => ({ "cf-mitigated": "challenge" }),
                      request: () => req,
                    };
                  },
                  async waitForLoadState() {},
                  async evaluate<R>() {
                    return { ttfbMs: 40 } as unknown as R;
                  },
                  async content() {
                    return "<html><head><title>Just a moment...</title></head><body>Challenge</body></html>";
                  },
                  async title() {
                    return "Just a moment...";
                  },
                  url: () => url,
                  async screenshot() {
                    return new Uint8Array([137, 80, 78, 71]);
                  },
                  async close() {},
                };
              },
              async close() {},
            };
          },
          async close() {},
        }),
      },
    );

    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(enqueuedMessages).toHaveLength(0);

    const scanRow = await d1
      .prepare(
        `SELECT status, failure_class, failure_reason FROM scans WHERE id = ?`,
      )
      .bind(scanId)
      .first<{
        status: string;
        failure_class: string | null;
        failure_reason: string | null;
      }>();

    expect(scanRow?.status).toBe("failed");
    expect(scanRow?.failure_class).toBe("upstream_blocked");
    expect(scanRow?.failure_reason).toContain("Cloudflare challenge");

    const pageRow = await d1
      .prepare(
        `SELECT capture_status, status_code, failure_reason FROM pages WHERE scan_id = ?`,
      )
      .bind(scanId)
      .first<{
        capture_status: string;
        status_code: number | null;
        failure_reason: string | null;
      }>();

    expect(pageRow?.capture_status).toBe("skipped");
    expect(pageRow?.status_code).toBe(403);
    expect(pageRow?.failure_reason).toContain("Cloudflare challenge");
  });

  it("discovers high-value pages via robots.txt, sitemap.xml, and internal links during discovering stage and captures all discovered pages in capturing stage (THE-177)", async () => {
    const d1 = createSqliteD1();
    const { scanId, workspaceId, siteId } = await seedWorkspaceAndQueuedScan(
      d1,
      "scan_discovery_01",
      "https://stripe.com/",
    );

    const enqueuedMessages: ScanQueueMessage[] = [];
    const ackDiscover = vi.fn();

    const discoveryFetch: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "https://stripe.com/robots.txt") {
        return new Response(
          "User-agent: MortemBot\nDisallow: /private-beta\nSitemap: https://stripe.com/sitemap.xml\n",
          { status: 200 },
        );
      }
      if (url === "https://stripe.com/sitemap.xml") {
        return new Response(
          `<urlset>
            <url><loc>https://stripe.com/</loc></url>
            <url><loc>https://stripe.com/pricing</loc></url>
            <url><loc>https://stripe.com/private-beta</loc></url>
          </urlset>`,
          { status: 200 },
        );
      }
      if (url === "https://stripe.com/") {
        return new Response(
          `<html><body>
            <a href="/contact">Contact Sales</a>
            <a href="/payments">Payments Product</a>
          </body></html>`,
          { status: 200 },
        );
      }
      return new Response("Not Found", { status: 404 });
    };

    // 1. Run discovering stage
    await worker.queue(
      {
        queue: "mortem-scans",
        messages: [
          {
            id: "msg_disc_1",
            body: {
              kind: "website_scan",
              scanId,
              workspaceId,
              siteId,
              targetUrl: "https://stripe.com/",
              stage: "discovering",
              attempt: 1,
              idempotencyKey: `${scanId}:discovering`,
            },
            ack: ackDiscover,
            retry: vi.fn(),
          },
        ],
      },
      {
        ENVIRONMENT: "test",
        DB: d1,
        SCAN_QUEUE: {
          send: async (msg: ScanQueueMessage) => {
            enqueuedMessages.push(msg);
          },
        },
      },
      {
        now: () => 1_760_000_020_000,
        discoveryFetch,
      },
    );

    expect(ackDiscover).toHaveBeenCalledOnce();
    expect(enqueuedMessages).toHaveLength(1);
    expect(enqueuedMessages[0]?.stage).toBe("capturing");

    const pendingPages = await d1
      .prepare(
        `SELECT normalized_url, template_type, capture_status
         FROM pages WHERE scan_id = ? ORDER BY created_at ASC`,
      )
      .bind(scanId).all!<{
      normalized_url: string;
      template_type: string;
      capture_status: string;
    }>();

    expect(pendingPages.results).toEqual([
      {
        normalized_url: "https://stripe.com/",
        template_type: "home",
        capture_status: "pending",
      },
      {
        normalized_url: "https://stripe.com/pricing",
        template_type: "pricing",
        capture_status: "pending",
      },
      {
        normalized_url: "https://stripe.com/contact",
        template_type: "contact",
        capture_status: "pending",
      },
      {
        normalized_url: "https://stripe.com/payments",
        template_type: "product",
        capture_status: "pending",
      },
    ]);

    const discoverEvent = await d1
      .prepare(
        `SELECT pages_discovered, metadata_json FROM scan_events
         WHERE scan_id = ? AND stage = 'discovering' LIMIT 1`,
      )
      .bind(scanId)
      .first<{ pages_discovered: number; metadata_json: string }>();

    expect(discoverEvent?.pages_discovered).toBe(4);
    const parsedMeta = JSON.parse(discoverEvent?.metadata_json ?? "{}") as {
      skippedDisallowedUrls?: Array<{ normalizedUrl: string }>;
    };
    expect(parsedMeta.skippedDisallowedUrls).toEqual([
      expect.objectContaining({
        normalizedUrl: "https://stripe.com/private-beta",
      }),
    ]);

    // 2. Run capturing stage across all 4 discovered pages and persist raw evidence to R2 + D1 (THE-178)
    const r2Objects = new Map<string, number>();
    const r2Bucket: R2BucketLike = {
      async put(key, value) {
        const size =
          typeof value === "string"
            ? Buffer.byteLength(value)
            : value.byteLength;
        r2Objects.set(key, size);
        return { key, size };
      },
      async head(key) {
        const size = r2Objects.get(key);
        return size !== undefined ? { key, size } : null;
      },
    };

    const ackCapture = vi.fn();
    // One page per run: the capture stage requeues itself until no page is pending.
    let captureBody = enqueuedMessages[0]!;
    const captureSendDelays: Array<number | undefined> = [];
    for (let run = 0; run < 10 && captureBody.stage === "capturing"; run += 1) {
      await worker.queue(
        {
          queue: "mortem-scans",
          messages: [
            {
              id: "msg_cap_1",
              body: captureBody,
              ack: ackCapture,
              retry: vi.fn(),
            },
          ],
        },
        {
          ENVIRONMENT: "test",
          DB: d1,
          EVIDENCE: r2Bucket,
          SCAN_QUEUE: {
            send: async (
              msg: ScanQueueMessage,
              opts?: { delaySeconds?: number },
            ) => {
              enqueuedMessages.push(msg);
              captureSendDelays.push(opts?.delaySeconds);
            },
          },
        },
        {
          now: () => 1_760_000_025_000,
          browserLauncher: async () => ({
            async newContext() {
              return {
                async newPage() {
                  let currentUrl = "https://stripe.com/";
                  return {
                    async addInitScript() {},
                    async route() {},
                    on() {},
                    async goto(targetUrl: string) {
                      currentUrl = targetUrl;
                      const req = {
                        url: () => currentUrl,
                        method: () => "GET",
                        resourceType: () => "document",
                        isNavigationRequest: () => true,
                        redirectedFrom: () => null,
                      };
                      return {
                        url: () => currentUrl,
                        status: () => 200,
                        headers: () => ({ "content-type": "text/html" }),
                        request: () => req,
                      };
                    },
                    async waitForLoadState() {},
                    async evaluate<R>() {
                      return { ttfbMs: 30, fcpMs: 90 } as unknown as R;
                    },
                    async content() {
                      return "<html><head><title>Stripe</title></head><body>Main</body></html>";
                    },
                    async title() {
                      return "Stripe";
                    },
                    url: () => currentUrl,
                    async screenshot() {
                      return new Uint8Array([137, 80, 78, 71]);
                    },
                    async close() {},
                  };
                },
                async close() {},
              };
            },
            async close() {},
          }),
        },
      );
      captureBody = enqueuedMessages[enqueuedMessages.length - 1]!;
    }

    expect(ackCapture).toHaveBeenCalledTimes(4);
    // Three requeues 20 s apart, then the hand-off to checking.
    expect(captureSendDelays).toEqual([20, 20, 20, undefined]);
    expect(captureBody.stage).toBe("checking");
    const capturedPages = await d1
      .prepare(
        `SELECT normalized_url, template_type, capture_status, status_code
         FROM pages WHERE scan_id = ? ORDER BY created_at ASC`,
      )
      .bind(scanId).all!<{
      normalized_url: string;
      template_type: string;
      capture_status: string;
      status_code: number;
    }>();

    expect(capturedPages.results).toHaveLength(4);
    expect(
      capturedPages.results?.every(
        (p) => p.capture_status === "captured" && p.status_code === 200,
      ),
    ).toBe(true);
    expect(capturedPages.results?.map((p) => p.template_type)).toEqual([
      "home",
      "pricing",
      "contact",
      "product",
    ]);

    const artifacts = await listScanEvidenceArtifactsInD1(d1, scanId);
    // 4 pages * 6 core artifacts (html, headers, screenshot_desktop, screenshot_mobile, network_log, console_log) = 24,
    // plus one axe_raw per viewport per page (THE-182) = 8.
    expect(artifacts).toHaveLength(32);
    const axeArtifacts = artifacts.filter((a) => a.kind === "axe_raw");
    expect(axeArtifacts).toHaveLength(8);
    // This test's stub browser cannot execute axe, so each result honestly records an error.
    expect(axeArtifacts.every((a) => a.metadata.status === "error")).toBe(true);
    const completeness = await verifyScanEvidenceCompletenessInD1(
      d1,
      scanId,
      r2Bucket,
    );
    expect(completeness.complete).toBe(true);
    expect(completeness.violations).toHaveLength(0);
  });

  it("still checks the captured pages and ends the scan as partial (budget_exceeded) when crawl budgets run out mid-capture, and skips retries on permanent errors (THE-179)", async () => {
    const d1 = createSqliteD1();
    const { scanId, workspaceId, siteId } = await seedWorkspaceAndQueuedScan(
      d1,
      "scan_budget_01",
      "https://linear.app/",
    );

    // Configure tight maxPages=2 budget on scans row, while 3 pending pages exist
    await d1
      .prepare(
        `UPDATE scans
         SET started_at = ?,
             budgets_json = ?
         WHERE id = ?`,
      )
      .bind(
        1_760_000_000_000,
        JSON.stringify({
          maxPages: 2,
          maxWallTimeMs: 90_000,
          maxBrowserMs: 60_000,
        }),
        scanId,
      )
      .run();

    const pagesToSeed = [
      { id: "page_b1", url: "https://linear.app/", template: "home" },
      {
        id: "page_b2",
        url: "https://linear.app/pricing",
        template: "pricing",
      },
      {
        id: "page_b3",
        url: "https://linear.app/contact",
        template: "contact",
      },
    ];
    for (let idx = 0; idx < pagesToSeed.length; idx += 1) {
      const p = pagesToSeed[idx]!;
      await d1
        .prepare(
          `INSERT INTO pages (
            id, scan_id, url, normalized_url, template_type, capture_status,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .bind(
          p.id,
          scanId,
          p.url,
          p.url,
          p.template,
          1_760_000_001_000 + idx,
          1_760_000_001_000 + idx,
        )
        .run();
    }

    // Readable R2: since THE-181/182 the checking stage reads captured evidence back.
    const r2Bucket = createInMemoryR2();

    const enqueuedMessages: ScanQueueMessage[] = [];
    const ackBudget = vi.fn();
    const retryBudget = vi.fn();

    let currentClockMs = 1_760_000_005_000;

    // One page per run: follow the capture stage's requeues until it hands off.
    let budgetCaptureBody: ScanQueueMessage = {
      kind: "website_scan",
      scanId,
      workspaceId,
      siteId,
      targetUrl: "https://linear.app/",
      stage: "capturing",
      attempt: 1,
      idempotencyKey: `${scanId}:capturing`,
    };
    for (
      let run = 0;
      run < 10 && budgetCaptureBody?.stage === "capturing";
      run += 1
    ) {
      await worker.queue(
        {
          queue: "mortem-scans",
          messages: [
            {
              id: "msg_budget_1",
              body: budgetCaptureBody,
              ack: ackBudget,
              retry: retryBudget,
            },
          ],
        },
        {
          ENVIRONMENT: "test",
          DB: d1,
          EVIDENCE: r2Bucket,
          SCAN_QUEUE: {
            send: async (msg: ScanQueueMessage) => {
              enqueuedMessages.push(msg);
            },
          },
        },
        {
          now: () => {
            currentClockMs += 500;
            return currentClockMs;
          },
          browserLauncher: async () => ({
            async newContext() {
              return {
                async newPage() {
                  let currentUrl = "https://linear.app/";
                  return {
                    async addInitScript() {},
                    async route() {},
                    on() {},
                    async goto(targetUrl: string) {
                      currentUrl = targetUrl;
                      const req = {
                        url: () => currentUrl,
                        method: () => "GET",
                        resourceType: () => "document",
                        isNavigationRequest: () => true,
                        redirectedFrom: () => null,
                      };
                      return {
                        url: () => currentUrl,
                        status: () => 200,
                        headers: () => ({ "content-type": "text/html" }),
                        request: () => req,
                      };
                    },
                    async waitForLoadState() {},
                    async evaluate<R>() {
                      return { ttfbMs: 25, fcpMs: 80 } as unknown as R;
                    },
                    async content() {
                      return "<html><head><title>Linear</title></head><body>Content</body></html>";
                    },
                    async title() {
                      return "Linear";
                    },
                    url: () => currentUrl,
                    async screenshot() {
                      return new Uint8Array([137, 80, 78, 71]);
                    },
                    async close() {},
                  };
                },
                async close() {},
              };
            },
            async close() {},
          }),
        },
      );
      budgetCaptureBody = enqueuedMessages.shift()!;
    }

    // Pages 1 and 2 are captured one run each; run 3 finds maxPages reached.
    expect(ackBudget).toHaveBeenCalledTimes(3);
    enqueuedMessages.unshift(budgetCaptureBody);
    expect(retryBudget).not.toHaveBeenCalled();

    // Capture records partial coverage and hands off to the checks; it no
    // longer ends the scan, so the captured pages are still diagnosed.
    const afterCapture = await d1
      .prepare(`SELECT status, failure_class FROM scans WHERE id = ?`)
      .bind(scanId)
      .first<{ status: string; failure_class: string | null }>();
    expect(afterCapture).toEqual({ status: "capturing", failure_class: null });
    const captureEvent = await d1
      .prepare(
        `SELECT metadata_json FROM scan_events WHERE scan_id = ? AND stage = 'capturing'`,
      )
      .bind(scanId)
      .first<{ metadata_json: string }>();
    expect(
      JSON.parse(captureEvent!.metadata_json).partialCoverage,
    ).toMatchObject({
      failureClass: "budget_exceeded",
      reason: expect.stringContaining("maxPages"),
    });
    expect(enqueuedMessages.map((m) => m.stage)).toEqual(["checking"]);

    // Drive the remaining stages (checking → scoring → generating_report).
    for (let guard = 0; enqueuedMessages.length > 0 && guard < 10; guard += 1) {
      const body = enqueuedMessages.shift()!;
      await worker.queue(
        {
          queue: "mortem-scans",
          messages: [
            {
              id: `msg_budget_${body.stage}`,
              body,
              ack: vi.fn(),
              retry: vi.fn(),
            },
          ],
        },
        {
          ENVIRONMENT: "test",
          DB: d1,
          EVIDENCE: r2Bucket,
          SCAN_QUEUE: {
            send: async (msg: ScanQueueMessage) => {
              enqueuedMessages.push(msg);
            },
          },
        },
        {
          now: () => {
            currentClockMs += 500;
            return currentClockMs;
          },
          psiFetch: vi.fn() as unknown as typeof fetch,
        },
      );
    }

    const scanRow = await d1
      .prepare(
        `SELECT status, failure_class, failure_reason, usage_json
         FROM scans WHERE id = ?`,
      )
      .bind(scanId)
      .first<{
        status: string;
        failure_class: string | null;
        failure_reason: string | null;
        usage_json: string;
      }>();

    expect(scanRow?.status).toBe("partial");
    expect(scanRow?.failure_class).toBe("budget_exceeded");
    expect(scanRow?.failure_reason).toContain("maxPages");

    // The two captured pages were checked even though the budget ran out.
    const checkingEvent = await d1
      .prepare(
        `SELECT message FROM scan_events WHERE scan_id = ? AND stage = 'checking'`,
      )
      .bind(scanId)
      .first<{ message: string }>();
    expect(checkingEvent?.message).toContain("SEO: 2/2 page(s) analyzed");

    const usage = JSON.parse(scanRow?.usage_json ?? "{}") as {
      browserMs?: number;
      r2BytesWritten?: number;
      pagesDiscovered?: number;
      pagesCaptured?: number;
    };
    expect(usage.pagesDiscovered).toBe(3);
    expect(usage.pagesCaptured).toBe(2);
    expect(usage.browserMs).toBeGreaterThan(0);
    expect(usage.r2BytesWritten).toBeGreaterThan(0);

    const pageRows = await d1
      .prepare(
        `SELECT id, capture_status, failure_reason
         FROM pages WHERE scan_id = ? ORDER BY created_at ASC`,
      )
      .bind(scanId).all!<{
      id: string;
      capture_status: string;
      failure_reason: string | null;
    }>();

    expect(pageRows.results).toEqual([
      { id: "page_b1", capture_status: "captured", failure_reason: null },
      { id: "page_b2", capture_status: "captured", failure_reason: null },
      {
        id: "page_b3",
        capture_status: "skipped",
        failure_reason: expect.stringContaining("maxPages"),
      },
    ]);

    // 2. Verify permanent error (e.g. ScanIntakeError ssrf_blocked) skips retry and transitions directly to failed
    const d1Perm = createSqliteD1();
    const {
      scanId: permScanId,
      workspaceId: permWorkspaceId,
      siteId: permSiteId,
    } = await seedWorkspaceAndQueuedScan(
      d1Perm,
      "scan_perm_err_01",
      "https://example.com/",
    );
    const ackPerm = vi.fn();
    const retryPerm = vi.fn();

    await worker.queue(
      {
        queue: "mortem-scans",
        messages: [
          {
            id: "msg_perm_1",
            body: {
              kind: "website_scan",
              scanId: permScanId,
              workspaceId: permWorkspaceId,
              siteId: permSiteId,
              targetUrl: "https://example.com/",
              stage: "discovering",
              attempt: 1,
              idempotencyKey: `${permScanId}:discovering`,
            },
            ack: ackPerm,
            retry: retryPerm,
          },
        ],
      },
      {
        ENVIRONMENT: "test",
        DB: d1Perm,
      },
      {
        now: () => 1_760_000_090_000,
        stageHandlers: {
          discovering: () => {
            throw new ScanIntakeError(
              "ssrf_blocked",
              "Redirect target resolved to private IPv4 10.0.0.1",
              403,
            );
          },
        },
      },
    );

    expect(ackPerm).toHaveBeenCalledOnce();
    expect(retryPerm).not.toHaveBeenCalled();

    const permScanRow = await d1Perm
      .prepare(
        `SELECT status, failure_class, failure_reason FROM scans WHERE id = ?`,
      )
      .bind(permScanId)
      .first<{
        status: string;
        failure_class: string | null;
        failure_reason: string | null;
      }>();

    expect(permScanRow?.status).toBe("failed");
    expect(permScanRow?.failure_class).toBe("ssrf_blocked");
    expect(permScanRow?.failure_reason).toContain("10.0.0.1");
  });
});

describe("@mortem/scan-worker checking stage — PageSpeed Insights (THE-180)", () => {
  const API_KEY = "AIzaSyWORKER-TEST-KEY-must-never-be-stored";
  const MOBILE_SLOW = psiFixture("recorded-www.cnn.com-mobile.json");
  const DESKTOP_FAST = psiFixture("recorded-info.cern.ch-desktop.json");
  const QUOTA_429 = psiFixture("recorded-quota-exceeded-429.json");

  function jsonResponse(body: string, status = 200): Response {
    return new Response(body, {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  function createR2() {
    const objects = new Map<string, string>();
    const bucket: R2BucketLike = {
      async put(key, value) {
        const text =
          typeof value === "string"
            ? value
            : new TextDecoder().decode(value as Uint8Array);
        objects.set(key, text);
        return { key, size: text.length };
      },
      async head(key) {
        const found = objects.get(key);
        return found === undefined ? null : { key, size: found.length };
      },
    };
    return { objects, bucket };
  }

  /** Runs a queued scan to completion, seeding two captured pages instead of crawling. */
  async function runPipeline(options: {
    apiKey?: string;
    withEvidenceBinding?: boolean;
    psiFetch: typeof fetch;
  }) {
    const d1 = createSqliteD1();
    const { scanId, workspaceId, siteId } = await seedWorkspaceAndQueuedScan(
      d1,
      "scan_psi_01",
      "https://shop.example.test/",
    );
    const r2 = createR2();
    const pending: ScanQueueMessage[] = [
      {
        kind: "website_scan",
        scanId,
        workspaceId,
        siteId,
        targetUrl: "https://shop.example.test/",
        stage: "queued",
        attempt: 1,
        idempotencyKey: `${scanId}:discovering`,
      },
    ];

    const env = {
      ENVIRONMENT: "test",
      DB: d1,
      ...(options.withEvidenceBinding === false ? {} : { EVIDENCE: r2.bucket }),
      ...(options.apiKey ? { PAGESPEED_API_KEY: options.apiKey } : {}),
      SCAN_QUEUE: {
        send: async (msg: ScanQueueMessage) => {
          pending.push(msg);
        },
      },
    };

    const acks: ReturnType<typeof vi.fn>[] = [];
    const retries: ReturnType<typeof vi.fn>[] = [];
    let clock = 1_760_000_010_000;
    let guard = 0;
    while (pending.length > 0 && guard < 20) {
      guard += 1;
      const body = pending.shift()!;
      const ack = vi.fn();
      const retry = vi.fn();
      acks.push(ack);
      retries.push(retry);
      clock += 1_000;
      await worker.queue(
        {
          queue: "mortem-scans",
          messages: [{ id: `msg_${guard}`, body, ack, retry }],
        },
        env,
        {
          now: () => clock,
          psiFetch: options.psiFetch,
          psiSleep: async (ms: number) => {
            void ms;
          },
          stageHandlers: {
            discovering: () => ({ pagesDiscovered: 2 }),
            capturing: async (ctx) => {
              for (const [id, url, template] of [
                ["page_home", "https://shop.example.test/", "home"],
                [
                  "page_pricing",
                  "https://shop.example.test/pricing",
                  "pricing",
                ],
              ] as const) {
                await ctx.d1
                  .prepare(
                    `INSERT INTO pages (
                       id, scan_id, url, normalized_url, template_type, status_code,
                       load_timings_json, capture_status, created_at, updated_at
                     ) VALUES (?, ?, ?, ?, ?, 200, ?, 'captured', ?, ?)`,
                  )
                  .bind(
                    id,
                    ctx.scanId,
                    url,
                    url,
                    template,
                    JSON.stringify({ ttfbMs: 150, fcpMs: 800 }),
                    ctx.nowMs,
                    ctx.nowMs,
                  )
                  .run();
              }
              return { pagesCaptured: 2 };
            },
          },
        },
      );
    }

    return { d1, r2, scanId, acks, retries };
  }

  function count(d1: SqliteD1WithHandle, sql: string): number {
    return (d1.sqlite.prepare(sql).get() as { n: number }).n;
  }

  function dumpAllText(d1: SqliteD1WithHandle, r2Objects: Map<string, string>) {
    const tables = [
      "scans",
      "scan_events",
      "pages",
      "evidence_artifacts",
      "findings",
      "finding_occurrences",
      "page_performance_results",
    ];
    const rows = tables.flatMap((table) =>
      d1.sqlite.prepare(`SELECT * FROM ${table}`).all(),
    );
    return JSON.stringify(rows) + [...r2Objects.keys()].join("\n");
  }

  const fastDesktopSlowMobile: typeof fetch = (async (
    input: RequestInfo | URL,
  ) => {
    const strategy = new URL(String(input)).searchParams.get("strategy");
    return jsonResponse(strategy === "MOBILE" ? MOBILE_SLOW : DESKTOP_FAST);
  }) as typeof fetch;

  it("runs PageSpeed Insights inside the real checking stage and completes the scan", async () => {
    const psiFetch = vi.fn(fastDesktopSlowMobile) as unknown as typeof fetch;
    const { d1, r2, scanId } = await runPipeline({ apiKey: API_KEY, psiFetch });

    const scan = d1.sqlite
      .prepare(`SELECT status, usage_json FROM scans WHERE id = ?`)
      .get(scanId) as { status: string; usage_json: string };
    expect(scan.status).toBe("complete");

    // 2 pages x 2 strategies.
    expect(psiFetch).toHaveBeenCalledTimes(4);
    const usage = JSON.parse(scan.usage_json) as {
      psiCalls: number;
      r2BytesWritten: number;
    };
    expect(usage.psiCalls).toBe(4);
    expect(usage.r2BytesWritten).toBeGreaterThan(0);

    expect([...r2.objects.keys()].sort()).toEqual([
      `scans/${scanId}/pages/page_home/psi_raw_desktop.json`,
      `scans/${scanId}/pages/page_home/psi_raw_mobile.json`,
      `scans/${scanId}/pages/page_pricing/psi_raw_desktop.json`,
      `scans/${scanId}/pages/page_pricing/psi_raw_mobile.json`,
    ]);

    const event = d1.sqlite
      .prepare(
        `SELECT message, checks_completed, metadata_json FROM scan_events
         WHERE scan_id = ? AND stage = 'checking' ORDER BY created_at DESC LIMIT 1`,
      )
      .get(scanId) as {
      message: string;
      checks_completed: number;
      metadata_json: string;
    };
    expect(event.message).toContain("PageSpeed Insights: 4/4 result(s)");
    expect(event.checks_completed).toBe(4);
    expect(JSON.parse(event.metadata_json).performance).toMatchObject({
      resultsOk: 4,
      resultsUnavailable: 0,
      partial: false,
      findingsWritten: 9,
    });

    expect(
      count(
        d1,
        `SELECT COUNT(*) AS n FROM findings WHERE category = 'performance'`,
      ),
    ).toBe(9);
    expect(
      count(
        d1,
        `SELECT COUNT(*) AS n FROM page_performance_results WHERE status = 'ok'`,
      ),
    ).toBe(4);
  });

  it("never persists the API key anywhere (D1 tables or R2 keys)", async () => {
    const { d1, r2 } = await runPipeline({
      apiKey: API_KEY,
      psiFetch: fastDesktopSlowMobile,
    });
    expect(dumpAllText(d1, r2.objects)).not.toContain(API_KEY);
  });

  it("sends the key only to the PageSpeed endpoint, as a query parameter", async () => {
    const seen: string[] = [];
    const psiFetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return jsonResponse(DESKTOP_FAST);
    }) as typeof fetch;
    await runPipeline({ apiKey: API_KEY, psiFetch });
    expect(seen.length).toBe(4);
    for (const url of seen) {
      const parsed = new URL(url);
      expect(parsed.origin).toBe("https://www.googleapis.com");
      expect(parsed.pathname).toBe("/pagespeedonline/v5/runPagespeed");
      expect(parsed.searchParams.get("key")).toBe(API_KEY);
    }
  });

  it("still completes the scan with explicit api_key_missing results when no key is configured", async () => {
    const psiFetch = vi.fn() as unknown as typeof fetch;
    const { d1, scanId } = await runPipeline({ psiFetch });

    expect(psiFetch).not.toHaveBeenCalled();
    const scan = d1.sqlite
      .prepare(`SELECT status, usage_json FROM scans WHERE id = ?`)
      .get(scanId) as { status: string; usage_json: string };
    expect(scan.status).toBe("complete");
    expect(JSON.parse(scan.usage_json).psiCalls).toBe(0);

    const rows = d1.sqlite
      .prepare(
        `SELECT status, unavailable_reason, lab_json FROM page_performance_results`,
      )
      .all() as Array<{
      status: string;
      unavailable_reason: string;
      lab_json: string | null;
    }>;
    expect(rows).toHaveLength(4);
    expect(
      rows.every(
        (row) =>
          row.status === "unavailable" &&
          row.unavailable_reason === "api_key_missing" &&
          row.lab_json === null,
      ),
    ).toBe(true);
    expect(count(d1, `SELECT COUNT(*) AS n FROM findings`)).toBe(0);

    const event = d1.sqlite
      .prepare(
        `SELECT message, metadata_json FROM scan_events
         WHERE scan_id = ? AND stage = 'checking' ORDER BY created_at DESC LIMIT 1`,
      )
      .get(scanId) as { message: string; metadata_json: string };
    expect(event.message).toContain("partial: 4 result(s) unavailable");
    expect(
      JSON.parse(event.metadata_json).performance.unavailable[0],
    ).toMatchObject({ reason: "api_key_missing" });
  });

  it("keeps the scan going with partial performance data when PageSpeed quota is exhausted for one strategy", async () => {
    const psiFetch = (async (input: RequestInfo | URL) => {
      const strategy = new URL(String(input)).searchParams.get("strategy");
      return strategy === "MOBILE"
        ? jsonResponse(MOBILE_SLOW)
        : jsonResponse(QUOTA_429, 429);
    }) as typeof fetch;
    const { d1, scanId } = await runPipeline({ apiKey: API_KEY, psiFetch });

    const scan = d1.sqlite
      .prepare(`SELECT status FROM scans WHERE id = ?`)
      .get(scanId) as { status: string };
    expect(scan.status).toBe("complete");

    const rows = d1.sqlite
      .prepare(
        `SELECT strategy, status, unavailable_reason FROM page_performance_results ORDER BY page_id, strategy`,
      )
      .all() as Array<{
      strategy: string;
      status: string;
      unavailable_reason: string | null;
    }>;
    expect(
      rows
        .filter((r) => r.strategy === "mobile")
        .every((r) => r.status === "ok"),
    ).toBe(true);
    expect(
      rows
        .filter((r) => r.strategy === "desktop")
        .every(
          (r) =>
            r.status === "unavailable" &&
            r.unavailable_reason === "quota_exceeded",
        ),
    ).toBe(true);
    expect(count(d1, `SELECT COUNT(*) AS n FROM findings`)).toBeGreaterThan(0);
  });

  it("fails the scan with an explicit reason, not a silent skip, when the EVIDENCE binding is missing", async () => {
    const psiFetch = vi.fn() as unknown as typeof fetch;
    const { d1, scanId, acks, retries } = await runPipeline({
      apiKey: API_KEY,
      withEvidenceBinding: false,
      psiFetch,
    });

    expect(psiFetch).not.toHaveBeenCalled();
    const scan = d1.sqlite
      .prepare(
        `SELECT status, failure_class, failure_reason FROM scans WHERE id = ?`,
      )
      .get(scanId) as {
      status: string;
      failure_class: string;
      failure_reason: string;
    };
    expect(scan.status).toBe("failed");
    expect(scan.failure_class).toBe("internal_error");
    expect(scan.failure_reason).toContain("EVIDENCE");
    // Non-retryable: acknowledged rather than burning queue retries.
    expect(retries.every((retry) => retry.mock.calls.length === 0)).toBe(true);
    expect(acks.at(-1)).toHaveBeenCalledOnce();
  });

  it("re-running the checking work for the same scan does not duplicate any rows", async () => {
    const { d1, r2, scanId } = await runPipeline({
      apiKey: API_KEY,
      psiFetch: fastDesktopSlowMobile,
    });

    const snapshot = () => ({
      results: count(d1, `SELECT COUNT(*) AS n FROM page_performance_results`),
      findings: count(d1, `SELECT COUNT(*) AS n FROM findings`),
      occurrences: count(d1, `SELECT COUNT(*) AS n FROM finding_occurrences`),
      evidence: count(
        d1,
        `SELECT COUNT(*) AS n FROM evidence_artifacts WHERE kind = 'psi_raw'`,
      ),
      objects: r2.objects.size,
    });
    const before = snapshot();

    // Replay the checking work directly, as a Cloudflare Queue redelivery would.
    await runPerformanceChecks({
      d1,
      r2: r2.bucket,
      scanId,
      apiKey: API_KEY,
      fetchFn: fastDesktopSlowMobile,
      sleep: async (ms: number) => {
        void ms;
      },
    });

    expect(snapshot()).toEqual(before);
    expect(before).toEqual({
      results: 4,
      findings: 9,
      occurrences: 18,
      evidence: 4,
      objects: 4,
    });
  });
});

describe("@mortem/scan-worker checking stage — SEO (THE-181)", () => {
  const seoHead = (title: string, canonical: string) => `
<title>${title}</title>
<meta name="description" content="Acme Analytics shows small teams which features customers use and what to fix next.">
<link rel="canonical" href="${canonical}">
<meta property="og:title" content="${title}"><meta property="og:description" content="Acme">
<meta property="og:image" content="https://shop.example.test/og.png"><meta property="og:url" content="${canonical}">
<meta name="twitter:card" content="summary">`;
  const seoPage = (title: string, canonical: string) =>
    `<!doctype html><html lang="en"><head>${seoHead(title, canonical)}</head><body><h1>Acme</h1></body></html>`;
  const TITLE = "Acme Analytics — Product analytics for small teams";

  async function runSeoPipeline(r2: R2BucketLike) {
    const d1 = createSqliteD1();
    const { scanId, workspaceId, siteId } = await seedWorkspaceAndQueuedScan(
      d1,
      "scan_seo_01",
      "https://shop.example.test/",
    );
    const pending: ScanQueueMessage[] = [
      {
        kind: "website_scan",
        scanId,
        workspaceId,
        siteId,
        targetUrl: "https://shop.example.test/",
        stage: "queued",
        attempt: 1,
        idempotencyKey: `${scanId}:discovering`,
      },
    ];
    const env = {
      ENVIRONMENT: "test",
      DB: d1,
      EVIDENCE: r2,
      SCAN_QUEUE: {
        send: async (msg: ScanQueueMessage) => {
          pending.push(msg);
        },
      },
    };
    const psiFetch = vi.fn() as unknown as typeof fetch;
    let clock = 1_760_000_010_000;
    for (let guard = 0; pending.length > 0 && guard < 20; guard += 1) {
      const body = pending.shift()!;
      clock += 1_000;
      await worker.queue(
        {
          queue: "mortem-scans",
          messages: [
            { id: `seo_${guard}`, body, ack: vi.fn(), retry: vi.fn() },
          ],
        },
        env,
        {
          now: () => clock,
          psiFetch,
          stageHandlers: {
            discovering: () => ({ pagesDiscovered: 2 }),
            capturing: async (ctx) => {
              const pages: Array<{
                id: string;
                url: string;
                sources: string[];
                html: string;
                headers: Record<string, string>;
              }> = [
                {
                  id: "page_home",
                  url: "https://shop.example.test/",
                  sources: ["entry"],
                  html: seoPage(TITLE, "https://shop.example.test/"),
                  headers: { "content-type": "text/html" },
                },
                {
                  id: "page_old",
                  url: "https://shop.example.test/old",
                  sources: ["sitemap"],
                  html: seoPage(TITLE, "https://shop.example.test/old"),
                  headers: {
                    "content-type": "text/html",
                    "x-robots-tag": "noindex",
                  },
                },
              ];
              for (const p of pages) {
                await ctx.d1
                  .prepare(
                    `INSERT INTO pages (id, scan_id, url, normalized_url, template_type, status_code,
                       discovery_sources_json, capture_status, created_at, updated_at)
                     VALUES (?, ?, ?, ?, 'other', 200, ?, 'captured', ?, ?)`,
                  )
                  .bind(
                    p.id,
                    ctx.scanId,
                    p.url,
                    p.url,
                    JSON.stringify(p.sources),
                    ctx.nowMs,
                    ctx.nowMs,
                  )
                  .run();
                await persistPageCaptureEvidenceToR2AndD1({
                  d1: ctx.d1,
                  r2,
                  scanId: ctx.scanId,
                  pageId: p.id,
                  capture: buildCaptureResult({
                    url: p.url,
                    html: p.html,
                    headers: p.headers,
                  }),
                  nowMs: ctx.nowMs,
                });
              }
              return { pagesCaptured: 2 };
            },
          },
        },
      );
    }
    return { d1, scanId, psiFetch };
  }

  it("writes SEO findings from stored evidence in the real checking stage, before PageSpeed", async () => {
    const { d1, scanId } = await runSeoPipeline(createInMemoryR2());
    const scan = d1.sqlite
      .prepare(`SELECT status FROM scans WHERE id = ?`)
      .get(scanId) as { status: string };
    expect(scan.status).toBe("complete");

    const ruleIds = (
      d1.sqlite
        .prepare(
          `SELECT check_id FROM findings WHERE scan_id = ? AND check_id LIKE 'seo.%' ORDER BY check_id`,
        )
        .all(scanId) as Array<{ check_id: string }>
    ).map((r) => r.check_id);
    // The same stage also runs the security checks (THE-183) on these pages.
    const securityRuleIds = (
      d1.sqlite
        .prepare(
          `SELECT check_id FROM findings WHERE scan_id = ? AND category = 'security' ORDER BY check_id`,
        )
        .all(scanId) as Array<{ check_id: string }>
    ).map((r) => r.check_id);
    expect(securityRuleIds).toContain("sec.hsts.missing");
    expect(ruleIds).toEqual([
      "seo.indexability.noindex",
      "seo.indexability.sitemap-conflict",
      // Both pages also share one meta description.
      "seo.meta-description.duplicate",
      "seo.title.duplicate",
    ]);

    const event = d1.sqlite
      .prepare(
        `SELECT message, metadata_json, checks_completed FROM scan_events
         WHERE scan_id = ? AND stage = 'checking' ORDER BY created_at DESC LIMIT 1`,
      )
      .get(scanId) as {
      message: string;
      metadata_json: string;
      checks_completed: number;
    };
    expect(event.message).toContain(
      "SEO: 2/2 page(s) analyzed, 4 SEO finding(s)",
    );
    expect(event.message).toContain("PageSpeed Insights");
    expect(event.message).toContain("Security: 2/2 page(s) checked");
    // 2 pages analysed for SEO + 2 checked for security.
    expect(event.checks_completed).toBe(4);
    expect(JSON.parse(event.metadata_json).security).toMatchObject({
      pagesChecked: 2,
      // Tests never make network requests: the http:// check is disabled.
      probe: { status: "not_run" },
    });
    expect(JSON.parse(event.metadata_json).seo).toMatchObject({
      pagesAnalyzed: 2,
      findingsWritten: 4,
      pagesSkipped: [],
    });
  });

  it("fails the scan explicitly when stored HTML cannot be read back from R2", async () => {
    const full = createInMemoryR2();
    const writeOnly: R2BucketLike = { put: full.put, head: full.head };
    const { d1, scanId, psiFetch } = await runSeoPipeline(writeOnly);
    const scan = d1.sqlite
      .prepare(
        `SELECT status, failure_class, failure_reason FROM scans WHERE id = ?`,
      )
      .get(scanId) as {
      status: string;
      failure_class: string;
      failure_reason: string;
    };
    expect(scan.status).toBe("failed");
    expect(scan.failure_class).toBe("internal_error");
    expect(scan.failure_reason).toContain("cannot read objects");
    expect(psiFetch).not.toHaveBeenCalled();
  });
});

describe("@mortem/scan-worker capture budgets: redelivery after the budget ran out", () => {
  const T0 = 1_792_143_198_981;

  function captureMessage(
    scanId: string,
    workspaceId: string,
    siteId: string,
  ): ScanQueueMessage {
    return {
      kind: "website_scan",
      scanId,
      workspaceId,
      siteId,
      targetUrl: "https://morrow.example.test/",
      stage: "capturing",
      attempt: 1,
      idempotencyKey: `${scanId}:capturing`,
    };
  }

  it("keeps pages an earlier attempt captured, checks them and ends partial when a redelivered capture hits the wall-clock budget", async () => {
    // Replays production scan_c564687761dd38109099: 60 s budget, "/" and "/login"
    // captured by the first attempt, "/register" still pending, and the capture
    // stage redelivered at +61 s. Before the fix the scan failed with 0 pages.
    const d1 = createSqliteD1();
    const r2 = createInMemoryR2();
    const { scanId, workspaceId, siteId } = await seedWorkspaceAndQueuedScan(
      d1,
      "scan_incident_01",
      "https://morrow.example.test/",
    );
    await d1
      .prepare(
        `UPDATE scans SET status = 'capturing', started_at = ?, budgets_json = ?, usage_json = ? WHERE id = ?`,
      )
      .bind(
        T0,
        JSON.stringify({ maxPages: 10, maxWallTimeMs: 60_000 }),
        JSON.stringify({ pagesDiscovered: 3, browserMs: 0 }),
        scanId,
      )
      .run();
    const pages = [
      {
        id: "page_home",
        path: "/",
        status: "captured",
        title: "Morrow - plan your day with focus",
      },
      {
        id: "page_login",
        path: "/login",
        status: "captured",
        title: "Sign in to Morrow and plan your day",
      },
      { id: "page_register", path: "/register", status: "pending", title: "" },
    ];
    for (const [i, p] of pages.entries()) {
      const url = `https://morrow.example.test${p.path}`;
      await d1
        .prepare(
          `INSERT INTO pages (id, scan_id, url, normalized_url, template_type, status_code, capture_status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'other', 200, ?, ?, ?)`,
        )
        .bind(p.id, scanId, url, url, p.status, T0 + i, T0 + i)
        .run();
      if (p.status === "captured") {
        await persistPageCaptureEvidenceToR2AndD1({
          d1,
          r2,
          scanId,
          pageId: p.id,
          capture: buildCaptureResult({
            url,
            html: `<!doctype html><html lang="en"><head><title>${p.title}</title><link rel="canonical" href="${url}"></head><body><h1>${p.title}</h1></body></html>`,
          }),
          nowMs: T0 + 10_000,
        });
      }
    }

    const queued: ScanQueueMessage[] = [
      captureMessage(scanId, workspaceId, siteId),
    ];
    let clock = T0 + 61_327;
    const launcher = vi.fn();
    for (let guard = 0; queued.length > 0 && guard < 10; guard += 1) {
      const body = queued.shift()!;
      await worker.queue(
        {
          queue: "mortem-scans",
          messages: [
            { id: `incident_${guard}`, body, ack: vi.fn(), retry: vi.fn() },
          ],
        },
        {
          ENVIRONMENT: "test",
          DB: d1,
          EVIDENCE: r2,
          SCAN_QUEUE: {
            send: async (msg: ScanQueueMessage) => {
              queued.push(msg);
            },
          },
        },
        {
          now: () => (clock += 100),
          browserLauncher: launcher as unknown as never,
          psiFetch: vi.fn() as unknown as typeof fetch,
        },
      );
    }

    // The budget had run out, so no new capture was started...
    expect(launcher).not.toHaveBeenCalled();
    const register = await d1
      .prepare(`SELECT capture_status, failure_reason FROM pages WHERE id = ?`)
      .bind("page_register")
      .first<{ capture_status: string; failure_reason: string }>();
    expect(register?.capture_status).toBe("skipped");
    expect(register?.failure_reason).toContain("wall-clock budget exceeded");

    // ...but the two pages already captured were kept and checked, and the scan
    // ended partial instead of failed.
    const scan = await d1
      .prepare(
        `SELECT status, failure_class, failure_reason, usage_json FROM scans WHERE id = ?`,
      )
      .bind(scanId)
      .first<{
        status: string;
        failure_class: string;
        failure_reason: string;
        usage_json: string;
      }>();
    expect(scan?.status).toBe("partial");
    expect(scan?.failure_class).toBe("budget_exceeded");
    expect(scan?.failure_reason).toContain("wall-clock budget exceeded");
    expect(JSON.parse(scan!.usage_json)).toMatchObject({
      pagesDiscovered: 3,
      pagesCaptured: 2,
    });
    const capturing = await d1
      .prepare(
        `SELECT message FROM scan_events WHERE scan_id = ? AND stage = 'capturing'`,
      )
      .bind(scanId)
      .first<{ message: string }>();
    expect(capturing?.message).toContain("Partial capture (2/3 page(s))");
    const checking = await d1
      .prepare(
        `SELECT message FROM scan_events WHERE scan_id = ? AND stage = 'checking'`,
      )
      .bind(scanId)
      .first<{ message: string }>();
    expect(checking?.message).toContain("SEO: 2/2 page(s) analyzed");
  });

  it("counts browser time used by earlier attempts against the browser budget", async () => {
    const d1 = createSqliteD1();
    const { scanId, workspaceId, siteId } = await seedWorkspaceAndQueuedScan(
      d1,
      "scan_incident_02",
      "https://morrow.example.test/",
    );
    await d1
      .prepare(
        `UPDATE scans SET status = 'capturing', started_at = ?, budgets_json = ?, usage_json = ? WHERE id = ?`,
      )
      .bind(
        T0,
        JSON.stringify({ maxBrowserMs: 50_000 }),
        JSON.stringify({ browserMs: 50_000 }), // already used by an earlier attempt
        scanId,
      )
      .run();
    await d1
      .prepare(
        `INSERT INTO pages (id, scan_id, url, normalized_url, template_type, capture_status, created_at, updated_at)
         VALUES ('page_pending', ?, 'https://morrow.example.test/x', 'https://morrow.example.test/x', 'other', 'pending', ?, ?)`,
      )
      .bind(scanId, T0, T0)
      .run();
    const launcher = vi.fn();
    await worker.queue(
      {
        queue: "mortem-scans",
        messages: [
          {
            id: "incident_b",
            body: captureMessage(scanId, workspaceId, siteId),
            ack: vi.fn(),
            retry: vi.fn(),
          },
        ],
      },
      {
        ENVIRONMENT: "test",
        DB: d1,
        EVIDENCE: createInMemoryR2(),
        SCAN_QUEUE: { send: async () => undefined },
      },
      {
        now: () => T0 + 1_000,
        browserLauncher: launcher as unknown as never,
      },
    );
    expect(launcher).not.toHaveBeenCalled();
    const pageRow = await d1
      .prepare(`SELECT capture_status, failure_reason FROM pages WHERE id = ?`)
      .bind("page_pending")
      .first<{ capture_status: string; failure_reason: string }>();
    expect(pageRow?.capture_status).toBe("skipped");
    expect(pageRow?.failure_reason).toContain(
      "browser execution budget exceeded",
    );
  });
});

describe("@mortem/scan-worker capture budgets: page cap across redeliveries", () => {
  it("counts pages captured by an earlier attempt against maxPages", async () => {
    const T0 = 1_792_143_198_981;
    const d1 = createSqliteD1();
    const { scanId, workspaceId, siteId } = await seedWorkspaceAndQueuedScan(
      d1,
      "scan_incident_03",
      "https://morrow.example.test/",
    );
    await d1
      .prepare(
        `UPDATE scans SET status = 'capturing', started_at = ?, budgets_json = ? WHERE id = ?`,
      )
      .bind(T0, JSON.stringify({ maxPages: 2 }), scanId)
      .run();
    const seeded = [
      ["page_a", "/", "captured"],
      ["page_b", "/about", "captured"],
      ["page_c", "/pricing", "pending"],
    ] as const;
    for (const [i, [id, path, status]] of seeded.entries()) {
      const url = `https://morrow.example.test${path}`;
      await d1
        .prepare(
          `INSERT INTO pages (id, scan_id, url, normalized_url, template_type, capture_status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'other', ?, ?, ?)`,
        )
        .bind(id, scanId, url, url, status, T0 + i, T0 + i)
        .run();
    }
    const launcher = vi.fn();
    await worker.queue(
      {
        queue: "mortem-scans",
        messages: [
          {
            id: "incident_c",
            body: {
              kind: "website_scan",
              scanId,
              workspaceId,
              siteId,
              targetUrl: "https://morrow.example.test/",
              stage: "capturing",
              attempt: 1,
              idempotencyKey: `${scanId}:capturing`,
            },
            ack: vi.fn(),
            retry: vi.fn(),
          },
        ],
      },
      {
        ENVIRONMENT: "test",
        DB: d1,
        EVIDENCE: createInMemoryR2(),
        SCAN_QUEUE: { send: async () => undefined },
      },
      {
        now: () => T0 + 1_000,
        browserLauncher: launcher as unknown as never,
      },
    );
    expect(launcher).not.toHaveBeenCalled();
    const pageRow = await d1
      .prepare(`SELECT capture_status, failure_reason FROM pages WHERE id = ?`)
      .bind("page_c")
      .first<{ capture_status: string; failure_reason: string }>();
    expect(pageRow?.capture_status).toBe("skipped");
    expect(pageRow?.failure_reason).toContain("maxPages");
  });
});

describe("@mortem/scan-worker capture on the Workers Free plan", () => {
  const T0 = 1_792_200_000_000;

  /** A fake browser; `gotoError(url)` makes navigation to that URL throw. */
  function fakeLauncher(gotoError?: (url: string) => Error | null) {
    return vi.fn(async () => ({
      async newContext() {
        return {
          async newPage() {
            let currentUrl = "https://site.example.test/";
            return {
              async addInitScript() {},
              async route() {},
              on() {},
              async goto(targetUrl: string) {
                const err = gotoError?.(targetUrl);
                if (err) throw err;
                currentUrl = targetUrl;
                const req = {
                  url: () => currentUrl,
                  method: () => "GET",
                  resourceType: () => "document",
                  isNavigationRequest: () => true,
                  redirectedFrom: () => null,
                };
                return {
                  url: () => currentUrl,
                  status: () => 200,
                  headers: () => ({ "content-type": "text/html" }),
                  request: () => req,
                };
              },
              async waitForLoadState() {},
              async evaluate<R>() {
                return { ttfbMs: 20, fcpMs: 60 } as unknown as R;
              },
              async content() {
                return `<html lang="en"><head><title>Site page for tests</title></head><body><h1>Page</h1></body></html>`;
              },
              async title() {
                return "Site page for tests";
              },
              url: () => currentUrl,
              async screenshot() {
                return new Uint8Array([137, 80, 78, 71]);
              },
              async close() {},
            };
          },
          async close() {},
        };
      },
      async close() {},
    }));
  }

  async function seedCapturingScan(
    scanId: string,
    pages: ReadonlyArray<{ id: string; path: string; status: string }>,
  ) {
    const d1 = createSqliteD1();
    const ids = await seedWorkspaceAndQueuedScan(
      d1,
      scanId,
      "https://site.example.test/",
    );
    await d1
      .prepare(
        `UPDATE scans SET status = 'capturing', started_at = ? WHERE id = ?`,
      )
      .bind(T0, scanId)
      .run();
    for (const [i, p] of pages.entries()) {
      const url = `https://site.example.test${p.path}`;
      await d1
        .prepare(
          `INSERT INTO pages (id, scan_id, url, normalized_url, template_type, status_code, capture_status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'other', 200, ?, ?, ?)`,
        )
        .bind(p.id, scanId, url, url, p.status, T0 + i, T0 + i)
        .run();
    }
    return { d1, ...ids };
  }

  /** Runs queue messages until none are left; returns each send's delay. */
  async function drive(params: {
    d1: D1DatabaseLike;
    r2: R2BucketLike;
    first: ScanQueueMessage;
    launcher: ReturnType<typeof fakeLauncher>;
    queueName?: string;
  }) {
    const queued: ScanQueueMessage[] = [params.first];
    const sends: Array<{ stage?: string; delaySeconds?: number }> = [];
    const sentKeys: Array<string | undefined> = [];
    const acks: string[] = [];
    let clock = T0 + 1_000;
    for (let guard = 0; queued.length > 0 && guard < 20; guard += 1) {
      const body = queued.shift()!;
      await worker.queue(
        {
          queue:
            guard === 0 && params.queueName ? params.queueName : "mortem-scans",
          messages: [
            {
              id: `m_${guard}`,
              body,
              ack: () => acks.push(body.stage ?? ""),
              retry: vi.fn(),
            },
          ],
        },
        {
          ENVIRONMENT: "test",
          DB: params.d1,
          EVIDENCE: params.r2,
          SCAN_QUEUE: {
            send: async (
              msg: ScanQueueMessage,
              opts?: { delaySeconds?: number },
            ) => {
              queued.push(msg);
              sentKeys.push(msg.idempotencyKey);
              sends.push({
                stage: msg.stage,
                delaySeconds: opts?.delaySeconds,
              });
            },
          },
        },
        {
          now: () => (clock += 100),
          browserLauncher: params.launcher as unknown as never,
          psiFetch: vi.fn() as unknown as typeof fetch,
        },
      );
    }
    return { sends, sentKeys, acks };
  }

  function captureMessage(
    scanId: string,
    ids: { workspaceId: string; siteId: string },
  ): ScanQueueMessage {
    return {
      kind: "website_scan",
      scanId,
      workspaceId: ids.workspaceId,
      siteId: ids.siteId,
      targetUrl: "https://site.example.test/",
      stage: "capturing",
      attempt: 1,
      idempotencyKey: `${scanId}:capturing`,
    };
  }

  async function scanRow(d1: D1DatabaseLike, scanId: string) {
    return d1
      .prepare(
        `SELECT status, failure_class, failure_reason FROM scans WHERE id = ?`,
      )
      .bind(scanId)
      .first<{
        status: string;
        failure_class: string | null;
        failure_reason: string | null;
      }>();
  }

  async function pageRows(d1: D1DatabaseLike, scanId: string) {
    const res = await d1
      .prepare(
        `SELECT id, capture_status, failure_reason FROM pages WHERE scan_id = ? ORDER BY created_at`,
      )
      .bind(scanId).all!<{
      id: string;
      capture_status: string;
      failure_reason: string | null;
    }>();
    return res.results ?? [];
  }

  it("captures one page per run, 20 s apart, then hands off to checking", async () => {
    const { d1, scanId, ...ids } = await seedCapturingScan("scan_free_01", [
      { id: "p1", path: "/", status: "pending" },
      { id: "p2", path: "/a", status: "pending" },
      { id: "p3", path: "/b", status: "pending" },
    ]);
    const launcher = fakeLauncher();
    const { sends, sentKeys } = await drive({
      d1,
      r2: createInMemoryR2(),
      first: captureMessage(scanId, ids),
      launcher,
    });
    // Requeued runs keep the stage's own idempotency key.
    expect(sentKeys.slice(0, 2)).toEqual([
      `${scanId}:capturing`,
      `${scanId}:capturing`,
    ]);
    // One browser launch per run, three runs.
    expect(launcher).toHaveBeenCalledTimes(3);
    expect(sends.slice(0, 3)).toEqual([
      { stage: "capturing", delaySeconds: 20 },
      { stage: "capturing", delaySeconds: 20 },
      { stage: "checking", delaySeconds: undefined },
    ]);
    // Requeued runs write no capturing event; the final run writes exactly one.
    const events = await d1
      .prepare(
        `SELECT COUNT(*) AS n FROM scan_events WHERE scan_id = ? AND stage = 'capturing'`,
      )
      .bind(scanId)
      .first<{ n: number }>();
    expect(events?.n).toBe(1);
    expect((await scanRow(d1, scanId))?.status).toBe("complete");
  });

  it("marks a page that fails to load as failed, keeps the others and ends partial", async () => {
    const { d1, scanId, ...ids } = await seedCapturingScan("scan_free_02", [
      { id: "p1", path: "/", status: "pending" },
      { id: "p2", path: "/slow", status: "pending" },
      { id: "p3", path: "/c", status: "pending" },
    ]);
    const launcher = fakeLauncher((url) =>
      url.endsWith("/slow")
        ? new Error("page.goto: Timeout 25000ms exceeded.")
        : null,
    );
    await drive({
      d1,
      r2: createInMemoryR2(),
      first: captureMessage(scanId, ids),
      launcher,
    });
    const pages = await pageRows(d1, scanId);
    expect(pages.map((p) => `${p.id}:${p.capture_status}`)).toEqual([
      "p1:captured",
      "p2:failed",
      "p3:captured",
    ]);
    expect(pages[1]!.failure_reason).toMatch(
      /^navigation_timeout: page\.goto: Timeout 25000ms exceeded\./,
    );
    const scan = await scanRow(d1, scanId);
    expect(scan?.status).toBe("partial");
    expect(scan?.failure_class).toBe("navigation_timeout");
    expect(scan?.failure_reason).toContain(
      "1 of 3 page(s) could not be captured",
    );
  });

  it("fails the scan with the page reason when no page could be captured", async () => {
    const { d1, scanId, ...ids } = await seedCapturingScan("scan_free_03", [
      { id: "p1", path: "/", status: "pending" },
    ]);
    await drive({
      d1,
      r2: createInMemoryR2(),
      first: captureMessage(scanId, ids),
      launcher: fakeLauncher(
        () => new Error("page.goto: Timeout 25000ms exceeded."),
      ),
    });
    const scan = await scanRow(d1, scanId);
    expect(scan?.status).toBe("failed");
    expect(scan?.failure_class).toBe("navigation_timeout");
    expect(scan?.failure_reason).toContain(
      "1 of 1 page(s) could not be captured",
    );
  });

  it("keeps the page pending and retries after 30 s when Browser Run refuses a new browser", async () => {
    const { d1, scanId, ...ids } = await seedCapturingScan("scan_free_04", [
      { id: "p1", path: "/", status: "pending" },
    ]);
    const launcher = vi.fn(async () => {
      throw new Error(
        "Unable to create new browser: code: 429: message: Rate limit exceeded",
      );
    });
    const sends: Array<{ stage?: string; delaySeconds?: number }> = [];
    const ack = vi.fn();
    const retry = vi.fn();
    await worker.queue(
      {
        queue: "mortem-scans",
        messages: [
          { id: "m_429", body: captureMessage(scanId, ids), ack, retry },
        ],
      },
      {
        ENVIRONMENT: "test",
        DB: d1,
        EVIDENCE: createInMemoryR2(),
        SCAN_QUEUE: {
          send: async (
            msg: ScanQueueMessage,
            opts?: { delaySeconds?: number },
          ) => {
            sends.push({ stage: msg.stage, delaySeconds: opts?.delaySeconds });
          },
        },
      },
      { now: () => T0 + 1_000, browserLauncher: launcher as unknown as never },
    );
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(sends).toEqual([{ stage: "capturing", delaySeconds: 30 }]);
    expect((await pageRows(d1, scanId))[0]!.capture_status).toBe("pending");
    expect((await scanRow(d1, scanId))?.status).toBe("capturing");
  });

  it("stops at the daily browser limit, keeps captured pages and ends partial", async () => {
    const { d1, scanId, ...ids } = await seedCapturingScan("scan_free_05", [
      { id: "p1", path: "/", status: "pending" },
      { id: "p2", path: "/a", status: "pending" },
      { id: "p3", path: "/b", status: "pending" },
    ]);
    let launches = 0;
    const real = fakeLauncher();
    const launcher = vi.fn(async (binding: unknown) => {
      launches += 1;
      if (launches > 1) {
        throw new Error(
          "Unable to create new browser: code: 429: message: Browser time limit exceeded for today",
        );
      }
      return (real as unknown as (b: unknown) => Promise<unknown>)(binding);
    });
    await drive({
      d1,
      r2: createInMemoryR2(),
      first: captureMessage(scanId, ids),
      launcher: launcher as unknown as ReturnType<typeof fakeLauncher>,
    });
    const pages = await pageRows(d1, scanId);
    expect(pages.map((p) => `${p.id}:${p.capture_status}`)).toEqual([
      "p1:captured",
      "p2:skipped",
      "p3:skipped",
    ]);
    expect(pages[1]!.failure_reason).toBe(BROWSER_DAILY_LIMIT_REASON);
    const scan = await scanRow(d1, scanId);
    expect(scan?.status).toBe("partial");
    expect(scan?.failure_class).toBe("budget_exceeded");
    expect(scan?.failure_reason).toBe(BROWSER_DAILY_LIMIT_REASON);
  });

  it("does not re-capture the site when a repeated capture run finds no pending pages", async () => {
    const { d1, scanId, ...ids } = await seedCapturingScan("scan_free_06", [
      { id: "p1", path: "/", status: "captured" },
      { id: "p2", path: "/a", status: "skipped" },
    ]);
    const launcher = fakeLauncher();
    const sends: Array<string | undefined> = [];
    await worker.queue(
      {
        queue: "mortem-scans",
        messages: [
          {
            id: "m_dup",
            body: captureMessage(scanId, ids),
            ack: vi.fn(),
            retry: vi.fn(),
          },
        ],
      },
      {
        ENVIRONMENT: "test",
        DB: d1,
        EVIDENCE: createInMemoryR2(),
        SCAN_QUEUE: {
          send: async (msg: ScanQueueMessage) => {
            sends.push(msg.stage);
          },
        },
      },
      { now: () => T0 + 1_000, browserLauncher: launcher as unknown as never },
    );
    expect(launcher).not.toHaveBeenCalled();
    expect(sends).toEqual(["checking"]);
  });

  it("continues to the checks with the captured pages when the capture stage is dead-lettered", async () => {
    const { d1, scanId, ...ids } = await seedCapturingScan("scan_free_07", [
      { id: "p1", path: "/", status: "captured" },
      { id: "p2", path: "/heavy", status: "pending" },
    ]);
    const sends: Array<string | undefined> = [];
    const ack = vi.fn();
    await worker.queue(
      {
        queue: "mortem-scans-dlq",
        messages: [
          {
            id: "m_dlq",
            body: captureMessage(scanId, ids),
            ack,
            retry: vi.fn(),
          },
        ],
      },
      {
        ENVIRONMENT: "test",
        DB: d1,
        SCAN_QUEUE: {
          send: async (msg: ScanQueueMessage) => {
            sends.push(msg.stage);
          },
        },
      },
      { now: () => T0 + 1_000 },
    );
    expect(ack).toHaveBeenCalledOnce();
    expect(sends).toEqual(["checking"]);
    const pages = await pageRows(d1, scanId);
    expect(pages[1]!.capture_status).toBe("failed");
    expect(pages[1]!.failure_reason).toBe(DEAD_LETTERED_CAPTURE_PAGE_REASON);
    const event = await d1
      .prepare(
        `SELECT metadata_json FROM scan_events WHERE scan_id = ? AND stage = 'capturing'`,
      )
      .bind(scanId)
      .first<{ metadata_json: string }>();
    expect(JSON.parse(event!.metadata_json).partialCoverage).toMatchObject({
      failureClass: "internal_error",
      reason: expect.stringContaining("1 of 2 page(s) could not be captured"),
    });
    expect((await scanRow(d1, scanId))?.status).toBe("capturing");
  });

  it("still fails a dead-lettered capture stage that captured nothing", async () => {
    const { d1, scanId, ...ids } = await seedCapturingScan("scan_free_08", [
      { id: "p1", path: "/", status: "pending" },
    ]);
    const sends: Array<string | undefined> = [];
    await worker.queue(
      {
        queue: "mortem-scans-dlq",
        messages: [
          {
            id: "m_dlq0",
            body: captureMessage(scanId, ids),
            ack: vi.fn(),
            retry: vi.fn(),
          },
        ],
      },
      {
        ENVIRONMENT: "test",
        DB: d1,
        SCAN_QUEUE: {
          send: async (msg: ScanQueueMessage) => {
            sends.push(msg.stage);
          },
        },
      },
      { now: () => T0 + 1_000 },
    );
    expect(sends).toEqual([]);
    expect((await scanRow(d1, scanId))?.status).toBe("failed");
  });
});
