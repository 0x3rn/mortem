import {
  type D1DatabaseLike,
  type MortemWebBindings,
  type PlatformSmokeRow,
  type R2BucketLike,
} from "@mortem/core";
import { describe, expect, it, vi } from "vitest";
import worker, {
  type QueueMessageEnvelope,
  type ScanQueueMessage,
} from "@mortem/scan-worker";
import { handlePlatformSmokeGet, handlePlatformSmokePost } from "./route";

function createInMemoryCloudflareHarness() {
  const smokeRows = new Map<string, PlatformSmokeRow>();
  const r2Objects = new Map<string, Uint8Array>();
  const queuedMessages: ScanQueueMessage[] = [];

  const DB: D1DatabaseLike = {
    prepare(query: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async run() {
              if (query.includes("INSERT INTO _platform_smoke_runs")) {
                const [id, target_url, r2_object_key, created_at] =
                  values as string[];
                smokeRows.set(id!, {
                  id: id!,
                  target_url: target_url!,
                  status: "queued",
                  r2_object_key: r2_object_key ?? null,
                  r2_byte_size: null,
                  browser_title: null,
                  error_message: null,
                  created_at: created_at!,
                  completed_at: null,
                });
              } else if (
                query.includes("UPDATE _platform_smoke_runs") &&
                query.includes("status = 'completed'")
              ) {
                const [
                  r2_object_key,
                  r2_byte_size,
                  browser_title,
                  completed_at,
                  id,
                ] = values as [string, number, string, string, string];
                const existing = smokeRows.get(id);
                if (existing) {
                  smokeRows.set(id, {
                    ...existing,
                    status: "completed",
                    r2_object_key,
                    r2_byte_size,
                    browser_title,
                    error_message: null,
                    completed_at,
                  });
                }
              }
              return { success: true };
            },
            async first<T>() {
              const [id] = values as [string];
              return (smokeRows.get(id) as unknown as T) ?? null;
            },
          };
        },
      };
    },
  };

  const EVIDENCE: R2BucketLike = {
    async put(key, value) {
      const bytes =
        value instanceof Uint8Array
          ? value
          : typeof value === "string"
            ? new TextEncoder().encode(value)
            : new Uint8Array(value);
      r2Objects.set(key, bytes);
      return { key, size: bytes.byteLength };
    },
    async head(key) {
      const bytes = r2Objects.get(key);
      if (!bytes) return null;
      return { key, size: bytes.byteLength };
    },
  };

  const SCAN_QUEUE = {
    async send(message: unknown) {
      queuedMessages.push(message as ScanQueueMessage);
    },
  };

  return {
    DB,
    EVIDENCE,
    SCAN_QUEUE,
    smokeRows,
    r2Objects,
    queuedMessages,
  };
}

describe("Platform smoke end-to-end flow (mortem-web -> SCAN_QUEUE -> mortem-scan -> Browser Run + R2 + D1)", () => {
  it("completes the full smoke pipeline from web POST intake to queue worker execution and GET verification", async () => {
    const harness = createInMemoryCloudflareHarness();
    const webEnv: MortemWebBindings = {
      ENVIRONMENT: "staging",
      DB: harness.DB,
      EVIDENCE: harness.EVIDENCE,
      SCAN_QUEUE: harness.SCAN_QUEUE,
    };

    // 1. mortem-web POST /api/internal/platform-smoke enqueues job and writes queued D1 row
    const postRes = await handlePlatformSmokePost(
      new Request("https://mortem.dev/api/internal/platform-smoke", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetUrl: "example.com" }),
      }),
      webEnv,
    );

    expect(postRes.status).toBe(202);
    const postPayload = (await postRes.json()) as {
      ok: boolean;
      smokeId: string;
      status: string;
      targetUrl: string;
      expectedR2Key: string;
    };
    expect(postPayload.ok).toBe(true);
    expect(postPayload.status).toBe("queued");
    expect(postPayload.targetUrl).toBe("https://example.com/");
    expect(harness.queuedMessages).toHaveLength(1);

    // 2. mortem-scan consumes SCAN_QUEUE message, runs Browser Run, writes PNG to R2, updates D1 row
    const queueEnvelope: QueueMessageEnvelope<ScanQueueMessage> = {
      id: "q-1",
      body: harness.queuedMessages[0]!,
      ack: vi.fn(),
      retry: vi.fn(),
    };

    const queueSummary = await worker.queue(
      {
        queue: "mortem-scans-staging",
        messages: [queueEnvelope],
      },
      {
        ENVIRONMENT: "staging",
        DB: harness.DB,
        EVIDENCE: harness.EVIDENCE,
        BROWSER: {
          fetch: async () => new Response(null, { status: 200 }),
        },
      },
      {
        browserCapture: async (_browser, url) => ({
          screenshot: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
          title: `Example Domain (${url})`,
        }),
      },
    );

    expect(queueSummary.completedSmokeIds).toEqual([postPayload.smokeId]);
    expect(queueEnvelope.ack).toHaveBeenCalledOnce();

    // 3. mortem-web GET /api/internal/platform-smoke verifies completed D1 row and R2 object metadata
    const getRes = await handlePlatformSmokeGet(
      new Request(
        `https://mortem.dev/api/internal/platform-smoke?smokeId=${postPayload.smokeId}`,
        { method: "GET" },
      ),
      webEnv,
    );

    expect(getRes.status).toBe(200);
    const getPayload = (await getRes.json()) as {
      ok: boolean;
      r2Verified: boolean;
      r2Object: { key: string; size: number };
      smokeRun: PlatformSmokeRow;
    };
    expect(getPayload.ok).toBe(true);
    expect(getPayload.r2Verified).toBe(true);
    expect(getPayload.r2Object).toEqual({
      key: postPayload.expectedR2Key,
      size: 8,
    });
    expect(getPayload.smokeRun.status).toBe("completed");
    expect(getPayload.smokeRun.browser_title).toBe(
      "Example Domain (https://example.com/)",
    );
  });

  it("blocks unauthenticated requests in production unless x-mortem-admin-secret matches", async () => {
    const harness = createInMemoryCloudflareHarness();
    const prodEnv: MortemWebBindings = {
      ENVIRONMENT: "production",
      MORTEM_ADMIN_SECRET: "top-secret-token",
      DB: harness.DB,
      EVIDENCE: harness.EVIDENCE,
      SCAN_QUEUE: harness.SCAN_QUEUE,
    };

    const forbiddenRes = await handlePlatformSmokePost(
      new Request("https://mortem.dev/api/internal/platform-smoke", {
        method: "POST",
      }),
      prodEnv,
    );
    expect(forbiddenRes.status).toBe(403);

    const allowedRes = await handlePlatformSmokePost(
      new Request("https://mortem.dev/api/internal/platform-smoke", {
        method: "POST",
        headers: { "x-mortem-admin-secret": "top-secret-token" },
      }),
      prodEnv,
    );
    expect(allowedRes.status).toBe(202);
  });

  it("returns 503 with explicit binding error and never invents data when bindings are missing or fail", async () => {
    const missingBindingRes = await handlePlatformSmokePost(
      new Request("https://mortem.dev/api/internal/platform-smoke", {
        method: "POST",
      }),
      { ENVIRONMENT: "staging" },
    );

    expect(missingBindingRes.status).toBe(503);
    const body = (await missingBindingRes.json()) as {
      ok: boolean;
      code: string;
      binding: string;
    };
    expect(body.ok).toBe(false);
    expect(body.code).toBe("MISSING_BINDING");
    expect(body.binding).toBe("DB");
  });
});
