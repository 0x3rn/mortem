import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  WORKSPACE_ROLE_RANK,
  WorkspaceAccessError,
  buildWorkspaceSlug,
  hasMinimumWorkspaceRole,
  hashClaimToken,
  issueWorkspaceClaimToken,
  listUserWorkspaces,
  provisionPersonalWorkspace,
  redeemWorkspaceClaimToken,
  requireWorkspaceAccess,
  type D1BoundStatementLike,
  type D1DatabaseLike,
  type D1ExecResultLike,
} from "./index";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migration0001Sql = fs.readFileSync(
  path.resolve(__dirname, "../migrations/0001_auth_and_workspaces.sql"),
  "utf8",
);

function createSqliteD1Adapter(): D1DatabaseLike {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  sqlite.exec(migration0001Sql);

  function createBoundStatement(
    sqlText: string,
    boundValues: unknown[],
  ): D1BoundStatementLike & { raw(): Promise<unknown[][]> } {
    const normalizedParams = boundValues.map((v) =>
      v === undefined ? null : (v as SQLInputValue),
    );
    return {
      async run(): Promise<D1ExecResultLike> {
        const stmt = sqlite.prepare(sqlText);
        stmt.run(...normalizedParams);
        return { success: true };
      },
      async first<T = Record<string, unknown>>(): Promise<T | null> {
        const stmt = sqlite.prepare(sqlText);
        const row = stmt.get(...normalizedParams) as T | undefined;
        return row ?? null;
      },
      async all<T = Record<string, unknown>>(): Promise<D1ExecResultLike<T>> {
        const stmt = sqlite.prepare(sqlText);
        const rows = stmt.all(...normalizedParams) as T[];
        return { success: true, results: rows };
      },
      async raw(): Promise<unknown[][]> {
        const stmt = sqlite.prepare(sqlText);
        const rows = stmt.all(...normalizedParams) as Record<string, unknown>[];
        return rows.map((row) => Object.values(row));
      },
    };
  }

  return {
    prepare(query: string) {
      const base = createBoundStatement(query, []);
      return {
        ...base,
        bind(...values: unknown[]) {
          return createBoundStatement(query, values);
        },
      };
    },
    async batch(statements: D1BoundStatementLike[]) {
      const results: D1ExecResultLike[] = [];
      for (const statement of statements) {
        results.push(await statement.run());
      }
      return results;
    },
  };
}

async function seedUser(
  db: D1DatabaseLike,
  user: { id: string; name: string; email: string },
) {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO users (id, name, email, email_verified, created_at, updated_at)
       VALUES (?1, ?2, ?3, 1, ?4, ?4)`,
    )
    .bind(user.id, user.name, user.email, now)
    .run();
}

describe("workspace provisioning, server-side RBAC, and claim tokens (THE-171)", () => {
  it("enforces the ordered role hierarchy (viewer < member < admin < owner)", () => {
    expect(WORKSPACE_ROLE_RANK.viewer).toBeLessThan(WORKSPACE_ROLE_RANK.member);
    expect(WORKSPACE_ROLE_RANK.member).toBeLessThan(WORKSPACE_ROLE_RANK.admin);
    expect(WORKSPACE_ROLE_RANK.admin).toBeLessThan(WORKSPACE_ROLE_RANK.owner);

    expect(hasMinimumWorkspaceRole("owner", "admin")).toBe(true);
    expect(hasMinimumWorkspaceRole("admin", "member")).toBe(true);
    expect(hasMinimumWorkspaceRole("member", "viewer")).toBe(true);
    expect(hasMinimumWorkspaceRole("viewer", "member")).toBe(false);
    expect(hasMinimumWorkspaceRole("member", "admin")).toBe(false);
  });

  it("provisions a personal workspace with owner membership idempotently on first signup", async () => {
    const db = createSqliteD1Adapter();
    await seedUser(db, {
      id: "usr_ada",
      name: "Ada Lovelace",
      email: "ada@acme.io",
    });

    const first = await provisionPersonalWorkspace(db, {
      id: "usr_ada",
      name: "Ada Lovelace",
      email: "ada@acme.io",
    });
    expect(first.created).toBe(true);
    expect(first.role).toBe("owner");
    expect(first.workspacePlan).toBe("free");
    expect(first.workspaceName).toBe("Ada Lovelace's Workspace");
    expect(first.workspaceSlug).toContain("ada-lovelace-");

    // Calling provisionPersonalWorkspace again must be idempotent
    const second = await provisionPersonalWorkspace(db, {
      id: "usr_ada",
      name: "Ada Lovelace",
      email: "ada@acme.io",
    });
    expect(second.created).toBe(false);
    expect(second.workspaceId).toBe(first.workspaceId);

    const userWorkspaces = await listUserWorkspaces(db, "usr_ada");
    expect(userWorkspaces).toHaveLength(1);
    expect(userWorkspaces[0]?.workspaceId).toBe(first.workspaceId);
    expect(userWorkspaces[0]?.role).toBe("owner");
  });

  it("enforces strict workspace isolation so User A can never read or mutate User B's workspace", async () => {
    const db = createSqliteD1Adapter();
    await seedUser(db, {
      id: "usr_alice",
      name: "Alice",
      email: "alice@alpha.dev",
    });
    await seedUser(db, { id: "usr_bob", name: "Bob", email: "bob@beta.dev" });

    const aliceWs = await provisionPersonalWorkspace(db, {
      id: "usr_alice",
      name: "Alice",
      email: "alice@alpha.dev",
    });
    const bobWs = await provisionPersonalWorkspace(db, {
      id: "usr_bob",
      name: "Bob",
      email: "bob@beta.dev",
    });

    // Unauthenticated access fails with 401
    await expect(
      requireWorkspaceAccess(db, null, aliceWs.workspaceId, "viewer"),
    ).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
      status: 401,
    });

    // Alice can access her own workspace
    const aliceAccess = await requireWorkspaceAccess(
      db,
      "usr_alice",
      aliceWs.workspaceId,
      "owner",
    );
    expect(aliceAccess.workspaceId).toBe(aliceWs.workspaceId);
    expect(aliceAccess.role).toBe("owner");

    // Alice CANNOT read or mutate Bob's workspace (even at 'viewer' level)
    await expect(
      requireWorkspaceAccess(db, "usr_alice", bobWs.workspaceId, "viewer"),
    ).rejects.toMatchObject({
      code: "FORBIDDEN_NOT_A_MEMBER",
      status: 403,
    });

    // Add Bob as a 'viewer' to Alice's workspace
    await db
      .prepare(
        `INSERT INTO workspace_memberships (id, workspace_id, user_id, role, created_at, updated_at)
         VALUES ('wm_bob_viewer', ?1, 'usr_bob', 'viewer', ?2, ?2)`,
      )
      .bind(aliceWs.workspaceId, Date.now())
      .run();

    // Bob can now view Alice's workspace
    const bobViewerAccess = await requireWorkspaceAccess(
      db,
      "usr_bob",
      aliceWs.workspaceId,
      "viewer",
    );
    expect(bobViewerAccess.role).toBe("viewer");

    // Bob still CANNOT perform 'member', 'admin', or 'owner' actions on Alice's workspace
    await expect(
      requireWorkspaceAccess(db, "usr_bob", aliceWs.workspaceId, "member"),
    ).rejects.toMatchObject({
      code: "FORBIDDEN_INSUFFICIENT_ROLE",
      status: 403,
    });
  });

  it("issues hashed claim tokens and enforces single-use, non-expired, workspace-authorized redemption", async () => {
    const db = createSqliteD1Adapter();
    await seedUser(db, {
      id: "usr_buyer",
      name: "Buyer",
      email: "buyer@acme.io",
    });
    await seedUser(db, {
      id: "usr_outsider",
      name: "Outsider",
      email: "outsider@other.io",
    });

    const buyerWs = await provisionPersonalWorkspace(db, {
      id: "usr_buyer",
      name: "Buyer",
      email: "buyer@acme.io",
    });

    const issued = await issueWorkspaceClaimToken(db, {
      resourceType: "report",
      resourceId: "rep_single_001",
      purchaserEmail: "buyer@acme.io",
      nowMs: 1_000_000,
      ttlMs: 60_000,
    });

    expect(issued.rawToken.startsWith("mrtm_claim_")).toBe(true);
    expect(issued.tokenHash).toBe(await hashClaimToken(issued.rawToken));
    expect(issued.tokenHash).not.toBe(issued.rawToken);

    // Outsider cannot redeem the token into buyer's workspace
    await expect(
      redeemWorkspaceClaimToken(db, {
        rawToken: issued.rawToken,
        userId: "usr_outsider",
        workspaceId: buyerWs.workspaceId,
        nowMs: 1_010_000,
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN_NOT_A_MEMBER",
      status: 403,
    });

    // Expired redemption attempt fails with 410
    await expect(
      redeemWorkspaceClaimToken(db, {
        rawToken: issued.rawToken,
        userId: "usr_buyer",
        workspaceId: buyerWs.workspaceId,
        nowMs: 2_000_000,
      }),
    ).rejects.toMatchObject({
      code: "CLAIM_TOKEN_EXPIRED",
      status: 410,
    });

    // Valid redemption before expiry succeeds
    const redeemed = await redeemWorkspaceClaimToken(db, {
      rawToken: issued.rawToken,
      userId: "usr_buyer",
      workspaceId: buyerWs.workspaceId,
      nowMs: 1_020_000,
    });
    expect(redeemed.resourceType).toBe("report");
    expect(redeemed.resourceId).toBe("rep_single_001");
    expect(redeemed.workspaceId).toBe(buyerWs.workspaceId);

    // Second redemption attempt fails with 409
    await expect(
      redeemWorkspaceClaimToken(db, {
        rawToken: issued.rawToken,
        userId: "usr_buyer",
        workspaceId: buyerWs.workspaceId,
        nowMs: 1_025_000,
      }),
    ).rejects.toThrowError(WorkspaceAccessError);

    expect(buildWorkspaceSlug("Ada Lovelace", "12345678")).toBe(
      "ada-lovelace-12345678",
    );
  });
});
