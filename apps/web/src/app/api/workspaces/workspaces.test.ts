import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  issueWorkspaceClaimToken,
  type D1BoundStatementLike,
  type D1DatabaseLike,
  type D1ExecResultLike,
} from "@mortem/core";
import { describe, expect, it } from "vitest";
import { createMortemAuth, type PasswordResetNotice } from "@/lib/auth";
import { handleClaimWorkspaceResource } from "./[workspaceId]/claim/route";
import {
  handleGetWorkspace,
  handleUpdateWorkspace,
} from "./[workspaceId]/route";
import { handleListWorkspaces } from "./route";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migration0001Sql = fs.readFileSync(
  path.resolve(
    __dirname,
    "../../../../../../packages/core/migrations/0001_auth_and_workspaces.sql",
  ),
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

function extractCookieHeader(response: Response): string {
  const setCookieHeaders =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie") ?? ""].filter(Boolean);

  return setCookieHeaders
    .map((header) => header.split(";")[0]?.trim())
    .filter(Boolean)
    .join("; ");
}

describe("Better Auth + D1 workspace route handlers & isolation (THE-171)", () => {
  it("signs up users, automatically creates personal workspaces, and enforces strict cross-workspace isolation", async () => {
    const d1 = createSqliteD1Adapter();
    const auth = createMortemAuth({
      d1,
      requestOrigin: "http://localhost:3000",
    });

    // 1. Sign up User A (Ada)
    const adaSignUpRes = await auth.handler(
      new Request("http://localhost:3000/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Ada Lovelace",
          email: "ada@acme.io",
          password: "correct-horse-battery-staple",
        }),
      }),
    );
    expect(adaSignUpRes.status).toBe(200);
    const adaCookie = extractCookieHeader(adaSignUpRes);
    expect(adaCookie).toContain("better-auth.session_token=");

    // 2. Verify Ada has an active personal workspace with role 'owner'
    const adaWorkspacesRes = await handleListWorkspaces(
      new Request("http://localhost:3000/api/workspaces", {
        headers: { cookie: adaCookie },
      }),
      { d1 },
    );
    expect(adaWorkspacesRes.status).toBe(200);
    const adaBody = (await adaWorkspacesRes.json()) as {
      ok: boolean;
      user: { id: string; email: string };
      activeWorkspace: {
        workspaceId: string;
        workspaceName: string;
        role: string;
      };
      workspaces: Array<{ workspaceId: string; role: string }>;
    };
    expect(adaBody.ok).toBe(true);
    expect(adaBody.user.email).toBe("ada@acme.io");
    expect(adaBody.activeWorkspace.role).toBe("owner");
    expect(adaBody.activeWorkspace.workspaceName).toBe(
      "Ada Lovelace's Workspace",
    );
    expect(adaBody.workspaces).toHaveLength(1);
    const adaWorkspaceId = adaBody.activeWorkspace.workspaceId;

    // 3. Sign up User B (Grace)
    const graceSignUpRes = await auth.handler(
      new Request("http://localhost:3000/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Grace Hopper",
          email: "grace@hopper.dev",
          password: "compiler-admiral-secret",
        }),
      }),
    );
    expect(graceSignUpRes.status).toBe(200);
    const graceCookie = extractCookieHeader(graceSignUpRes);

    const graceWorkspacesRes = await handleListWorkspaces(
      new Request("http://localhost:3000/api/workspaces", {
        headers: { cookie: graceCookie },
      }),
      { d1 },
    );
    const graceBody = (await graceWorkspacesRes.json()) as {
      user: { id: string };
      activeWorkspace: { workspaceId: string };
    };
    const graceWorkspaceId = graceBody.activeWorkspace.workspaceId;
    expect(graceWorkspaceId).not.toBe(adaWorkspaceId);

    // 4. Grace CANNOT read Ada's workspace (403 FORBIDDEN_NOT_A_MEMBER)
    const crossReadRes = await handleGetWorkspace(
      new Request(`http://localhost:3000/api/workspaces/${adaWorkspaceId}`, {
        headers: { cookie: graceCookie },
      }),
      adaWorkspaceId,
      { d1 },
    );
    expect(crossReadRes.status).toBe(403);
    await expect(crossReadRes.json()).resolves.toMatchObject({
      ok: false,
      code: "FORBIDDEN_NOT_A_MEMBER",
    });

    // 5. Grace CANNOT mutate Ada's workspace (403 FORBIDDEN_NOT_A_MEMBER)
    const crossMutateRes = await handleUpdateWorkspace(
      new Request(`http://localhost:3000/api/workspaces/${adaWorkspaceId}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          cookie: graceCookie,
        },
        body: JSON.stringify({ name: "Hijacked Workspace" }),
      }),
      adaWorkspaceId,
      { d1 },
    );
    expect(crossMutateRes.status).toBe(403);

    // 6. Add Grace as a 'viewer' to Ada's workspace: Grace can now GET (200) but still CANNOT PATCH (403 FORBIDDEN_INSUFFICIENT_ROLE)
    await d1
      .prepare(
        `INSERT INTO workspace_memberships (id, workspace_id, user_id, role, created_at, updated_at)
         VALUES ('wm_grace_viewer', ?1, ?2, 'viewer', ?3, ?3)`,
      )
      .bind(adaWorkspaceId, graceBody.user.id, Date.now())
      .run();

    const viewerReadRes = await handleGetWorkspace(
      new Request(`http://localhost:3000/api/workspaces/${adaWorkspaceId}`, {
        headers: { cookie: graceCookie },
      }),
      adaWorkspaceId,
      { d1 },
    );
    expect(viewerReadRes.status).toBe(200);

    const viewerMutateRes = await handleUpdateWorkspace(
      new Request(`http://localhost:3000/api/workspaces/${adaWorkspaceId}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          cookie: graceCookie,
        },
        body: JSON.stringify({ name: "Viewer Rename Attempt" }),
      }),
      adaWorkspaceId,
      { d1 },
    );
    expect(viewerMutateRes.status).toBe(403);
    await expect(viewerMutateRes.json()).resolves.toMatchObject({
      ok: false,
      code: "FORBIDDEN_INSUFFICIENT_ROLE",
    });

    // 7. Ada ('owner') can rename her workspace (200 OK)
    const ownerMutateRes = await handleUpdateWorkspace(
      new Request(`http://localhost:3000/api/workspaces/${adaWorkspaceId}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          cookie: adaCookie,
        },
        body: JSON.stringify({ name: "Acme Forensic Lab" }),
      }),
      adaWorkspaceId,
      { d1 },
    );
    expect(ownerMutateRes.status).toBe(200);
    await expect(ownerMutateRes.json()).resolves.toMatchObject({
      ok: true,
      workspace: {
        workspaceId: adaWorkspaceId,
        workspaceName: "Acme Forensic Lab",
      },
    });
  });

  it("supports password reset, session expiry, sign-out, and claim token redemption on Workers", async () => {
    const d1 = createSqliteD1Adapter();
    let capturedReset: PasswordResetNotice | null = null;
    const auth = createMortemAuth({
      d1,
      requestOrigin: "http://localhost:3000",
      onPasswordResetIssued: (notice) => {
        capturedReset = notice;
      },
    });

    // 1. Sign up user
    const signUpRes = await auth.handler(
      new Request("http://localhost:3000/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Alan Turing",
          email: "alan@bletchley.uk",
          password: "enigma-initial-password",
        }),
      }),
    );
    expect(signUpRes.status).toBe(200);
    const initialCookie = extractCookieHeader(signUpRes);

    const wsRes = await handleListWorkspaces(
      new Request("http://localhost:3000/api/workspaces", {
        headers: { cookie: initialCookie },
      }),
      { d1 },
    );
    const wsData = (await wsRes.json()) as {
      activeWorkspace: { workspaceId: string };
    };
    const workspaceId = wsData.activeWorkspace.workspaceId;

    // 2. Redeem an anonymous single-report buyer claim token via POST /api/workspaces/[workspaceId]/claim
    const claimIssued = await issueWorkspaceClaimToken(d1, {
      resourceType: "report",
      resourceId: "rep_checkout_42",
      purchaserEmail: "alan@bletchley.uk",
    });

    const claimRes = await handleClaimWorkspaceResource(
      new Request(`http://localhost:3000/api/workspaces/${workspaceId}/claim`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: initialCookie,
        },
        body: JSON.stringify({ token: claimIssued.rawToken }),
      }),
      workspaceId,
      { d1 },
    );
    expect(claimRes.status).toBe(200);
    await expect(claimRes.json()).resolves.toMatchObject({
      ok: true,
      claim: {
        resourceType: "report",
        resourceId: "rep_checkout_42",
        workspaceId,
      },
    });

    // 3. Request password reset & complete password reset
    const resetReqRes = await auth.handler(
      new Request("http://localhost:3000/api/auth/request-password-reset", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "alan@bletchley.uk",
          redirectTo: "http://localhost:3000/sign-in",
        }),
      }),
    );
    expect(resetReqRes.status).toBe(200);
    expect(capturedReset).not.toBeNull();

    const resetToken = (capturedReset as unknown as PasswordResetNotice).token;
    const resetCompleteRes = await auth.handler(
      new Request("http://localhost:3000/api/auth/reset-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          newPassword: "bombe-updated-password-99",
          token: resetToken,
        }),
      }),
    );
    expect(resetCompleteRes.status).toBe(200);

    // 4. Sign out invalidates the session in D1
    const signOutRes = await auth.handler(
      new Request("http://localhost:3000/api/auth/sign-out", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: initialCookie,
        },
        body: JSON.stringify({}),
      }),
    );
    expect(signOutRes.status).toBe(200);

    const afterSignOutRes = await handleListWorkspaces(
      new Request("http://localhost:3000/api/workspaces", {
        headers: { cookie: initialCookie },
      }),
      { d1 },
    );
    expect(afterSignOutRes.status).toBe(401);

    // 5. Sign in with new password succeeds, then expiring the session in D1 rejects subsequent requests
    const signInRes = await auth.handler(
      new Request("http://localhost:3000/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "alan@bletchley.uk",
          password: "bombe-updated-password-99",
        }),
      }),
    );
    expect(signInRes.status).toBe(200);
    const newCookie = extractCookieHeader(signInRes);

    // Force-expire all sessions in D1
    await d1
      .prepare(`UPDATE sessions SET expires_at = ?1`)
      .bind(Date.now() - 60_000)
      .run();

    const expiredRes = await handleListWorkspaces(
      new Request("http://localhost:3000/api/workspaces", {
        headers: { cookie: newCookie },
      }),
      { d1 },
    );
    expect(expiredRes.status).toBe(401);
  });
});
