import {
  PlatformBindingError,
  buildSmokeArtifactKey,
  normalizeUrlInput,
  requireWebBindings,
  type MortemWebBindings,
  type PlatformSmokeRow,
} from "@mortem/core";
import { getCloudflareContext } from "@opennextjs/cloudflare";

function isAuthorizedForSmoke(
  request: Request,
  env: MortemWebBindings | null | undefined,
): boolean {
  const environment = env?.ENVIRONMENT ?? process.env.NODE_ENV ?? "development";
  const providedSecret = request.headers.get("x-mortem-admin-secret");
  const expectedSecret = env?.MORTEM_ADMIN_SECRET;

  if (expectedSecret && providedSecret === expectedSecret) {
    return true;
  }

  return environment !== "production";
}

export async function handlePlatformSmokePost(
  request: Request,
  rawEnv: MortemWebBindings | null | undefined,
): Promise<Response> {
  if (!isAuthorizedForSmoke(request, rawEnv)) {
    return Response.json(
      {
        ok: false,
        code: "FORBIDDEN",
        error:
          "Platform smoke route requires x-mortem-admin-secret in production.",
      },
      { status: 403 },
    );
  }

  let env;
  try {
    env = requireWebBindings(rawEnv);
  } catch (err) {
    if (err instanceof PlatformBindingError) {
      return Response.json(
        {
          ok: false,
          code: err.code,
          binding: err.bindingName,
          error: err.message,
        },
        { status: 503 },
      );
    }
    throw err;
  }

  let requestedUrl = "https://example.com/";
  try {
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const body = (await request.json()) as { targetUrl?: string };
      if (body.targetUrl) {
        const normalized = normalizeUrlInput(body.targetUrl);
        if (!normalized) {
          return Response.json(
            {
              ok: false,
              code: "INVALID_TARGET_URL",
              error: "Provided targetUrl is not a valid public HTTP(S) URL.",
            },
            { status: 400 },
          );
        }
        requestedUrl = normalized;
      }
    }
  } catch {
    return Response.json(
      {
        ok: false,
        code: "INVALID_JSON",
        error: "Request body must be valid JSON.",
      },
      { status: 400 },
    );
  }

  const smokeId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const expectedR2Key = buildSmokeArtifactKey(smokeId);

  try {
    await env.DB.prepare(
      `INSERT INTO _platform_smoke_runs (id, target_url, status, r2_object_key, created_at)
       VALUES (?, ?, 'queued', ?, ?)`,
    )
      .bind(smokeId, requestedUrl, expectedR2Key, createdAt)
      .run();
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Unknown D1 insert error";
    return Response.json(
      {
        ok: false,
        code: "DATABASE_QUERY_FAILED",
        binding: "DB",
        error: `Failed to record platform smoke run in D1: ${message}`,
      },
      { status: 503 },
    );
  }

  try {
    await env.SCAN_QUEUE.send({
      kind: "platform_smoke",
      smokeId,
      scanId: `smoke_${smokeId}`,
      targetUrl: requestedUrl,
      stage: "queued",
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Unknown Queue send error";
    return Response.json(
      {
        ok: false,
        code: "QUEUE_SEND_FAILED",
        binding: "SCAN_QUEUE",
        error: `Failed to enqueue platform smoke job on SCAN_QUEUE: ${message}`,
      },
      { status: 503 },
    );
  }

  return Response.json(
    {
      ok: true,
      smokeId,
      status: "queued",
      targetUrl: requestedUrl,
      expectedR2Key,
      createdAt,
    },
    { status: 202 },
  );
}

export async function handlePlatformSmokeGet(
  request: Request,
  rawEnv: MortemWebBindings | null | undefined,
): Promise<Response> {
  if (!isAuthorizedForSmoke(request, rawEnv)) {
    return Response.json(
      {
        ok: false,
        code: "FORBIDDEN",
        error:
          "Platform smoke route requires x-mortem-admin-secret in production.",
      },
      { status: 403 },
    );
  }

  let env;
  try {
    env = requireWebBindings(rawEnv);
  } catch (err) {
    if (err instanceof PlatformBindingError) {
      return Response.json(
        {
          ok: false,
          code: err.code,
          binding: err.bindingName,
          error: err.message,
        },
        { status: 503 },
      );
    }
    throw err;
  }

  const url = new URL(request.url);
  const smokeId = url.searchParams.get("smokeId");
  if (!smokeId) {
    return Response.json(
      {
        ok: false,
        code: "MISSING_SMOKE_ID",
        error: "Query parameter 'smokeId' is required.",
      },
      { status: 400 },
    );
  }

  let row: PlatformSmokeRow | null;
  try {
    row = await env.DB.prepare(
      `SELECT id, target_url, status, r2_object_key, r2_byte_size, browser_title, error_message, created_at, completed_at
       FROM _platform_smoke_runs
       WHERE id = ?`,
    )
      .bind(smokeId)
      .first<PlatformSmokeRow>();
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Unknown D1 query error";
    return Response.json(
      {
        ok: false,
        code: "DATABASE_QUERY_FAILED",
        binding: "DB",
        error: `Failed to read platform smoke run from D1: ${message}`,
      },
      { status: 503 },
    );
  }

  if (!row) {
    return Response.json(
      {
        ok: false,
        code: "NOT_FOUND",
        error: `No platform smoke run found for id '${smokeId}'.`,
      },
      { status: 404 },
    );
  }

  let r2Head: { key: string; size: number } | null = null;
  if (row.r2_object_key && row.status === "completed") {
    try {
      const meta = await env.EVIDENCE.head(row.r2_object_key);
      if (meta) {
        r2Head = { key: meta.key, size: meta.size };
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unknown R2 head error";
      return Response.json(
        {
          ok: false,
          code: "STORAGE_READ_FAILED",
          binding: "EVIDENCE",
          error: `Failed to verify R2 object metadata: ${message}`,
        },
        { status: 503 },
      );
    }
  }

  return Response.json({
    ok: true,
    smokeRun: row,
    r2Verified: Boolean(r2Head && r2Head.size > 0),
    r2Object: r2Head,
  });
}

async function resolveRuntimeEnv(): Promise<MortemWebBindings | null> {
  try {
    const ctx = await getCloudflareContext({ async: true });
    return (ctx?.env as unknown as MortemWebBindings) ?? null;
  } catch {
    return null;
  }
}

export async function POST(request: Request): Promise<Response> {
  const env = await resolveRuntimeEnv();
  return handlePlatformSmokePost(request, env);
}

export async function GET(request: Request): Promise<Response> {
  const env = await resolveRuntimeEnv();
  return handlePlatformSmokeGet(request, env);
}
