import {
  PlatformBindingError,
  WorkspaceAccessError,
  redeemWorkspaceClaimToken,
} from "@mortem/core";
import { NextResponse } from "next/server";
import {
  requireAuthenticatedWorkspaceAccess,
  type WorkspaceSessionOverrides,
} from "@/lib/workspace-session";

export async function handleClaimWorkspaceResource(
  request: Request,
  workspaceId: string,
  overrides?: WorkspaceSessionOverrides,
): Promise<Response> {
  try {
    const { session, d1 } = await requireAuthenticatedWorkspaceAccess(
      request.headers,
      workspaceId,
      "member",
      {
        ...overrides,
        requestOrigin: overrides?.requestOrigin ?? new URL(request.url).origin,
      },
    );

    const body = (await request.json().catch(() => ({}))) as {
      token?: unknown;
    };
    const rawToken = typeof body.token === "string" ? body.token.trim() : "";

    const redeemed = await redeemWorkspaceClaimToken(d1, {
      rawToken,
      userId: session.user.id,
      workspaceId,
    });

    return NextResponse.json({
      ok: true,
      claim: redeemed,
    });
  } catch (error) {
    if (error instanceof WorkspaceAccessError) {
      return NextResponse.json(
        { ok: false, code: error.code, error: error.message },
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
    const message =
      error instanceof Error ? error.message : "Failed to redeem claim token.";
    return NextResponse.json(
      { ok: false, code: "INTERNAL_ERROR", error: message },
      { status: 500 },
    );
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<Response> {
  const { workspaceId } = await context.params;
  return handleClaimWorkspaceResource(request, workspaceId);
}
