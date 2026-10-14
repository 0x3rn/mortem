import { PlatformBindingError, WorkspaceAccessError } from "@mortem/core";
import { NextResponse } from "next/server";
import {
  getAuthenticatedWorkspaceSession,
  type WorkspaceSessionOverrides,
} from "@/lib/workspace-session";

export async function handleListWorkspaces(
  request: Request,
  overrides?: WorkspaceSessionOverrides,
): Promise<Response> {
  try {
    const session = await getAuthenticatedWorkspaceSession(request.headers, {
      ...overrides,
      requestOrigin: overrides?.requestOrigin ?? new URL(request.url).origin,
    });

    if (!session) {
      return NextResponse.json(
        {
          ok: false,
          code: "UNAUTHENTICATED",
          error: "Authentication is required.",
        },
        { status: 401 },
      );
    }

    return NextResponse.json({
      ok: true,
      user: session.user,
      activeWorkspace: session.activeWorkspace,
      workspaces: session.workspaces,
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
      error instanceof Error ? error.message : "Failed to load workspaces.";
    return NextResponse.json(
      { ok: false, code: "INTERNAL_ERROR", error: message },
      { status: 500 },
    );
  }
}

export async function GET(request: Request): Promise<Response> {
  return handleListWorkspaces(request);
}
