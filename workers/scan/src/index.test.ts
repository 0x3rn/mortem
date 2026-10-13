import { describe, expect, it, vi } from "vitest";
import worker, { type QueueBatch, type ScanQueueMessage } from "./index";

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
      policy: { submitForms: boolean; allowedHttpMethods: string[] };
      categories: string[];
    };
    expect(payload.ok).toBe(true);
    expect(payload.service).toBe("mortem-scan-worker");
    expect(payload.environment).toBe("test");
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
    });
    expect(ackValid).toHaveBeenCalledOnce();
    expect(ackInvalid).toHaveBeenCalledOnce();
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
});
