import {
  PlatformBindingError,
  ScanIntakeError,
  WorkspaceAccessError,
  listWorkspaceScans,
  requireWebBindings,
  requireWorkspaceAccess,
  submitScanIntake,
  type DohResolverFn,
  type MortemWebBindings,
  type ScanIntakeRateLimitConfig,
  type ScanOptionsJson,
  type TurnstileVerifierFn,
} from "@mortem/core";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextResponse } from "next/server";
import {
  getAuthenticatedWorkspaceSession,
  requireAuthenticatedWorkspaceAccess,
} from "@/lib/workspace-session";

const ANONYMOUS_PREVIEW_USER_ID = "usr_anonymous_preview";
const ANONYMOUS_PREVIEW_WORKSPACE_ID = "ws_anonymous_preview";

export interface ScansRouteOverrides {
  dohResolver?: DohResolverFn;
  fetchFn?: typeof fetch;
  turnstileVerifier?: TurnstileVerifierFn;
  rateLimitConfig?: ScanIntakeRateLimitConfig;
}

let testOverrides: ScansRouteOverrides = {};

export function setScansRouteTestOverrides(overrides: ScansRouteOverrides) {
  testOverrides = overrides;
}

async function ensureAnonymousPreviewWorkspace(
  d1: ReturnType<typeof requireWebBindings>["DB"],
): Promise<string> {
  const now = Date.now();
  await d1
    .prepare(
      `INSERT OR IGNORE INTO users (
        id, name, email, email_verified, default_workspace_id, created_at, updated_at
      ) VALUES (?, 'Anonymous Preview', 'preview@mortem.internal', 1, ?, ?, ?)`,
    )
    .bind(ANONYMOUS_PREVIEW_USER_ID, ANONYMOUS_PREVIEW_WORKSPACE_ID, now, now)
    .run();

  await d1
    .prepare(
      `INSERT OR IGNORE INTO workspaces (
        id, name, slug, owner_user_id, plan, created_at, updated_at
      ) VALUES (?, 'Anonymous Preview Workspace', 'anonymous-preview', ?, 'free', ?, ?)`,
    )
    .bind(ANONYMOUS_PREVIEW_WORKSPACE_ID, ANONYMOUS_PREVIEW_USER_ID, now, now)
    .run();

  await d1
    .prepare(
      `INSERT OR IGNORE INTO workspace_memberships (
        id, workspace_id, user_id, role, created_at, updated_at
      ) VALUES ('wsm_anonymous_preview', ?, ?, 'owner', ?, ?)`,
    )
    .bind(ANONYMOUS_PREVIEW_WORKSPACE_ID, ANONYMOUS_PREVIEW_USER_ID, now, now)
    .run();

  return ANONYMOUS_PREVIEW_WORKSPACE_ID;
}

function extractClientIp(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "127.0.0.1"
  );
}

export async function POST(request: Request) {
  try {
    const { env } = await getCloudflareContext({ async: true });
    const bindings = requireWebBindings(env as unknown as MortemWebBindings);

    const body = (await request.json().catch(() => null)) as {
      url?: string;
      workspaceId?: string;
      turnstileToken?: string;
      options?: ScanOptionsJson;
    } | null;

    const rawUrl = body?.url ?? "";
    const session = await getAuthenticatedWorkspaceSession(request.headers);

    let workspaceId: string;
    let isAnonymousPreview = false;

    if (session) {
      const requestedWorkspaceId =
        body?.workspaceId?.trim() || session.activeWorkspace.workspaceId;
      const access = await requireWorkspaceAccess(
        bindings.DB,
        session.user.id,
        requestedWorkspaceId,
        "member",
      );
      workspaceId = access.workspaceId;
    } else {
      isAnonymousPreview = true;
      workspaceId = await ensureAnonymousPreviewWorkspace(bindings.DB);
    }

    const turnstileSecretKey =
      bindings.TURNSTILE_SECRET_KEY ?? process.env.TURNSTILE_SECRET_KEY ?? "";

    const result = await submitScanIntake({
      d1: bindings.DB,
      scanQueue: bindings.SCAN_QUEUE,
      workspaceId,
      rawUrl,
      clientIp: extractClientIp(request),
      options: body?.options,
      isAnonymousPreview,
      turnstileToken: body?.turnstileToken,
      turnstileSecretKey,
      dohResolver: testOverrides.dohResolver,
      fetchFn: testOverrides.fetchFn,
      turnstileVerifier: testOverrides.turnstileVerifier,
      rateLimitConfig: testOverrides.rateLimitConfig,
    });

    return NextResponse.json(
      {
        ok: true,
        scan: result,
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof ScanIntakeError) {
      return NextResponse.json(
        {
          ok: false,
          code: error.code,
          error: error.message,
          details: error.details,
        },
        { status: error.status },
      );
    }
    if (error instanceof WorkspaceAccessError) {
      return NextResponse.json(
        {
          ok: false,
          code: error.code,
          error: error.message,
        },
        { status: error.status },
      );
    }
    if (error instanceof PlatformBindingError) {
      return NextResponse.json(
        {
          ok: false,
          code: error.code,
          binding: error.bindingName,
          error: error.message,
        },
        { status: 503 },
      );
    }
    return NextResponse.json(
      {
        ok: false,
        code: "INTERNAL_ERROR",
        error:
          error instanceof Error
            ? error.message
            : "Unexpected scan intake failure.",
      },
      { status: 500 },
    );
  }
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const requestedWorkspaceId = url.searchParams.get("workspaceId")?.trim();

    const session = await getAuthenticatedWorkspaceSession(request.headers);
    if (!session) {
      return NextResponse.json(
        {
          ok: false,
          code: "UNAUTHENTICATED",
          error: "Authentication is required to list workspace scans.",
        },
        { status: 401 },
      );
    }

    const { access, d1 } = await requireAuthenticatedWorkspaceAccess(
      request.headers,
      requestedWorkspaceId || session.activeWorkspace.workspaceId,
      "viewer",
    );

    const scans = await listWorkspaceScans(d1, access.workspaceId, 50);

    return NextResponse.json(
      {
        ok: true,
        workspaceId: access.workspaceId,
        scans,
      },
      { status: 200 },
    );
  } catch (error) {
    if (error instanceof WorkspaceAccessError) {
      return NextResponse.json(
        {
          ok: false,
          code: error.code,
          error: error.message,
        },
        { status: error.status },
      );
    }
    return NextResponse.json(
      {
        ok: false,
        code: "INTERNAL_ERROR",
        error:
          error instanceof Error
            ? error.message
            : "Unable to list workspace scans.",
      },
      { status: 500 },
    );
  }
}
