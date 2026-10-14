import {
  EvidenceAccessError,
  PlatformBindingError,
  WorkspaceAccessError,
  authorizeAndLoadEvidenceArtifact,
  requireWebBindings,
  type MortemWebBindings,
} from "@mortem/core";
import { NextResponse } from "next/server";
import { resolveAuthSecret, resolveWebD1AndEnv } from "@/lib/auth";
import { getAuthenticatedWorkspaceSession } from "@/lib/workspace-session";

export async function GET(
  request: Request,
  context: { params: Promise<{ artifactId: string }> },
): Promise<Response> {
  try {
    const { artifactId } = await context.params;
    const url = new URL(request.url);
    const signedToken = url.searchParams.get("token")?.trim() || null;
    const shareToken = url.searchParams.get("shareToken")?.trim() || null;

    const { d1, env } = await resolveWebD1AndEnv();
    const validated = requireWebBindings(env as MortemWebBindings);

    let userId: string | null = null;
    if (!signedToken && !shareToken) {
      const session = await getAuthenticatedWorkspaceSession(request.headers, {
        d1,
        env,
        requestOrigin: url.origin,
      }).catch(() => null);
      userId = session?.user.id ?? null;
    }

    const loaded = await authorizeAndLoadEvidenceArtifact({
      d1,
      r2: validated.EVIDENCE,
      artifactId,
      userId,
      shareToken,
      signedToken,
      signingSecret: resolveAuthSecret(env),
    });

    const ifNoneMatch = request.headers.get("if-none-match")?.trim();
    if (
      ifNoneMatch &&
      (ifNoneMatch === loaded.etag ||
        ifNoneMatch === loaded.artifact.sha256 ||
        ifNoneMatch === `W/${loaded.etag}`)
    ) {
      return new Response(null, {
        status: 304,
        headers: {
          "Cache-Control": loaded.cacheControl,
          ETag: loaded.etag,
        },
      });
    }

    const bodyInit =
      loaded.body instanceof Uint8Array
        ? (loaded.body as unknown as BodyInit)
        : (loaded.body as unknown as BodyInit);

    return new Response(bodyInit, {
      status: 200,
      headers: {
        "Content-Type": loaded.contentType,
        "Content-Length": String(loaded.byteSize),
        "Cache-Control": loaded.cacheControl,
        ETag: loaded.etag,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy":
          "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
      },
    });
  } catch (error) {
    if (error instanceof EvidenceAccessError) {
      return NextResponse.json(
        {
          ok: false,
          code: error.code,
          error: error.message,
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
        { status: error.status === 401 ? 403 : error.status },
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
            : "Unable to stream evidence artifact.",
      },
      { status: 500 },
    );
  }
}
