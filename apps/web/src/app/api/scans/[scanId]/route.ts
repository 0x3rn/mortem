import {
  PlatformBindingError,
  WorkspaceAccessError,
  getWorkspaceScanDetail,
} from "@mortem/core";
import { NextResponse } from "next/server";
import {
  getAuthenticatedWorkspaceSession,
  requireAuthenticatedWorkspaceAccess,
} from "@/lib/workspace-session";

export async function GET(
  request: Request,
  context: { params: Promise<{ scanId: string }> },
) {
  try {
    const { scanId } = await context.params;
    const url = new URL(request.url);
    const requestedWorkspaceId = url.searchParams.get("workspaceId")?.trim();

    const session = await getAuthenticatedWorkspaceSession(request.headers);
    if (!session) {
      return NextResponse.json(
        {
          ok: false,
          code: "UNAUTHENTICATED",
          error: "Authentication is required to view scan details.",
        },
        { status: 401 },
      );
    }

    const { access, d1 } = await requireAuthenticatedWorkspaceAccess(
      request.headers,
      requestedWorkspaceId || session.activeWorkspace.workspaceId,
      "viewer",
    );

    const detail = await getWorkspaceScanDetail(
      d1,
      access.workspaceId,
      scanId.trim(),
    );

    if (!detail) {
      return NextResponse.json(
        {
          ok: false,
          code: "NOT_FOUND",
          error: "Scan not found in the active workspace.",
        },
        { status: 404 },
      );
    }

    return NextResponse.json(
      {
        ok: true,
        workspaceId: access.workspaceId,
        scanDetail: detail,
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
            : "Unable to load scan detail.",
      },
      { status: 500 },
    );
  }
}
