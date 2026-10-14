import {
  WorkspaceAccessError,
  listUserWorkspaces,
  provisionPersonalWorkspace,
  requireWorkspaceAccess,
  type D1DatabaseLike,
  type MortemWebBindings,
  type WorkspaceAccessContext,
  type WorkspaceRole,
} from "@mortem/core";
import { createMortemAuth, resolveWebD1AndEnv } from "./auth";

export interface AuthenticatedUserSummary {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image?: string | null;
  defaultWorkspaceId?: string | null;
}

export interface AuthenticatedWorkspaceSession {
  user: AuthenticatedUserSummary;
  session: {
    id: string;
    token: string;
    expiresAt: string;
    activeWorkspaceId: string;
  };
  activeWorkspace: WorkspaceAccessContext;
  workspaces: WorkspaceAccessContext[];
}

export interface WorkspaceSessionOverrides {
  d1?: D1DatabaseLike;
  env?: Partial<MortemWebBindings>;
  requestOrigin?: string;
}

async function resolveContext(overrides?: WorkspaceSessionOverrides): Promise<{
  d1: D1DatabaseLike;
  env: Partial<MortemWebBindings>;
}> {
  if (overrides?.d1) {
    return { d1: overrides.d1, env: overrides.env ?? {} };
  }
  return resolveWebD1AndEnv();
}

export async function getAuthenticatedWorkspaceSession(
  requestHeaders: Headers,
  overrides?: WorkspaceSessionOverrides,
): Promise<AuthenticatedWorkspaceSession | null> {
  const { d1, env } = await resolveContext(overrides);
  const auth = createMortemAuth({
    d1,
    env,
    requestOrigin: overrides?.requestOrigin,
  });

  const authSession = await auth.api.getSession({
    headers: requestHeaders,
  });

  if (!authSession?.user || !authSession?.session) {
    return null;
  }

  const expiresAtDate = new Date(authSession.session.expiresAt);
  if (
    Number.isNaN(expiresAtDate.getTime()) ||
    expiresAtDate.getTime() <= Date.now()
  ) {
    return null;
  }

  await provisionPersonalWorkspace(d1, {
    id: authSession.user.id,
    name: authSession.user.name,
    email: authSession.user.email,
  });

  const workspaces = await listUserWorkspaces(d1, authSession.user.id);
  const preferredId =
    (authSession.session as { activeWorkspaceId?: string | null })
      .activeWorkspaceId ??
    (authSession.user as { defaultWorkspaceId?: string | null })
      .defaultWorkspaceId ??
    workspaces[0]?.workspaceId;

  const activeWorkspace =
    workspaces.find((w) => w.workspaceId === preferredId) ?? workspaces[0];

  if (!activeWorkspace) {
    return null;
  }

  return {
    user: {
      id: authSession.user.id,
      name: authSession.user.name,
      email: authSession.user.email,
      emailVerified: Boolean(authSession.user.emailVerified),
      image: authSession.user.image ?? null,
      defaultWorkspaceId: activeWorkspace.workspaceId,
    },
    session: {
      id: authSession.session.id,
      token: authSession.session.token,
      expiresAt: expiresAtDate.toISOString(),
      activeWorkspaceId: activeWorkspace.workspaceId,
    },
    activeWorkspace,
    workspaces,
  };
}

export async function requireAuthenticatedWorkspaceAccess(
  requestHeaders: Headers,
  workspaceId: string | null | undefined,
  minRole: WorkspaceRole = "viewer",
  overrides?: WorkspaceSessionOverrides,
): Promise<{
  session: AuthenticatedWorkspaceSession;
  access: WorkspaceAccessContext;
  d1: D1DatabaseLike;
}> {
  const { d1, env } = await resolveContext(overrides);
  const session = await getAuthenticatedWorkspaceSession(requestHeaders, {
    d1,
    env,
    requestOrigin: overrides?.requestOrigin,
  });

  if (!session) {
    throw new WorkspaceAccessError(
      "UNAUTHENTICATED",
      401,
      "Authentication is required to access workspace resources.",
    );
  }

  const access = await requireWorkspaceAccess(
    d1,
    session.user.id,
    workspaceId,
    minRole,
  );

  return { session, access, d1 };
}
