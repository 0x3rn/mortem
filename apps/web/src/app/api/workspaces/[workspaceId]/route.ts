import { PlatformBindingError, WorkspaceAccessError } from "@mortem/core";
import { NextResponse } from "next/server";
import {
  requireAuthenticatedWorkspaceAccess,
  type WorkspaceSessionOverrides,
} from "@/lib/workspace-session";

export async function handleGetWorkspace(
  request: Request,
  workspaceId: string,
  overrides?: WorkspaceSessionOverrides,
): Promise<Response> {
  try {
    const { access } = await requireAuthenticatedWorkspaceAccess(
      request.headers,
      workspaceId,
      "viewer",
      {
        ...overrides,
        requestOrigin: overrides?.requestOrigin ?? new URL(request.url).origin,
      },
    );

    return NextResponse.json({
      ok: true,
      workspace: access,
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
      error instanceof Error ? error.message : "Failed to load workspace.";
    return NextResponse.json(
      { ok: false, code: "INTERNAL_ERROR", error: message },
      { status: 500 },
    );
  }
}

export async function handleUpdateWorkspace(
  request: Request,
  workspaceId: string,
  overrides?: WorkspaceSessionOverrides,
): Promise<Response> {
  try {
    const { access, d1 } = await requireAuthenticatedWorkspaceAccess(
      request.headers,
      workspaceId,
      "admin",
      {
        ...overrides,
        requestOrigin: overrides?.requestOrigin ?? new URL(request.url).origin,
      },
    );

    const body = (await request.json().catch(() => ({}))) as {
      name?: unknown;
    };
    const nextName = typeof body.name === "string" ? body.name.trim() : "";
    if (!nextName || nextName.length > 80) {
      return NextResponse.json(
        {
          ok: false,
          code: "INVALID_WORKSPACE_NAME",
          error: "Workspace name must be between 1 and 80 characters.",
        },
        { status: 400 },
      );
    }

    const nowMs = Date.now();
    await d1
      .prepare(
        `UPDATE workspaces
         SET name = ?1, updated_at = ?2
         WHERE id = ?3`,
      )
      .bind(nextName, nowMs, access.workspaceId)
      .run();

    return NextResponse.json({
      ok: true,
      workspace: {
        ...access,
        workspaceName: nextName,
      },
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
      error instanceof Error ? error.message : "Failed to update workspace.";
    return NextResponse.json(
      { ok: false, code: "INTERNAL_ERROR", error: message },
      { status: 500 },
    );
  }
}

export async function GET(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<Response> {
  const { workspaceId } = await context.params;
  return handleGetWorkspace(request, workspaceId);
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<Response> {
  const { workspaceId } = await context.params;
  return handleUpdateWorkspace(request, workspaceId);
}
