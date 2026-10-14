import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type {
  D1BoundStatementLike,
  D1DatabaseLike,
  D1ExecResultLike,
  MortemWebBindings,
} from "@mortem/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as authPost } from "../auth/[...all]/route";
import { GET as getScanDetail } from "./[scanId]/route";
import {
  GET as getScans,
  POST as postScans,
  setScansRouteTestOverrides,
} from "./route";

const MIGRATION_0001_SQL = readFileSync(
  join(
    __dirname,
    "../../../../../../packages/core/migrations/0001_auth_and_workspaces.sql",
  ),
  "utf8",
);
const MIGRATION_0002_SQL = readFileSync(
  join(
    __dirname,
    "../../../../../../packages/core/migrations/0002_scans_evidence_findings_reports.sql",
  ),
  "utf8",
);
const MIGRATION_0003_SQL = readFileSync(
  join(
    __dirname,
    "../../../../../../packages/core/migrations/0003_intake_rate_limits.sql",
  ),
  "utf8",
);

function createSqliteD1(): D1DatabaseLike {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  sqlite.exec(MIGRATION_0001_SQL);
  sqlite.exec(MIGRATION_0002_SQL);
  sqlite.exec(MIGRATION_0003_SQL);

  function createBound(
    query: string,
    params: unknown[],
  ): D1BoundStatementLike & { raw?: () => Promise<unknown[][]> } {
    const normalized = params.map((v) => {
      if (v === undefined) return null;
      if (typeof v === "boolean") return v ? 1 : 0;
      if (v instanceof Date) return v.getTime();
      return v as SQLInputValue;
    });
    return {
      async run(): Promise<D1ExecResultLike> {
        const stmt = sqlite.prepare(query);
        const isReader = /^\s*(SELECT|PRAGMA|WITH|EXPLAIN)\b/i.test(query);
        if (isReader) {
          const rows = stmt.all(...normalized) as Record<string, unknown>[];
          return { success: true, results: rows };
        }
        stmt.run(...normalized);
        return { success: true, results: [] };
      },
      async first<T = Record<string, unknown>>(
        col?: string,
      ): Promise<T | null> {
        const row = sqlite.prepare(query).get(...normalized) as
          Record<string, unknown> | undefined;
        if (!row) return null;
        if (col) return (row[col] as T) ?? null;
        return row as T;
      },
      async all<T = Record<string, unknown>>(): Promise<D1ExecResultLike<T>> {
        const stmt = sqlite.prepare(query);
        const isReader =
          /^\s*(SELECT|PRAGMA|WITH|EXPLAIN)\b/i.test(query) ||
          /\bRETURNING\b/i.test(query);
        if (isReader) {
          const rows = stmt.all(...normalized) as T[];
          return { success: true, results: rows };
        }
        stmt.run(...normalized);
        return { success: true, results: [] };
      },
      async raw(): Promise<unknown[][]> {
        const stmt = sqlite.prepare(query);
        const isReader =
          /^\s*(SELECT|PRAGMA|WITH|EXPLAIN)\b/i.test(query) ||
          /\bRETURNING\b/i.test(query);
        if (!isReader) {
          stmt.run(...normalized);
          return [];
        }
        const rows = stmt.all(...normalized) as Record<string, unknown>[];
        return rows.map((r) => Object.values(r));
      },
    };
  }

  return {
    prepare(query: string) {
      const def = createBound(query, []);
      return {
        ...def,
        bind(...values: unknown[]) {
          return createBound(query, values);
        },
      };
    },
    async batch(statements: D1BoundStatementLike[]) {
      const out: D1ExecResultLike[] = [];
      for (const s of statements) {
        out.push(await s.run());
      }
      return out;
    },
  };
}

let currentEnv: MortemWebBindings;
let queuedMessages: unknown[] = [];

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(async () => ({
    env: currentEnv,
  })),
}));

function extractCookieHeader(response: Response): string {
  const getSetCookie = (
    response.headers as unknown as { getSetCookie?: () => string[] }
  ).getSetCookie;
  const rawList =
    typeof getSetCookie === "function"
      ? getSetCookie.call(response.headers)
      : [response.headers.get("set-cookie") ?? ""];
  return rawList
    .flatMap((entry) => entry.split(/,(?=\s*[a-zA-Z0-9_-]+=)/))
    .map((part) => part.split(";")[0]?.trim())
    .filter(Boolean)
    .join("; ");
}

describe("POST /api/scans and GET /api/scans route handlers (THE-173)", () => {
  beforeEach(() => {
    queuedMessages = [];
    const d1 = createSqliteD1();
    currentEnv = {
      ENVIRONMENT: "test",
      BETTER_AUTH_SECRET: "test-secret-for-mortem-scans-route-32-chars",
      BETTER_AUTH_URL: "http://localhost:3000",
      DB: d1,
      EVIDENCE: { put: async () => null, head: async () => null },
      SCAN_QUEUE: {
        send: async (msg: unknown) => {
          queuedMessages.push(msg);
        },
      },
    };

    setScansRouteTestOverrides({
      dohResolver: async (hostname, type) => ({
        Status: 0,
        Answer:
          type === "A"
            ? [{ name: hostname, type: 1, data: "93.184.216.34" }]
            : [],
      }),
      fetchFn: async () => new Response(null, { status: 200 }),
    });
  });

  it("creates a queued scan in the authenticated user's workspace, enqueues onto SCAN_QUEUE, and lists it via GET /api/scans", async () => {
    const signUpRes = await authPost(
      new Request("http://localhost:3000/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Grace Hopper",
          email: "grace@mortem.dev",
          password: "grace-secure-password-123",
        }),
      }),
    );
    expect(signUpRes.status).toBe(200);
    const cookie = extractCookieHeader(signUpRes);

    const createRes = await postScans(
      new Request("http://localhost:3000/api/scans", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie,
          "cf-connecting-ip": "198.51.101.42",
        },
        body: JSON.stringify({
          url: "stripe.com/pricing?utm_source=google&gclid=123#plans",
        }),
      }),
    );

    expect(createRes.status).toBe(201);
    const createPayload = (await createRes.json()) as {
      ok: boolean;
      scan: {
        scanId: string;
        workspaceId: string;
        normalizedUrl: string;
        status: string;
      };
    };
    expect(createPayload.ok).toBe(true);
    expect(createPayload.scan.normalizedUrl).toBe("https://stripe.com/pricing");
    expect(createPayload.scan.status).toBe("queued");
    expect(queuedMessages).toHaveLength(1);
    expect(queuedMessages[0]).toMatchObject({
      scanId: createPayload.scan.scanId,
      targetUrl: "https://stripe.com/pricing",
    });

    const listRes = await getScans(
      new Request("http://localhost:3000/api/scans", {
        headers: { cookie },
      }),
    );
    expect(listRes.status).toBe(200);
    const listPayload = (await listRes.json()) as {
      ok: boolean;
      scans: { id: string; normalized_url: string; status: string }[];
    };
    expect(listPayload.scans).toHaveLength(1);
    expect(listPayload.scans[0]?.id).toBe(createPayload.scan.scanId);
  });

  it("rejects SSRF targets (localhost, private IPs, metadata IPs) with 422 ssrf_blocked and never enqueues", async () => {
    for (const ssrfUrl of [
      "http://localhost:3000",
      "http://127.0.0.1/admin",
      "http://169.254.169.254/latest/meta-data/",
      "http://192.168.1.1/",
      "http://[::1]/",
    ]) {
      const res = await postScans(
        new Request("http://localhost:3000/api/scans", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: ssrfUrl }),
        }),
      );
      expect(res.status).toBe(422);
      const body = (await res.json()) as { ok: boolean; code: string };
      expect(body.ok).toBe(false);
      expect(body.code).toBe("ssrf_blocked");
    }
    expect(queuedMessages).toHaveLength(0);
  });

  it("loads scan lifecycle detail via GET /api/scans/[scanId] and enforces cross-workspace isolation (THE-174)", async () => {
    const signUpAlice = await authPost(
      new Request("http://localhost:3000/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Alice Investigator",
          email: "alice@mortem.dev",
          password: "alice-secure-password-123",
        }),
      }),
    );
    const aliceCookie = extractCookieHeader(signUpAlice);

    const signUpBob = await authPost(
      new Request("http://localhost:3000/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Bob Rival",
          email: "bob@mortem.dev",
          password: "bob-secure-password-123",
        }),
      }),
    );
    const bobCookie = extractCookieHeader(signUpBob);

    const createRes = await postScans(
      new Request("http://localhost:3000/api/scans", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: aliceCookie,
        },
        body: JSON.stringify({ url: "https://example.com/pricing" }),
      }),
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      ok: boolean;
      scan: { scanId: string };
    };
    const scanId = created.scan.scanId;

    // Alice can view her scan detail and recorded queued stage event
    const aliceDetailRes = await getScanDetail(
      new Request(`http://localhost:3000/api/scans/${scanId}`, {
        headers: { cookie: aliceCookie },
      }),
      { params: Promise.resolve({ scanId }) },
    );
    expect(aliceDetailRes.status).toBe(200);
    const aliceDetailPayload = (await aliceDetailRes.json()) as {
      ok: boolean;
      scanDetail: {
        scan: {
          id: string;
          normalized_url: string;
          status: string;
          pages_discovered: number;
          pages_captured: number;
          overall_score: number | null;
        };
        events: { stage: string; message: string }[];
      };
    };
    expect(aliceDetailPayload.scanDetail.scan.id).toBe(scanId);
    expect(aliceDetailPayload.scanDetail.scan.normalized_url).toBe(
      "https://example.com/pricing",
    );
    expect(aliceDetailPayload.scanDetail.scan.status).toBe("queued");
    expect(aliceDetailPayload.scanDetail.scan.overall_score).toBeNull();
    expect(aliceDetailPayload.scanDetail.events).toHaveLength(1);
    expect(aliceDetailPayload.scanDetail.events[0]?.stage).toBe("queued");

    // Bob's workspace history is empty and Bob gets 404 when requesting Alice's scanId
    const bobHistoryRes = await getScans(
      new Request("http://localhost:3000/api/scans", {
        headers: { cookie: bobCookie },
      }),
    );
    const bobHistory = (await bobHistoryRes.json()) as {
      scans: unknown[];
    };
    expect(bobHistory.scans).toHaveLength(0);

    const bobDetailRes = await getScanDetail(
      new Request(`http://localhost:3000/api/scans/${scanId}`, {
        headers: { cookie: bobCookie },
      }),
      { params: Promise.resolve({ scanId }) },
    );
    expect(bobDetailRes.status).toBe(404);
  });
});
