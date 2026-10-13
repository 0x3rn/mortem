import {
  DIAGNOSTIC_CATEGORIES,
  READ_ONLY_SCAN_POLICY,
  SCAN_STAGES,
  isAllowedScanMethod,
  normalizeUrlInput,
  type ScanStage,
} from "@mortem/core";

export interface ScanQueueMessage {
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

export interface ScanWorkerEnv {
  ENVIRONMENT?: string;
}

export interface QueueBatchSummary {
  queue: string;
  environment: string;
  acceptedScanIds: string[];
  rejectedScanIds: string[];
}

export interface ScheduledRunSummary {
  cron: string;
  environment: string;
  scheduledAtIso: string;
  status: "idle" | "dispatched";
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
  ): Promise<QueueBatchSummary> {
    const acceptedScanIds: string[] = [];
    const rejectedScanIds: string[] = [];

    for (const message of batch.messages) {
      const { scanId, targetUrl } = message.body;
      const normalized = normalizeUrlInput(targetUrl);

      if (!scanId || !normalized) {
        rejectedScanIds.push(scanId || message.id);
        message.ack();
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
