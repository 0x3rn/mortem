import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  PlatformBindingError,
  listScanEvidenceArtifactsInD1,
  verifyScanEvidenceCompletenessInD1,
  type D1BoundStatementLike,
  type D1DatabaseLike,
  type D1ExecResultLike,
  type R2BucketLike,
} from "@mortem/core";
import { describe, expect, it, vi } from "vitest";
import worker, { type QueueBatch, type ScanQueueMessage } from "./index";

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

function createSqliteD1(): D1DatabaseLike {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  sqlite.exec(MIGRATION_0001_SQL);
  sqlite.exec(MIGRATION_0002_SQL);
  sqlite.exec(MIGRATION_0003_SQL);

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
    await worker.queue(
      {
        queue: "mortem-scans",
        messages: [
          {
            id: "msg_cap_1",
            body: enqueuedMessages[0]!,
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
          send: async (msg: ScanQueueMessage) => {
            enqueuedMessages.push(msg);
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

    expect(ackCapture).toHaveBeenCalledOnce();
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
    // 4 pages * 6 core artifacts (html, headers, screenshot_desktop, screenshot_mobile, network_log, console_log) = 24
    expect(artifacts).toHaveLength(24);
    const completeness = await verifyScanEvidenceCompletenessInD1(
      d1,
      scanId,
      r2Bucket,
    );
    expect(completeness.complete).toBe(true);
    expect(completeness.violations).toHaveLength(0);
  });
});
