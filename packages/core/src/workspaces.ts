import type { D1DatabaseLike } from "./cloudflare";
import {
  CLAIMABLE_RESOURCE_TYPES,
  WORKSPACE_PLANS,
  WORKSPACE_ROLES,
  type ClaimableResourceType,
  type WorkspacePlan,
  type WorkspaceRole,
} from "./schema/auth";

export {
  CLAIMABLE_RESOURCE_TYPES,
  WORKSPACE_PLANS,
  WORKSPACE_ROLES,
  type ClaimableResourceType,
  type WorkspacePlan,
  type WorkspaceRole,
};

export const WORKSPACE_ROLE_RANK: Readonly<Record<WorkspaceRole, number>> = {
  viewer: 1,
  member: 2,
  admin: 3,
  owner: 4,
};

export type WorkspaceAccessErrorCode =
  | "UNAUTHENTICATED"
  | "WORKSPACE_NOT_FOUND"
  | "FORBIDDEN_NOT_A_MEMBER"
  | "FORBIDDEN_INSUFFICIENT_ROLE"
  | "CLAIM_TOKEN_INVALID"
  | "CLAIM_TOKEN_EXPIRED"
  | "CLAIM_TOKEN_ALREADY_CLAIMED";

export class WorkspaceAccessError extends Error {
  readonly code: WorkspaceAccessErrorCode;
  readonly status: number;

  constructor(code: WorkspaceAccessErrorCode, status: number, message: string) {
    super(message);
    this.name = "WorkspaceAccessError";
    this.code = code;
    this.status = status;
  }
}

export interface WorkspaceAccessContext {
  workspaceId: string;
  workspaceName: string;
  workspaceSlug: string;
  workspacePlan: WorkspacePlan;
  ownerUserId: string;
  userId: string;
  role: WorkspaceRole;
}

export interface ProvisionedWorkspaceResult {
  workspaceId: string;
  workspaceName: string;
  workspaceSlug: string;
  workspacePlan: WorkspacePlan;
  membershipId: string;
  role: "owner";
  created: boolean;
}

export interface IssueClaimTokenInput {
  resourceType: ClaimableResourceType;
  resourceId: string;
  purchaserEmail?: string | null;
  ttlMs?: number;
  nowMs?: number;
}

export interface IssuedClaimTokenResult {
  claimId: string;
  rawToken: string;
  tokenHash: string;
  resourceType: ClaimableResourceType;
  resourceId: string;
  expiresAtMs: number;
}

export interface RedeemClaimTokenInput {
  rawToken: string;
  userId: string;
  workspaceId: string;
  nowMs?: number;
}

export interface RedeemedClaimTokenResult {
  claimId: string;
  resourceType: ClaimableResourceType;
  resourceId: string;
  workspaceId: string;
  claimedByUserId: string;
  claimedAtMs: number;
}

export function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return (
    typeof value === "string" &&
    (WORKSPACE_ROLES as readonly string[]).includes(value)
  );
}

export function hasMinimumWorkspaceRole(
  actualRole: WorkspaceRole,
  minRole: WorkspaceRole,
): boolean {
  return WORKSPACE_ROLE_RANK[actualRole] >= WORKSPACE_ROLE_RANK[minRole];
}

export function buildWorkspaceSlug(
  nameOrEmail: string,
  suffix?: string,
): string {
  const localPart = nameOrEmail.split("@")[0] || "workspace";
  const base =
    localPart
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "workspace";
  const cleanSuffix = (suffix ?? crypto.randomUUID().slice(0, 8))
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 8);
  return `${base}-${cleanSuffix}`;
}

export function derivePersonalWorkspaceName(nameOrEmail: string): string {
  const trimmed = nameOrEmail.trim();
  if (!trimmed) {
    return "Personal Workspace";
  }
  const label = trimmed.includes("@") ? trimmed.split("@")[0] : trimmed;
  return `${label}'s Workspace`;
}

interface ExistingWorkspaceRow {
  workspace_id: string;
  workspace_name: string;
  workspace_slug: string;
  workspace_plan: WorkspacePlan;
  membership_id: string;
}

export async function provisionPersonalWorkspace(
  db: D1DatabaseLike,
  user: { id: string; name?: string | null; email: string },
  options: { nowMs?: number } = {},
): Promise<ProvisionedWorkspaceResult> {
  const existing = await db
    .prepare(
      `SELECT
         w.id AS workspace_id,
         w.name AS workspace_name,
         w.slug AS workspace_slug,
         w.plan AS workspace_plan,
         wm.id AS membership_id
       FROM workspaces w
       INNER JOIN workspace_memberships wm
         ON wm.workspace_id = w.id AND wm.user_id = w.owner_user_id
       WHERE w.owner_user_id = ?1
       LIMIT 1`,
    )
    .bind(user.id)
    .first<ExistingWorkspaceRow>();

  if (existing) {
    return {
      workspaceId: existing.workspace_id,
      workspaceName: existing.workspace_name,
      workspaceSlug: existing.workspace_slug,
      workspacePlan: existing.workspace_plan,
      membershipId: existing.membership_id,
      role: "owner",
      created: false,
    };
  }

  const nowMs = options.nowMs ?? Date.now();
  const workspaceId = `ws_${crypto.randomUUID().replace(/-/g, "")}`;
  const membershipId = `wm_${crypto.randomUUID().replace(/-/g, "")}`;
  const workspaceName = derivePersonalWorkspaceName(user.name || user.email);
  const workspaceSlug = buildWorkspaceSlug(
    user.name || user.email,
    workspaceId.slice(-8),
  );

  const insertWorkspace = db
    .prepare(
      `INSERT INTO workspaces (id, name, slug, owner_user_id, plan, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 'free', ?5, ?5)`,
    )
    .bind(workspaceId, workspaceName, workspaceSlug, user.id, nowMs);

  const insertMembership = db
    .prepare(
      `INSERT INTO workspace_memberships (id, workspace_id, user_id, role, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'owner', ?4, ?4)`,
    )
    .bind(membershipId, workspaceId, user.id, nowMs);

  const updateUserDefaultWorkspace = db
    .prepare(
      `UPDATE users
       SET default_workspace_id = COALESCE(default_workspace_id, ?1),
           updated_at = ?2
       WHERE id = ?3`,
    )
    .bind(workspaceId, nowMs, user.id);

  const updateActiveSessionWorkspace = db
    .prepare(
      `UPDATE sessions
       SET active_workspace_id = COALESCE(active_workspace_id, ?1),
           updated_at = ?2
       WHERE user_id = ?3`,
    )
    .bind(workspaceId, nowMs, user.id);

  if (typeof db.batch === "function") {
    await db.batch([
      insertWorkspace,
      insertMembership,
      updateUserDefaultWorkspace,
      updateActiveSessionWorkspace,
    ]);
  } else {
    await insertWorkspace.run();
    await insertMembership.run();
    await updateUserDefaultWorkspace.run();
    await updateActiveSessionWorkspace.run();
  }

  return {
    workspaceId,
    workspaceName,
    workspaceSlug,
    workspacePlan: "free",
    membershipId,
    role: "owner",
    created: true,
  };
}

interface WorkspaceMembershipJoinRow {
  workspace_id: string;
  workspace_name: string;
  workspace_slug: string;
  workspace_plan: WorkspacePlan;
  owner_user_id: string;
  user_id: string;
  role: WorkspaceRole;
}

export async function requireWorkspaceAccess(
  db: D1DatabaseLike,
  userId: string | null | undefined,
  workspaceId: string | null | undefined,
  minRole: WorkspaceRole = "viewer",
): Promise<WorkspaceAccessContext> {
  if (!userId || !userId.trim()) {
    throw new WorkspaceAccessError(
      "UNAUTHENTICATED",
      401,
      "Authentication is required to access workspace resources.",
    );
  }
  if (!workspaceId || !workspaceId.trim()) {
    throw new WorkspaceAccessError(
      "WORKSPACE_NOT_FOUND",
      404,
      "A valid workspace ID is required.",
    );
  }

  const row = await db
    .prepare(
      `SELECT
         w.id AS workspace_id,
         w.name AS workspace_name,
         w.slug AS workspace_slug,
         w.plan AS workspace_plan,
         w.owner_user_id AS owner_user_id,
         wm.user_id AS user_id,
         wm.role AS role
       FROM workspace_memberships wm
       INNER JOIN workspaces w ON w.id = wm.workspace_id
       WHERE wm.workspace_id = ?1 AND wm.user_id = ?2
       LIMIT 1`,
    )
    .bind(workspaceId, userId)
    .first<WorkspaceMembershipJoinRow>();

  if (!row) {
    throw new WorkspaceAccessError(
      "FORBIDDEN_NOT_A_MEMBER",
      403,
      "Access denied: user does not belong to the requested workspace.",
    );
  }

  if (!hasMinimumWorkspaceRole(row.role, minRole)) {
    throw new WorkspaceAccessError(
      "FORBIDDEN_INSUFFICIENT_ROLE",
      403,
      `Access denied: workspace role '${row.role}' does not meet required role '${minRole}'.`,
    );
  }

  return {
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    workspaceSlug: row.workspace_slug,
    workspacePlan: row.workspace_plan,
    ownerUserId: row.owner_user_id,
    userId: row.user_id,
    role: row.role,
  };
}

export async function listUserWorkspaces(
  db: D1DatabaseLike,
  userId: string,
): Promise<WorkspaceAccessContext[]> {
  if (!userId || !userId.trim()) {
    return [];
  }

  const stmt = db
    .prepare(
      `SELECT
         w.id AS workspace_id,
         w.name AS workspace_name,
         w.slug AS workspace_slug,
         w.plan AS workspace_plan,
         w.owner_user_id AS owner_user_id,
         wm.user_id AS user_id,
         wm.role AS role
       FROM workspace_memberships wm
       INNER JOIN workspaces w ON w.id = wm.workspace_id
       WHERE wm.user_id = ?1
       ORDER BY wm.created_at ASC`,
    )
    .bind(userId);

  if (typeof stmt.all === "function") {
    const result = await stmt.all<WorkspaceMembershipJoinRow>();
    return (result.results ?? []).map((row) => ({
      workspaceId: row.workspace_id,
      workspaceName: row.workspace_name,
      workspaceSlug: row.workspace_slug,
      workspacePlan: row.workspace_plan,
      ownerUserId: row.owner_user_id,
      userId: row.user_id,
      role: row.role,
    }));
  }

  const first = await stmt.first<WorkspaceMembershipJoinRow>();
  if (!first) {
    return [];
  }
  return [
    {
      workspaceId: first.workspace_id,
      workspaceName: first.workspace_name,
      workspaceSlug: first.workspace_slug,
      workspacePlan: first.workspace_plan,
      ownerUserId: first.owner_user_id,
      userId: first.user_id,
      role: first.role,
    },
  ];
}

export async function hashClaimToken(rawToken: string): Promise<string> {
  const bytes = new TextEncoder().encode(rawToken.trim());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const DEFAULT_CLAIM_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export async function issueWorkspaceClaimToken(
  db: D1DatabaseLike,
  input: IssueClaimTokenInput,
): Promise<IssuedClaimTokenResult> {
  const nowMs = input.nowMs ?? Date.now();
  const expiresAtMs = nowMs + (input.ttlMs ?? DEFAULT_CLAIM_TTL_MS);
  const claimId = `clm_${crypto.randomUUID().replace(/-/g, "")}`;
  const randomBytes = new Uint8Array(24);
  crypto.getRandomValues(randomBytes);
  const randomHex = Array.from(randomBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const rawToken = `mrtm_claim_${randomHex}`;
  const tokenHash = await hashClaimToken(rawToken);

  await db
    .prepare(
      `INSERT INTO workspace_claim_tokens
         (id, token_hash, resource_type, resource_id, purchaser_email, expires_at, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
    .bind(
      claimId,
      tokenHash,
      input.resourceType,
      input.resourceId,
      input.purchaserEmail ?? null,
      expiresAtMs,
      nowMs,
    )
    .run();

  return {
    claimId,
    rawToken,
    tokenHash,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    expiresAtMs,
  };
}

interface ClaimTokenRow {
  id: string;
  token_hash: string;
  resource_type: ClaimableResourceType;
  resource_id: string;
  claimed_by_workspace_id: string | null;
  claimed_by_user_id: string | null;
  expires_at: number;
  claimed_at: number | null;
}

export async function redeemWorkspaceClaimToken(
  db: D1DatabaseLike,
  input: RedeemClaimTokenInput,
): Promise<RedeemedClaimTokenResult> {
  // Enforce that the user has at least 'member' access to the target workspace before claiming
  await requireWorkspaceAccess(db, input.userId, input.workspaceId, "member");

  if (!input.rawToken || !input.rawToken.trim().startsWith("mrtm_claim_")) {
    throw new WorkspaceAccessError(
      "CLAIM_TOKEN_INVALID",
      400,
      "Invalid claim token format.",
    );
  }

  const nowMs = input.nowMs ?? Date.now();
  const tokenHash = await hashClaimToken(input.rawToken);

  const row = await db
    .prepare(
      `SELECT
         id,
         token_hash,
         resource_type,
         resource_id,
         claimed_by_workspace_id,
         claimed_by_user_id,
         expires_at,
         claimed_at
       FROM workspace_claim_tokens
       WHERE token_hash = ?1
       LIMIT 1`,
    )
    .bind(tokenHash)
    .first<ClaimTokenRow>();

  if (!row) {
    throw new WorkspaceAccessError(
      "CLAIM_TOKEN_INVALID",
      400,
      "Claim token was not found.",
    );
  }

  if (row.claimed_by_workspace_id || row.claimed_at !== null) {
    throw new WorkspaceAccessError(
      "CLAIM_TOKEN_ALREADY_CLAIMED",
      409,
      "This claim token has already been redeemed.",
    );
  }

  if (Number(row.expires_at) <= nowMs) {
    throw new WorkspaceAccessError(
      "CLAIM_TOKEN_EXPIRED",
      410,
      "This claim token has expired.",
    );
  }

  await db
    .prepare(
      `UPDATE workspace_claim_tokens
       SET claimed_by_workspace_id = ?1,
           claimed_by_user_id = ?2,
           claimed_at = ?3
       WHERE id = ?4 AND claimed_at IS NULL`,
    )
    .bind(input.workspaceId, input.userId, nowMs, row.id)
    .run();

  return {
    claimId: row.id,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    workspaceId: input.workspaceId,
    claimedByUserId: input.userId,
    claimedAtMs: nowMs,
  };
}
