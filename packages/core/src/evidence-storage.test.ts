import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type {
  D1BoundStatementLike,
  D1DatabaseLike,
  D1ExecResultLike,
  R2BucketLike,
  R2ObjectBodyLike,
  R2ObjectMetaLike,
  R2PutOptionsLike,
} from "./cloudflare";
import type { DualViewportPageCaptureResult } from "./browser-capture";
import {
  EvidenceAccessError,
  authorizeAndLoadEvidenceArtifact,
  buildEvidenceArtifactKey,
  buildSignedEvidenceUrl,
  computeSha256Hex,
  createSignedEvidenceToken,
  listScanEvidenceArtifactsInD1,
  persistPageCaptureEvidenceToR2AndD1,
  toArtifactBytes,
  verifyScanEvidenceCompletenessInD1,
  verifySignedEvidenceToken,
} from "./evidence-storage";
import { provisionPersonalWorkspace } from "./workspaces";

const MIGRATION_0001_PATH = resolve(
  __dirname,
  "../migrations/0001_auth_and_workspaces.sql",
);
const MIGRATION_0002_PATH = resolve(
  __dirname,
  "../migrations/0002_scans_evidence_findings_reports.sql",
);

function createSqliteD1(): D1DatabaseLike {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  sqlite.exec(readFileSync(MIGRATION_0001_PATH, "utf8"));
  sqlite.exec(readFileSync(MIGRATION_0002_PATH, "utf8"));

  function createBoundStatement(
    query: string,
    values: unknown[],
  ): D1BoundStatementLike {
    const normalizedValues = values.map((v) =>
      v === undefined ? null : (v as string | number | bigint | null),
    );
    return {
      async run(): Promise<D1ExecResultLike> {
        const stmt = sqlite.prepare(query);
        stmt.run(...normalizedValues);
        return { success: true };
      },
      async first<T = Record<string, unknown>>(): Promise<T | null> {
        const stmt = sqlite.prepare(query);
        const row = stmt.get(...normalizedValues) as T | undefined;
        return row ?? null;
      },
      async all<T = Record<string, unknown>>(): Promise<D1ExecResultLike<T>> {
        const stmt = sqlite.prepare(query);
        const rows = stmt.all(...normalizedValues) as T[];
        return { success: true, results: rows };
      },
    };
  }

  return {
    prepare(query: string) {
      return {
        bind(...values: unknown[]) {
          return createBoundStatement(query, values);
        },
      };
    },
  };
}

function createInMemoryR2(): R2BucketLike & {
  objects: Map<
    string,
    { bytes: Uint8Array; options?: R2PutOptionsLike; etag: string }
  >;
} {
  const objects = new Map<
    string,
    { bytes: Uint8Array; options?: R2PutOptionsLike; etag: string }
  >();

  return {
    objects,
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
        async text(): Promise<string> {
          return new TextDecoder().decode(found.bytes);
        },
      };
    },
  };
}

function buildSampleDualViewportCapture(): DualViewportPageCaptureResult {
  const desktopPng = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  const mobilePng = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 4, 5, 6]);

  return {
    requestedUrl: "https://acme.io/",
    normalizedUrl: "https://acme.io/",
    finalUrl: "https://acme.io/",
    statusCode: 200,
    captureStatus: "captured",
    dbCaptureStatus: "captured",
    failureClass: null,
    failureReason: null,
    redirectChain: [],
    loadTimings: { ttfbMs: 110, fcpMs: 650, lcpMs: 1420, cls: 0.01 },
    desktop: {
      viewport: "desktop",
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      requestedUrl: "https://acme.io/",
      finalUrl: "https://acme.io/",
      statusCode: 200,
      responseHeaders: {
        "content-type": "text/html; charset=utf-8",
        "strict-transport-security": "max-age=63072000; includeSubDomains",
      },
      redirectChain: [],
      title: "Acme Cloud — Home",
      renderedHtml:
        "<!doctype html><html><head><title>Acme Cloud — Home</title></head><body><h1>Hero</h1></body></html>",
      loadTimings: { ttfbMs: 110, fcpMs: 650, lcpMs: 1420, cls: 0.01 },
      consoleEntries: [
        {
          level: "error",
          text: "Uncaught ReferenceError: legacyWidget is not defined",
          url: "https://acme.io/app.js",
          lineNumber: 42,
          timestampMs: 1_760_000_000_100,
        },
      ],
      networkSummary: {
        totalRequests: 12,
        totalResponses: 12,
        statusBuckets: { "2xx": 11, "4xx": 1 },
        failedRequests: [
          {
            url: "https://acme.io/missing.png",
            method: "GET",
            resourceType: "image",
            statusCode: 404,
            errorText: "HTTP 404",
          },
        ],
      },
      aboveTheFoldScreenshot: desktopPng,
      fullPageScreenshot: desktopPng,
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
      requestedUrl: "https://acme.io/",
      finalUrl: "https://acme.io/",
      statusCode: 200,
      responseHeaders: {
        "content-type": "text/html; charset=utf-8",
      },
      redirectChain: [],
      title: "Acme Cloud — Home",
      renderedHtml:
        "<!doctype html><html><head><title>Acme Cloud — Home</title></head><body><h1>Hero</h1></body></html>",
      loadTimings: { ttfbMs: 130, fcpMs: 780, lcpMs: 1690, cls: 0.02 },
      consoleEntries: [],
      networkSummary: {
        totalRequests: 11,
        totalResponses: 11,
        statusBuckets: { "2xx": 11 },
        failedRequests: [],
      },
      aboveTheFoldScreenshot: mobilePng,
      fullPageScreenshot: mobilePng,
      screenshotContentType: "image/png",
      networkIdleTimedOut: false,
      botChallenge: { blocked: false, provider: null, reason: null },
      captureStatus: "captured",
    },
  };
}

describe("R2 evidence writer, D1 SHA-256 metadata, completeness validation, and signed access (THE-178)", () => {
  it("builds deterministic R2 keys and computes 64-character SHA-256 hex checksums", async () => {
    expect(
      buildEvidenceArtifactKey({
        scanId: "scan_123",
        pageId: "page_home",
        kind: "html",
      }),
    ).toBe("scans/scan_123/pages/page_home/html.html");

    expect(
      buildEvidenceArtifactKey({
        scanId: "scan_123",
        pageId: "page_home",
        kind: "screenshot_desktop",
      }),
    ).toBe("scans/scan_123/pages/page_home/screenshot_desktop.png");

    expect(
      buildEvidenceArtifactKey({
        scanId: "scan_123",
        pageId: "page_home",
        kind: "screenshot_element",
        suffix: "cta_primary",
        extension: "webp",
      }),
    ).toBe(
      "scans/scan_123/pages/page_home/screenshot_element_cta_primary.webp",
    );

    const sha = await computeSha256Hex("mortem-evidence-integrity-test");
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
  });

  it("persists HTML, headers, desktop/mobile/element screenshots, network logs, and console logs to R2 and D1 and verifies completeness", async () => {
    const d1 = createSqliteD1();
    const r2 = createInMemoryR2();
    const nowMs = 1_760_000_000_000;

    await d1
      .prepare(
        `INSERT INTO users (id, name, email, email_verified, created_at, updated_at)
         VALUES ('usr_ev_1', 'Owner', 'owner@acme.io', 1, ?, ?)`,
      )
      .bind(nowMs, nowMs)
      .run();

    const ws = await provisionPersonalWorkspace(
      d1,
      { id: "usr_ev_1", name: "Owner", email: "owner@acme.io" },
      { nowMs },
    );

    await d1
      .prepare(
        `INSERT INTO sites (id, workspace_id, origin, display_name, created_at, updated_at)
         VALUES ('site_ev_1', ?, 'https://acme.io', 'acme.io', ?, ?)`,
      )
      .bind(ws.workspaceId, nowMs, nowMs)
      .run();

    await d1
      .prepare(
        `INSERT INTO scans (id, workspace_id, site_id, target_url, normalized_url, status, created_at, updated_at)
         VALUES ('scan_ev_1', ?, 'site_ev_1', 'https://acme.io/', 'https://acme.io/', 'capturing', ?, ?)`,
      )
      .bind(ws.workspaceId, nowMs, nowMs)
      .run();

    await d1
      .prepare(
        `INSERT INTO pages (
           id, scan_id, url, normalized_url, template_type, status_code, capture_status, created_at, updated_at
         ) VALUES ('page_ev_home', 'scan_ev_1', 'https://acme.io/', 'https://acme.io/', 'home', 200, 'captured', ?, ?)`,
      )
      .bind(nowMs, nowMs)
      .run();

    // Also insert a skipped page with an explicit failure_reason
    await d1
      .prepare(
        `INSERT INTO pages (
           id, scan_id, url, normalized_url, template_type, status_code, capture_status, failure_reason, created_at, updated_at
         ) VALUES ('page_ev_skipped', 'scan_ev_1', 'https://acme.io/protected', 'https://acme.io/protected', 'other', 403, 'skipped', 'Cloudflare Turnstile challenge detected', ?, ?)`,
      )
      .bind(nowMs, nowMs)
      .run();

    const capture = buildSampleDualViewportCapture();
    const summary = await persistPageCaptureEvidenceToR2AndD1({
      d1,
      r2,
      scanId: "scan_ev_1",
      pageId: "page_ev_home",
      capture,
      elementScreenshots: [
        {
          suffix: "hero_cta",
          selector: "a.primary-cta",
          viewport: "desktop",
          width: 220,
          height: 56,
          screenshot: new Uint8Array([1, 2, 3, 4]),
        },
      ],
      nowMs,
    });

    expect(summary.artifacts).toHaveLength(7);
    expect(summary.artifacts.map((a) => a.kind)).toEqual([
      "html",
      "headers",
      "screenshot_desktop",
      "screenshot_mobile",
      "network_log",
      "console_log",
      "screenshot_element",
    ]);

    for (const artifact of summary.artifacts) {
      expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(artifact.byteSize).toBeGreaterThan(0);
      expect(r2.objects.has(artifact.r2Key)).toBe(true);
    }

    const dbArtifacts = await listScanEvidenceArtifactsInD1(
      d1,
      "scan_ev_1",
      "page_ev_home",
    );
    expect(dbArtifacts).toHaveLength(7);

    // Verify completeness across both captured and skipped pages
    const completeness = await verifyScanEvidenceCompletenessInD1(
      d1,
      "scan_ev_1",
      r2,
    );
    expect(completeness.complete).toBe(true);
    expect(completeness.capturedPagesChecked).toBe(1);
    expect(completeness.nonCapturedPagesChecked).toBe(1);
    expect(completeness.violations).toHaveLength(0);

    // Verify scans.usage_json tracked r2BytesWritten
    const scanUsageRow = await d1
      .prepare(`SELECT usage_json FROM scans WHERE id = 'scan_ev_1'`)
      .bind()
      .first<{ usage_json: string }>();
    const parsedUsage = JSON.parse(scanUsageRow?.usage_json ?? "{}") as {
      r2BytesWritten?: number;
    };
    expect(parsedUsage.r2BytesWritten).toBe(summary.totalBytesWritten);
  });

  it("enforces workspace membership, report share tokens, and short-lived HMAC-signed URLs when loading evidence", async () => {
    const d1 = createSqliteD1();
    const r2 = createInMemoryR2();
    const nowMs = 1_760_000_000_000;
    const secret = "mortem-test-signing-secret-key-32-chars-minimum";

    await d1
      .prepare(
        `INSERT INTO users (id, name, email, email_verified, created_at, updated_at)
         VALUES
           ('usr_owner', 'Workspace Owner', 'owner@acme.io', 1, ?, ?),
           ('usr_outsider', 'Outsider User', 'outsider@other.io', 1, ?, ?)`,
      )
      .bind(nowMs, nowMs, nowMs, nowMs)
      .run();

    const ownerWs = await provisionPersonalWorkspace(
      d1,
      { id: "usr_owner", name: "Workspace Owner", email: "owner@acme.io" },
      { nowMs },
    );
    await provisionPersonalWorkspace(
      d1,
      { id: "usr_outsider", name: "Outsider User", email: "outsider@other.io" },
      { nowMs },
    );

    await d1
      .prepare(
        `INSERT INTO sites (id, workspace_id, origin, display_name, created_at, updated_at)
         VALUES ('site_auth_1', ?, 'https://acme.io', 'acme.io', ?, ?)`,
      )
      .bind(ownerWs.workspaceId, nowMs, nowMs)
      .run();

    await d1
      .prepare(
        `INSERT INTO scans (id, workspace_id, site_id, target_url, normalized_url, status, created_at, updated_at)
         VALUES ('scan_auth_1', ?, 'site_auth_1', 'https://acme.io/', 'https://acme.io/', 'complete', ?, ?)`,
      )
      .bind(ownerWs.workspaceId, nowMs, nowMs)
      .run();

    await d1
      .prepare(
        `INSERT INTO pages (
           id, scan_id, url, normalized_url, template_type, status_code, capture_status, created_at, updated_at
         ) VALUES ('page_auth_home', 'scan_auth_1', 'https://acme.io/', 'https://acme.io/', 'home', 200, 'captured', ?, ?)`,
      )
      .bind(nowMs, nowMs)
      .run();

    const capture = buildSampleDualViewportCapture();
    const persisted = await persistPageCaptureEvidenceToR2AndD1({
      d1,
      r2,
      scanId: "scan_auth_1",
      pageId: "page_auth_home",
      capture,
      nowMs,
    });
    const htmlArtifact = persisted.artifacts.find((a) => a.kind === "html")!;

    // 1. Unauthenticated request is rejected with 403
    await expect(
      authorizeAndLoadEvidenceArtifact({
        d1,
        r2,
        artifactId: htmlArtifact.id,
        nowMs,
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "EVIDENCE_FORBIDDEN",
    } satisfies Partial<EvidenceAccessError>);

    // 2. Cross-workspace user is rejected with 403
    await expect(
      authorizeAndLoadEvidenceArtifact({
        d1,
        r2,
        artifactId: htmlArtifact.id,
        userId: "usr_outsider",
        nowMs,
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "EVIDENCE_FORBIDDEN",
    } satisfies Partial<EvidenceAccessError>);

    // 3. Workspace owner can load evidence
    const ownerLoaded = await authorizeAndLoadEvidenceArtifact({
      d1,
      r2,
      artifactId: htmlArtifact.id,
      userId: "usr_owner",
      nowMs,
    });
    expect(ownerLoaded.authorizedVia).toBe("workspace_session");
    expect(ownerLoaded.contentType).toBe("text/html; charset=utf-8");
    expect(ownerLoaded.etag).toBe(`"${htmlArtifact.sha256}"`);

    // 4. Short-lived HMAC-signed token grants access before expiry and rejects after expiry
    const signed = await buildSignedEvidenceUrl({
      artifactId: htmlArtifact.id,
      scanId: "scan_auth_1",
      workspaceId: ownerWs.workspaceId,
      secret,
      baseUrl: "https://mortem.corstack.dev",
      ttlSeconds: 300,
      nowMs,
    });
    expect(signed.url).toContain(
      `https://mortem.corstack.dev/api/evidence/${htmlArtifact.id}?token=`,
    );

    const tokenLoaded = await authorizeAndLoadEvidenceArtifact({
      d1,
      r2,
      artifactId: htmlArtifact.id,
      signedToken: signed.token,
      signingSecret: secret,
      nowMs: nowMs + 60_000,
    });
    expect(tokenLoaded.authorizedVia).toBe("signed_token");

    // Expired HMAC token -> 403
    await expect(
      authorizeAndLoadEvidenceArtifact({
        d1,
        r2,
        artifactId: htmlArtifact.id,
        signedToken: signed.token,
        signingSecret: secret,
        nowMs: nowMs + 301_000,
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "INVALID_EVIDENCE_TOKEN",
    });

    // Token replayed against a different artifactId -> 403
    const desktopShot = persisted.artifacts.find(
      (a) => a.kind === "screenshot_desktop",
    )!;
    const replayCheck = await verifySignedEvidenceToken({
      token: signed.token,
      artifactId: desktopShot.id,
      scanId: "scan_auth_1",
      workspaceId: ownerWs.workspaceId,
      secret,
      nowMs,
    });
    expect(replayCheck.valid).toBe(false);

    // 5. Report share token grants access when active and rejects when revoked
    await d1
      .prepare(
        `INSERT INTO reports (
           id, scan_id, workspace_id, scoring_version, overall_score, unlocked, created_at, updated_at
         ) VALUES ('rpt_auth_1', 'scan_auth_1', ?, 'v1.0.0', 84, 1, ?, ?)`,
      )
      .bind(ownerWs.workspaceId, nowMs, nowMs)
      .run();

    await d1
      .prepare(
        `INSERT INTO report_shares (
           id, report_id, workspace_id, share_token, created_by_user_id, expires_at, revoked_at, created_at
         ) VALUES ('share_1', 'rpt_auth_1', ?, 'valid_share_token_xyz', 'usr_owner', ?, NULL, ?)`,
      )
      .bind(ownerWs.workspaceId, nowMs + 3_600_000, nowMs)
      .run();

    const shareLoaded = await authorizeAndLoadEvidenceArtifact({
      d1,
      r2,
      artifactId: desktopShot.id,
      shareToken: "valid_share_token_xyz",
      nowMs,
    });
    expect(shareLoaded.authorizedVia).toBe("share_token");

    // Revoke the share token -> 403
    await d1
      .prepare(`UPDATE report_shares SET revoked_at = ? WHERE id = 'share_1'`)
      .bind(nowMs + 1000)
      .run();

    await expect(
      authorizeAndLoadEvidenceArtifact({
        d1,
        r2,
        artifactId: desktopShot.id,
        shareToken: "valid_share_token_xyz",
        nowMs: nowMs + 2000,
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "INVALID_SHARE_TOKEN",
    });

    // Helper sanity check for direct createSignedEvidenceToken
    const rawToken = await createSignedEvidenceToken({
      artifactId: htmlArtifact.id,
      scanId: "scan_auth_1",
      workspaceId: ownerWs.workspaceId,
      expiresAtMs: nowMs + 10_000,
      secret,
    });
    expect(rawToken).toContain(".");
  });
});
