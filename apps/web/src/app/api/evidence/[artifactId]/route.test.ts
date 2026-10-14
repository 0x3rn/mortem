import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSignedEvidenceUrl,
  persistPageCaptureEvidenceToR2AndD1,
  toArtifactBytes,
  type D1BoundStatementLike,
  type D1DatabaseLike,
  type D1ExecResultLike,
  type DualViewportPageCaptureResult,
  type MortemWebBindings,
  type R2BucketLike,
  type R2ObjectBodyLike,
  type R2ObjectMetaLike,
  type R2PutOptionsLike,
} from "@mortem/core";

let currentEnv: MortemWebBindings;

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: async () => ({
    env: currentEnv,
  }),
}));

import { POST as authPost } from "../../auth/[...all]/route";
import { GET as getEvidence } from "./route";

const MIGRATION_0001_PATH = resolve(
  process.cwd(),
  "../../packages/core/migrations/0001_auth_and_workspaces.sql",
);
const MIGRATION_0002_PATH = resolve(
  process.cwd(),
  "../../packages/core/migrations/0002_scans_evidence_findings_reports.sql",
);

function createSqliteD1(): D1DatabaseLike {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  sqlite.exec(readFileSync(MIGRATION_0001_PATH, "utf8"));
  sqlite.exec(readFileSync(MIGRATION_0002_PATH, "utf8"));

  function createBoundStatement(
    query: string,
    values: unknown[],
  ): D1BoundStatementLike & { raw?: () => Promise<unknown[][]> } {
    const normalizedValues = values.map((v) => {
      if (v === undefined) return null;
      if (typeof v === "boolean") return v ? 1 : 0;
      if (v instanceof Date) return v.getTime();
      return v as string | number | bigint | null;
    });
    return {
      async run(): Promise<D1ExecResultLike> {
        const stmt = sqlite.prepare(query);
        const isReader = /^\s*(SELECT|PRAGMA|WITH|EXPLAIN)\b/i.test(query);
        if (isReader) {
          const rows = stmt.all(...normalizedValues) as Record<
            string,
            unknown
          >[];
          return { success: true, results: rows };
        }
        stmt.run(...normalizedValues);
        return { success: true, results: [] };
      },
      async first<T = Record<string, unknown>>(
        col?: string,
      ): Promise<T | null> {
        const stmt = sqlite.prepare(query);
        const row = stmt.get(...normalizedValues) as
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
          const rows = stmt.all(...normalizedValues) as T[];
          return { success: true, results: rows };
        }
        stmt.run(...normalizedValues);
        return { success: true, results: [] };
      },
      async raw(): Promise<unknown[][]> {
        const stmt = sqlite.prepare(query);
        const isReader =
          /^\s*(SELECT|PRAGMA|WITH|EXPLAIN)\b/i.test(query) ||
          /\bRETURNING\b/i.test(query);
        if (!isReader) {
          stmt.run(...normalizedValues);
          return [];
        }
        const rows = stmt.all(...normalizedValues) as Record<string, unknown>[];
        return rows.map((r) => Object.values(r));
      },
    };
  }

  return {
    prepare(query: string) {
      const def = createBoundStatement(query, []);
      return {
        ...def,
        bind(...values: unknown[]) {
          return createBoundStatement(query, values);
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

function createInMemoryR2(): R2BucketLike {
  const objects = new Map<
    string,
    { bytes: Uint8Array; options?: R2PutOptionsLike; etag: string }
  >();

  return {
    async put(
      key: string,
      value: Uint8Array | ArrayBuffer | string,
      options?: R2PutOptionsLike,
    ): Promise<R2ObjectMetaLike | null> {
      const bytes = toArtifactBytes(value);
      const etag = `etag_${bytes.byteLength}`;
      objects.set(key, { bytes, options, etag });
      return { key, size: bytes.byteLength, etag };
    },
    async head(key: string): Promise<R2ObjectMetaLike | null> {
      const found = objects.get(key);
      if (!found) return null;
      return { key, size: found.bytes.byteLength, etag: found.etag };
    },
    async get(key: string): Promise<R2ObjectBodyLike | null> {
      const found = objects.get(key);
      if (!found) return null;
      return {
        key,
        size: found.bytes.byteLength,
        etag: found.etag,
        httpMetadata: found.options?.httpMetadata,
        customMetadata: found.options?.customMetadata,
        async arrayBuffer(): Promise<ArrayBuffer> {
          return found.bytes.buffer.slice(
            found.bytes.byteOffset,
            found.bytes.byteOffset + found.bytes.byteLength,
          ) as ArrayBuffer;
        },
      };
    },
  };
}

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

function createSampleCapture(): DualViewportPageCaptureResult {
  const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 99]);
  return {
    requestedUrl: "https://linear.app/",
    normalizedUrl: "https://linear.app/",
    finalUrl: "https://linear.app/",
    statusCode: 200,
    captureStatus: "captured",
    dbCaptureStatus: "captured",
    failureClass: null,
    failureReason: null,
    redirectChain: [],
    loadTimings: { ttfbMs: 95, fcpMs: 520, lcpMs: 1180, cls: 0 },
    desktop: {
      viewport: "desktop",
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      requestedUrl: "https://linear.app/",
      finalUrl: "https://linear.app/",
      statusCode: 200,
      responseHeaders: { "content-type": "text/html; charset=utf-8" },
      redirectChain: [],
      title: "Linear — Plan and build products",
      renderedHtml:
        "<!doctype html><html><head><title>Linear</title></head><body><main>Linear Evidence</main></body></html>",
      loadTimings: { ttfbMs: 95, fcpMs: 520, lcpMs: 1180, cls: 0 },
      consoleEntries: [],
      networkSummary: {
        totalRequests: 4,
        totalResponses: 4,
        statusBuckets: { "2xx": 4 },
        failedRequests: [],
      },
      aboveTheFoldScreenshot: pngBytes,
      fullPageScreenshot: pngBytes,
      screenshotContentType: "image/png",
      networkIdleTimedOut: false,
      botChallenge: { blocked: false, provider: null, reason: null },
      captureStatus: "captured",
    },
    mobile: {
      viewport: "mobile",
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      requestedUrl: "https://linear.app/",
      finalUrl: "https://linear.app/",
      statusCode: 200,
      responseHeaders: { "content-type": "text/html; charset=utf-8" },
      redirectChain: [],
      title: "Linear — Plan and build products",
      renderedHtml:
        "<!doctype html><html><head><title>Linear</title></head><body><main>Linear Evidence</main></body></html>",
      loadTimings: { ttfbMs: 110, fcpMs: 610, lcpMs: 1320, cls: 0 },
      consoleEntries: [],
      networkSummary: {
        totalRequests: 4,
        totalResponses: 4,
        statusBuckets: { "2xx": 4 },
        failedRequests: [],
      },
      aboveTheFoldScreenshot: pngBytes,
      fullPageScreenshot: pngBytes,
      screenshotContentType: "image/png",
      networkIdleTimedOut: false,
      botChallenge: { blocked: false, provider: null, reason: null },
      captureStatus: "captured",
    },
  };
}

describe("GET /api/evidence/[artifactId] route handler (THE-178)", () => {
  const SECRET = "test-secret-for-mortem-evidence-route-32-chars";

  beforeEach(() => {
    const d1 = createSqliteD1();
    const r2 = createInMemoryR2();
    currentEnv = {
      ENVIRONMENT: "test",
      BETTER_AUTH_SECRET: SECRET,
      BETTER_AUTH_URL: "http://localhost:3000",
      DB: d1,
      EVIDENCE: r2,
      SCAN_QUEUE: {
        send: async () => undefined,
      },
    };
  });

  it("streams evidence with Cache-Control: private, max-age=3600 for workspace members, share tokens, and HMAC tokens, and returns 403/404 for unauthenticated or cross-workspace requests", async () => {
    // 1. Sign up Owner (User A) and Outsider (User B)
    const ownerSignUp = await authPost(
      new Request("http://localhost:3000/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Ada Lovelace",
          email: "ada@mortem.dev",
          password: "ada-secure-password-123",
        }),
      }),
    );
    expect(ownerSignUp.status).toBe(200);
    const ownerCookie = extractCookieHeader(ownerSignUp);

    const outsiderSignUp = await authPost(
      new Request("http://localhost:3000/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Mallory Outsider",
          email: "mallory@outsider.dev",
          password: "mallory-secure-password-123",
        }),
      }),
    );
    expect(outsiderSignUp.status).toBe(200);
    const outsiderCookie = extractCookieHeader(outsiderSignUp);

    const d1 = currentEnv.DB!;
    const r2 = currentEnv.EVIDENCE!;
    const nowMs = Date.now();

    const ownerWorkspace = await d1
      .prepare(
        `SELECT w.id FROM workspaces w
         INNER JOIN users u ON u.id = w.owner_user_id
         WHERE u.email = 'ada@mortem.dev' LIMIT 1`,
      )
      .bind()
      .first<{ id: string }>();
    expect(ownerWorkspace?.id).toBeTruthy();
    const workspaceId = ownerWorkspace!.id;

    // 2. Seed scan, page, and R2/D1 evidence in Ada's workspace
    await d1
      .prepare(
        `INSERT INTO sites (id, workspace_id, origin, display_name, created_at, updated_at)
         VALUES ('site_lin', ?, 'https://linear.app', 'linear.app', ?, ?)`,
      )
      .bind(workspaceId, nowMs, nowMs)
      .run();

    await d1
      .prepare(
        `INSERT INTO scans (id, workspace_id, site_id, target_url, normalized_url, status, created_at, updated_at)
         VALUES ('scan_lin_1', ?, 'site_lin', 'https://linear.app/', 'https://linear.app/', 'complete', ?, ?)`,
      )
      .bind(workspaceId, nowMs, nowMs)
      .run();

    await d1
      .prepare(
        `INSERT INTO pages (id, scan_id, url, normalized_url, template_type, status_code, capture_status, created_at, updated_at)
         VALUES ('page_lin_home', 'scan_lin_1', 'https://linear.app/', 'https://linear.app/', 'home', 200, 'captured', ?, ?)`,
      )
      .bind(nowMs, nowMs)
      .run();

    const persisted = await persistPageCaptureEvidenceToR2AndD1({
      d1,
      r2,
      scanId: "scan_lin_1",
      pageId: "page_lin_home",
      capture: createSampleCapture(),
      nowMs,
    });
    const htmlArtifact = persisted.artifacts.find((a) => a.kind === "html")!;
    const desktopShot = persisted.artifacts.find(
      (a) => a.kind === "screenshot_desktop",
    )!;

    // 3. Unauthenticated request -> 403
    const unauthRes = await getEvidence(
      new Request(`http://localhost:3000/api/evidence/${htmlArtifact.id}`),
      { params: Promise.resolve({ artifactId: htmlArtifact.id }) },
    );
    expect(unauthRes.status).toBe(403);

    // 4. Cross-workspace user (Mallory) request -> 403
    const crossWsRes = await getEvidence(
      new Request(`http://localhost:3000/api/evidence/${htmlArtifact.id}`, {
        headers: { cookie: outsiderCookie },
      }),
      { params: Promise.resolve({ artifactId: htmlArtifact.id }) },
    );
    expect(crossWsRes.status).toBe(403);

    // 5. Non-existent artifact requested by authenticated user -> 404
    const missingRes = await getEvidence(
      new Request("http://localhost:3000/api/evidence/non_existent_artifact", {
        headers: { cookie: ownerCookie },
      }),
      { params: Promise.resolve({ artifactId: "non_existent_artifact" }) },
    );
    expect(missingRes.status).toBe(404);

    // 6. Workspace owner (Ada) streams HTML evidence -> 200 with Cache-Control: private, max-age=3600 and ETag
    const ownerRes = await getEvidence(
      new Request(`http://localhost:3000/api/evidence/${htmlArtifact.id}`, {
        headers: { cookie: ownerCookie },
      }),
      { params: Promise.resolve({ artifactId: htmlArtifact.id }) },
    );
    expect(ownerRes.status).toBe(200);
    expect(ownerRes.headers.get("cache-control")).toBe("private, max-age=3600");
    expect(ownerRes.headers.get("etag")).toBe(`"${htmlArtifact.sha256}"`);
    expect(ownerRes.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
    const htmlText = await ownerRes.text();
    expect(htmlText).toContain("Linear Evidence");

    // 7. Conditional GET with If-None-Match returns 304 Not Modified
    const cachedRes = await getEvidence(
      new Request(`http://localhost:3000/api/evidence/${htmlArtifact.id}`, {
        headers: {
          cookie: ownerCookie,
          "if-none-match": `"${htmlArtifact.sha256}"`,
        },
      }),
      { params: Promise.resolve({ artifactId: htmlArtifact.id }) },
    );
    expect(cachedRes.status).toBe(304);

    // 8. Short-lived HMAC-signed URL streams PNG screenshot without session cookies
    const signed = await buildSignedEvidenceUrl({
      artifactId: desktopShot.id,
      scanId: "scan_lin_1",
      workspaceId,
      secret: SECRET,
      baseUrl: "http://localhost:3000",
      ttlSeconds: 600,
    });
    const signedRes = await getEvidence(new Request(signed.url), {
      params: Promise.resolve({ artifactId: desktopShot.id }),
    });
    expect(signedRes.status).toBe(200);
    expect(signedRes.headers.get("content-type")).toBe("image/png");
    expect(signedRes.headers.get("cache-control")).toBe(
      "private, max-age=3600",
    );
    const shotBytes = new Uint8Array(await signedRes.arrayBuffer());
    expect(shotBytes[0]).toBe(137);
    expect(shotBytes[1]).toBe(80);

    // 9. Tampered HMAC token returns 403
    const tamperedRes = await getEvidence(
      new Request(
        `http://localhost:3000/api/evidence/${desktopShot.id}?token=${signed.expiresAtMs}.${"0".repeat(64)}`,
      ),
      { params: Promise.resolve({ artifactId: desktopShot.id }) },
    );
    expect(tamperedRes.status).toBe(403);
  });
});
