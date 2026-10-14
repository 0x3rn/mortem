import {
  PlatformBindingError,
  type D1DatabaseLike,
  type R2BucketLike,
} from "./cloudflare";
import type { DualViewportPageCaptureResult } from "./browser-capture";
import type { EvidenceArtifactKind, ScanUsageJson } from "./schema/scans";
import { WorkspaceAccessError, requireWorkspaceAccess } from "./workspaces";

export const DEFAULT_EVIDENCE_TOKEN_TTL_SECONDS = 3600;
export const EVIDENCE_CACHE_CONTROL_HEADER = "private, max-age=3600";

export type EvidenceAccessErrorCode =
  | "EVIDENCE_FORBIDDEN"
  | "EVIDENCE_NOT_FOUND"
  | "EVIDENCE_OBJECT_MISSING"
  | "INVALID_EVIDENCE_TOKEN"
  | "INVALID_SHARE_TOKEN";

export class EvidenceAccessError extends Error {
  readonly code: EvidenceAccessErrorCode;
  readonly status: 401 | 403 | 404;

  constructor(
    code: EvidenceAccessErrorCode,
    message: string,
    status: 401 | 403 | 404 = 403,
  ) {
    super(message);
    this.name = "EvidenceAccessError";
    this.code = code;
    this.status = status;
  }
}

export interface EvidenceArtifactMetadataJson {
  contentType: string;
  viewport?: "desktop" | "mobile";
  width?: number;
  height?: number;
  deviceScaleFactor?: number;
  fullPage?: boolean;
  aboveTheFoldR2Key?: string;
  aboveTheFoldByteSize?: number;
  aboveTheFoldSha256?: string;
  selector?: string;
  title?: string;
  finalUrl?: string;
  statusCode?: number | null;
  [key: string]: unknown;
}

export interface PersistedEvidenceArtifact {
  id: string;
  scanId: string;
  pageId: string | null;
  kind: EvidenceArtifactKind;
  r2Key: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  metadata: EvidenceArtifactMetadataJson;
  metadataJson: string;
  createdAt: number;
}

export interface ElementScreenshotCaptureInput {
  suffix: string;
  selector?: string;
  viewport: "desktop" | "mobile";
  width?: number;
  height?: number;
  screenshot: Uint8Array | ArrayBuffer;
  contentType?: "image/png" | "image/webp";
}

export interface PageEvidencePersistenceSummary {
  scanId: string;
  pageId: string;
  artifacts: PersistedEvidenceArtifact[];
  totalBytesWritten: number;
}

export interface ScanEvidenceCompletenessReport {
  complete: boolean;
  totalPages: number;
  capturedPagesChecked: number;
  nonCapturedPagesChecked: number;
  violations: Array<{
    pageId: string;
    normalizedUrl: string;
    captureStatus: string;
    issue: string;
  }>;
}

export interface LoadedEvidenceArtifactStream {
  artifact: PersistedEvidenceArtifact & {
    workspaceId: string;
  };
  body: ReadableStream<Uint8Array> | Uint8Array;
  contentType: string;
  byteSize: number;
  etag: string;
  cacheControl: string;
  authorizedVia: "workspace_session" | "share_token" | "signed_token";
}

const DEFAULT_KIND_CONTENT_TYPES: Readonly<
  Record<EvidenceArtifactKind, { contentType: string; extension: string }>
> = {
  html: {
    contentType: "text/html; charset=utf-8",
    extension: "html",
  },
  screenshot_desktop: {
    contentType: "image/png",
    extension: "png",
  },
  screenshot_mobile: {
    contentType: "image/png",
    extension: "png",
  },
  screenshot_element: {
    contentType: "image/png",
    extension: "png",
  },
  headers: {
    contentType: "application/json; charset=utf-8",
    extension: "json",
  },
  network_log: {
    contentType: "application/json; charset=utf-8",
    extension: "json",
  },
  console_log: {
    contentType: "application/json; charset=utf-8",
    extension: "json",
  },
  psi_raw: {
    contentType: "application/json; charset=utf-8",
    extension: "json",
  },
  axe_raw: {
    contentType: "application/json; charset=utf-8",
    extension: "json",
  },
  pdf: {
    contentType: "application/pdf",
    extension: "pdf",
  },
};

function sanitizeKeySegment(segment: string): string {
  return segment.trim().replace(/[^a-zA-Z0-9._-]/g, "_");
}

/**
 * Converts a string, `ArrayBuffer`, or `Uint8Array` into a `Uint8Array`.
 */
export function toArtifactBytes(
  payload: Uint8Array | ArrayBuffer | string,
): Uint8Array {
  if (typeof payload === "string") {
    return new TextEncoder().encode(payload);
  }
  if (payload instanceof Uint8Array) {
    return payload;
  }
  return new Uint8Array(payload);
}

/**
 * Computes a 64-character lowercase hexadecimal SHA-256 checksum using Web Crypto.
 */
export async function computeSha256Hex(
  payload: Uint8Array | ArrayBuffer | string,
): Promise<string> {
  const bytes = toArtifactBytes(payload);
  const digestBuffer = await crypto.subtle.digest(
    "SHA-256",
    bytes as unknown as BufferSource,
  );
  const digestBytes = new Uint8Array(digestBuffer);
  let hex = "";
  for (const byte of digestBytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Builds the deterministic R2 object key (`scans/{scanId}/pages/{pageId}/{kind}.{ext}`)
 * for a scan or page evidence artifact (`THE-178`).
 */
export function buildEvidenceArtifactKey(params: {
  scanId: string;
  pageId?: string | null;
  kind: EvidenceArtifactKind;
  extension?: string;
  suffix?: string;
}): string {
  const safeScanId = sanitizeKeySegment(params.scanId);
  const defaults = DEFAULT_KIND_CONTENT_TYPES[params.kind];
  const ext = sanitizeKeySegment(
    params.extension ?? defaults?.extension ?? "bin",
  ).replace(/^\.+/, "");
  const suffixPart = params.suffix
    ? `_${sanitizeKeySegment(params.suffix)}`
    : "";

  if (params.pageId) {
    const safePageId = sanitizeKeySegment(params.pageId);
    return `scans/${safeScanId}/pages/${safePageId}/${params.kind}${suffixPart}.${ext}`;
  }

  return `scans/${safeScanId}/reports/${params.kind}${suffixPart}.${ext}`;
}

/**
 * Builds a deterministic D1 `evidence_artifacts.id` for a page or scan artifact.
 */
export function buildDeterministicEvidenceArtifactId(params: {
  scanId: string;
  pageId?: string | null;
  kind: EvidenceArtifactKind;
  suffix?: string;
}): string {
  const prefix = params.pageId
    ? sanitizeKeySegment(params.pageId)
    : sanitizeKeySegment(params.scanId);
  const suffixPart = params.suffix
    ? `_${sanitizeKeySegment(params.suffix)}`
    : "";
  return `${prefix}_ev_${params.kind}${suffixPart}`;
}

/**
 * Writes an immutable evidence artifact payload to Cloudflare R2 (`env.EVIDENCE`) and upserts
 * its metadata + SHA-256 checksum into D1 (`evidence_artifacts`).
 */
export async function writeEvidenceArtifactToR2AndD1(params: {
  d1: D1DatabaseLike;
  r2: R2BucketLike;
  scanId: string;
  pageId?: string | null;
  artifactId?: string;
  kind: EvidenceArtifactKind;
  payload: Uint8Array | ArrayBuffer | string;
  contentType?: string;
  extension?: string;
  suffix?: string;
  metadata?: Record<string, unknown>;
  nowMs?: number;
}): Promise<PersistedEvidenceArtifact> {
  const nowMs = params.nowMs ?? Date.now();
  const defaults = DEFAULT_KIND_CONTENT_TYPES[params.kind];
  const contentType =
    params.contentType?.trim() ||
    defaults?.contentType ||
    "application/octet-stream";
  const extension =
    params.extension?.trim() ||
    (contentType.includes("webp") ? "webp" : defaults?.extension) ||
    "bin";

  const bytes = toArtifactBytes(params.payload);
  const byteSize = bytes.byteLength;
  const sha256 = await computeSha256Hex(bytes);

  const artifactId =
    params.artifactId?.trim() ||
    buildDeterministicEvidenceArtifactId({
      scanId: params.scanId,
      pageId: params.pageId,
      kind: params.kind,
      suffix: params.suffix,
    });

  const r2Key = buildEvidenceArtifactKey({
    scanId: params.scanId,
    pageId: params.pageId,
    kind: params.kind,
    extension,
    suffix: params.suffix,
  });

  const metadata: EvidenceArtifactMetadataJson = {
    ...params.metadata,
    contentType,
  };
  const metadataJson = JSON.stringify(metadata);

  try {
    await params.r2.put(r2Key, bytes, {
      httpMetadata: {
        contentType,
      },
      customMetadata: {
        artifactId,
        scanId: params.scanId,
        ...(params.pageId ? { pageId: params.pageId } : {}),
        kind: params.kind,
        sha256,
      },
    });
  } catch (err) {
    const reason =
      err instanceof Error ? err.message : "Unknown R2 storage write error";
    throw new PlatformBindingError(
      "STORAGE_WRITE_FAILED",
      "EVIDENCE",
      `Failed to write ${params.kind} evidence artifact to R2 (${r2Key}): ${reason}`,
      { cause: err },
    );
  }

  try {
    await params.d1
      .prepare(
        `INSERT INTO evidence_artifacts (
           id, scan_id, page_id, kind, r2_key, byte_size, sha256, metadata_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           r2_key = excluded.r2_key,
           byte_size = excluded.byte_size,
           sha256 = excluded.sha256,
           metadata_json = excluded.metadata_json,
           created_at = excluded.created_at`,
      )
      .bind(
        artifactId,
        params.scanId,
        params.pageId ?? null,
        params.kind,
        r2Key,
        byteSize,
        sha256,
        metadataJson,
        nowMs,
      )
      .run();
  } catch (err) {
    const reason =
      err instanceof Error ? err.message : "Unknown D1 database write error";
    throw new PlatformBindingError(
      "DATABASE_QUERY_FAILED",
      "DB",
      `Failed to record ${params.kind} evidence metadata in D1 for ${artifactId}: ${reason}`,
      { cause: err },
    );
  }

  return {
    id: artifactId,
    scanId: params.scanId,
    pageId: params.pageId ?? null,
    kind: params.kind,
    r2Key,
    contentType,
    byteSize,
    sha256,
    metadata,
    metadataJson,
    createdAt: nowMs,
  };
}

/**
 * Persists all raw evidence artifacts for a captured page (`html`, `headers`,
 * `screenshot_desktop`, `screenshot_mobile`, `network_log`, `console_log`, and optional
 * `screenshot_element` items) to R2 (`env.EVIDENCE`) and D1 (`evidence_artifacts`),
 * and increments `r2BytesWritten` in `scans.usage_json`.
 */
export async function persistPageCaptureEvidenceToR2AndD1(params: {
  d1: D1DatabaseLike;
  r2: R2BucketLike;
  scanId: string;
  pageId: string;
  capture: DualViewportPageCaptureResult;
  elementScreenshots?: ElementScreenshotCaptureInput[];
  nowMs?: number;
}): Promise<PageEvidencePersistenceSummary> {
  const nowMs = params.nowMs ?? Date.now();
  const { d1, r2, scanId, pageId, capture } = params;
  const artifacts: PersistedEvidenceArtifact[] = [];
  let totalBytesWritten = 0;

  // 1. Rendered HTML snapshot (`scans/{scanId}/pages/{pageId}/html.html`)
  const renderedHtml =
    capture.desktop.renderedHtml || capture.mobile.renderedHtml || "";
  const htmlArtifact = await writeEvidenceArtifactToR2AndD1({
    d1,
    r2,
    scanId,
    pageId,
    kind: "html",
    payload: renderedHtml,
    contentType: "text/html; charset=utf-8",
    extension: "html",
    metadata: {
      viewport: "desktop",
      title: capture.desktop.title || capture.mobile.title,
      finalUrl: capture.finalUrl,
      statusCode: capture.statusCode,
    },
    nowMs,
  });
  artifacts.push(htmlArtifact);
  totalBytesWritten += htmlArtifact.byteSize;

  // 2. Response headers JSON (`scans/{scanId}/pages/{pageId}/headers.json`)
  const headersPayload = JSON.stringify(
    {
      requestedUrl: capture.requestedUrl,
      finalUrl: capture.finalUrl,
      statusCode: capture.statusCode,
      redirectChain: capture.redirectChain,
      desktop: capture.desktop.responseHeaders,
      mobile: capture.mobile.responseHeaders,
    },
    null,
    2,
  );
  const headersArtifact = await writeEvidenceArtifactToR2AndD1({
    d1,
    r2,
    scanId,
    pageId,
    kind: "headers",
    payload: headersPayload,
    contentType: "application/json; charset=utf-8",
    extension: "json",
    metadata: {
      finalUrl: capture.finalUrl,
      statusCode: capture.statusCode,
      desktopHeaderCount: Object.keys(capture.desktop.responseHeaders).length,
      mobileHeaderCount: Object.keys(capture.mobile.responseHeaders).length,
    },
    nowMs,
  });
  artifacts.push(headersArtifact);
  totalBytesWritten += headersArtifact.byteSize;

  // 3. Desktop screenshot (`scans/{scanId}/pages/{pageId}/screenshot_desktop.png`)
  // Also write above-the-fold screenshot to R2 (`screenshot_desktop_above_fold.png`) for fold inspection
  const desktopAboveFoldKey = buildEvidenceArtifactKey({
    scanId,
    pageId,
    kind: "screenshot_desktop",
    extension:
      capture.desktop.screenshotContentType === "image/webp" ? "webp" : "png",
    suffix: "above_fold",
  });
  const desktopAboveFoldBytes = toArtifactBytes(
    capture.desktop.aboveTheFoldScreenshot,
  );
  const desktopAboveFoldSha256 = await computeSha256Hex(desktopAboveFoldBytes);
  try {
    await r2.put(desktopAboveFoldKey, desktopAboveFoldBytes, {
      httpMetadata: {
        contentType: capture.desktop.screenshotContentType,
      },
      customMetadata: {
        scanId,
        pageId,
        kind: "screenshot_desktop_above_fold",
        sha256: desktopAboveFoldSha256,
      },
    });
    totalBytesWritten += desktopAboveFoldBytes.byteLength;
  } catch (err) {
    const reason =
      err instanceof Error ? err.message : "Unknown R2 storage write error";
    throw new PlatformBindingError(
      "STORAGE_WRITE_FAILED",
      "EVIDENCE",
      `Failed to write desktop above-the-fold screenshot to R2 (${desktopAboveFoldKey}): ${reason}`,
      { cause: err },
    );
  }

  const desktopScreenshotArtifact = await writeEvidenceArtifactToR2AndD1({
    d1,
    r2,
    scanId,
    pageId,
    kind: "screenshot_desktop",
    payload: capture.desktop.fullPageScreenshot,
    contentType: capture.desktop.screenshotContentType,
    extension:
      capture.desktop.screenshotContentType === "image/webp" ? "webp" : "png",
    metadata: {
      viewport: "desktop",
      width: capture.desktop.width,
      height: capture.desktop.height,
      deviceScaleFactor: capture.desktop.deviceScaleFactor,
      fullPage: true,
      aboveTheFoldR2Key: desktopAboveFoldKey,
      aboveTheFoldByteSize: desktopAboveFoldBytes.byteLength,
      aboveTheFoldSha256: desktopAboveFoldSha256,
    },
    nowMs,
  });
  artifacts.push(desktopScreenshotArtifact);
  totalBytesWritten += desktopScreenshotArtifact.byteSize;

  // 4. Mobile screenshot (`scans/{scanId}/pages/{pageId}/screenshot_mobile.png`)
  const mobileAboveFoldKey = buildEvidenceArtifactKey({
    scanId,
    pageId,
    kind: "screenshot_mobile",
    extension:
      capture.mobile.screenshotContentType === "image/webp" ? "webp" : "png",
    suffix: "above_fold",
  });
  const mobileAboveFoldBytes = toArtifactBytes(
    capture.mobile.aboveTheFoldScreenshot,
  );
  const mobileAboveFoldSha256 = await computeSha256Hex(mobileAboveFoldBytes);
  try {
    await r2.put(mobileAboveFoldKey, mobileAboveFoldBytes, {
      httpMetadata: {
        contentType: capture.mobile.screenshotContentType,
      },
      customMetadata: {
        scanId,
        pageId,
        kind: "screenshot_mobile_above_fold",
        sha256: mobileAboveFoldSha256,
      },
    });
    totalBytesWritten += mobileAboveFoldBytes.byteLength;
  } catch (err) {
    const reason =
      err instanceof Error ? err.message : "Unknown R2 storage write error";
    throw new PlatformBindingError(
      "STORAGE_WRITE_FAILED",
      "EVIDENCE",
      `Failed to write mobile above-the-fold screenshot to R2 (${mobileAboveFoldKey}): ${reason}`,
      { cause: err },
    );
  }

  const mobileScreenshotArtifact = await writeEvidenceArtifactToR2AndD1({
    d1,
    r2,
    scanId,
    pageId,
    kind: "screenshot_mobile",
    payload: capture.mobile.fullPageScreenshot,
    contentType: capture.mobile.screenshotContentType,
    extension:
      capture.mobile.screenshotContentType === "image/webp" ? "webp" : "png",
    metadata: {
      viewport: "mobile",
      width: capture.mobile.width,
      height: capture.mobile.height,
      deviceScaleFactor: capture.mobile.deviceScaleFactor,
      fullPage: true,
      aboveTheFoldR2Key: mobileAboveFoldKey,
      aboveTheFoldByteSize: mobileAboveFoldBytes.byteLength,
      aboveTheFoldSha256: mobileAboveFoldSha256,
    },
    nowMs,
  });
  artifacts.push(mobileScreenshotArtifact);
  totalBytesWritten += mobileScreenshotArtifact.byteSize;

  // 5. Network request/error & timing log (`scans/{scanId}/pages/{pageId}/network_log.json`)
  const networkLogPayload = JSON.stringify(
    {
      requestedUrl: capture.requestedUrl,
      finalUrl: capture.finalUrl,
      statusCode: capture.statusCode,
      redirectChain: capture.redirectChain,
      loadTimings: capture.loadTimings,
      desktop: {
        loadTimings: capture.desktop.loadTimings,
        networkSummary: capture.desktop.networkSummary,
        networkIdleTimedOut: capture.desktop.networkIdleTimedOut,
      },
      mobile: {
        loadTimings: capture.mobile.loadTimings,
        networkSummary: capture.mobile.networkSummary,
        networkIdleTimedOut: capture.mobile.networkIdleTimedOut,
      },
    },
    null,
    2,
  );
  const networkLogArtifact = await writeEvidenceArtifactToR2AndD1({
    d1,
    r2,
    scanId,
    pageId,
    kind: "network_log",
    payload: networkLogPayload,
    contentType: "application/json; charset=utf-8",
    extension: "json",
    metadata: {
      desktopTotalRequests: capture.desktop.networkSummary.totalRequests,
      mobileTotalRequests: capture.mobile.networkSummary.totalRequests,
      desktopFailedRequestCount:
        capture.desktop.networkSummary.failedRequests.length,
      mobileFailedRequestCount:
        capture.mobile.networkSummary.failedRequests.length,
    },
    nowMs,
  });
  artifacts.push(networkLogArtifact);
  totalBytesWritten += networkLogArtifact.byteSize;

  // 6. Console & pageerror log (`scans/{scanId}/pages/{pageId}/console_log.json`)
  const consoleLogPayload = JSON.stringify(
    {
      desktop: capture.desktop.consoleEntries,
      mobile: capture.mobile.consoleEntries,
    },
    null,
    2,
  );
  const consoleLogArtifact = await writeEvidenceArtifactToR2AndD1({
    d1,
    r2,
    scanId,
    pageId,
    kind: "console_log",
    payload: consoleLogPayload,
    contentType: "application/json; charset=utf-8",
    extension: "json",
    metadata: {
      desktopEntryCount: capture.desktop.consoleEntries.length,
      mobileEntryCount: capture.mobile.consoleEntries.length,
    },
    nowMs,
  });
  artifacts.push(consoleLogArtifact);
  totalBytesWritten += consoleLogArtifact.byteSize;

  // 7. Optional element screenshots (`scans/{scanId}/pages/{pageId}/screenshot_element_{suffix}.{ext}`)
  for (const elem of params.elementScreenshots ?? []) {
    const elemContentType = elem.contentType ?? "image/png";
    const elemArtifact = await writeEvidenceArtifactToR2AndD1({
      d1,
      r2,
      scanId,
      pageId,
      kind: "screenshot_element",
      payload: elem.screenshot,
      contentType: elemContentType,
      extension: elemContentType === "image/webp" ? "webp" : "png",
      suffix: elem.suffix,
      metadata: {
        viewport: elem.viewport,
        selector: elem.selector,
        width: elem.width,
        height: elem.height,
      },
      nowMs,
    });
    artifacts.push(elemArtifact);
    totalBytesWritten += elemArtifact.byteSize;
  }

  // Increment `r2BytesWritten` in `scans.usage_json`
  try {
    const scanRow = await d1
      .prepare(`SELECT usage_json FROM scans WHERE id = ? LIMIT 1`)
      .bind(scanId)
      .first<{ usage_json: string }>();
    let usage: ScanUsageJson = {};
    if (scanRow?.usage_json) {
      try {
        usage = JSON.parse(scanRow.usage_json) as ScanUsageJson;
      } catch {
        usage = {};
      }
    }
    usage.r2BytesWritten = (usage.r2BytesWritten ?? 0) + totalBytesWritten;
    await d1
      .prepare(`UPDATE scans SET usage_json = ?, updated_at = ? WHERE id = ?`)
      .bind(JSON.stringify(usage), nowMs, scanId)
      .run();
  } catch {
    // Non-fatal if usage_json update fails
  }

  return {
    scanId,
    pageId,
    artifacts,
    totalBytesWritten,
  };
}

/**
 * Lists persisted `evidence_artifacts` rows in D1 for a given scan (and optional `pageId`).
 */
export async function listScanEvidenceArtifactsInD1(
  d1: D1DatabaseLike,
  scanId: string,
  pageId?: string,
): Promise<PersistedEvidenceArtifact[]> {
  const stmt = pageId
    ? d1
        .prepare(
          `SELECT id, scan_id, page_id, kind, r2_key, byte_size, sha256, metadata_json, created_at
           FROM evidence_artifacts
           WHERE scan_id = ? AND page_id = ?
           ORDER BY created_at ASC, id ASC`,
        )
        .bind(scanId, pageId)
    : d1
        .prepare(
          `SELECT id, scan_id, page_id, kind, r2_key, byte_size, sha256, metadata_json, created_at
           FROM evidence_artifacts
           WHERE scan_id = ?
           ORDER BY created_at ASC, id ASC`,
        )
        .bind(scanId);

  const res = stmt.all
    ? await stmt.all<Record<string, unknown>>()
    : { success: true, results: [] };

  return (res.results ?? []).map(mapEvidenceArtifactRow);
}

function mapEvidenceArtifactRow(
  row: Record<string, unknown>,
): PersistedEvidenceArtifact {
  const kind = String(row.kind) as EvidenceArtifactKind;
  const metadataJson = String(row.metadata_json ?? "{}");
  let parsedMeta: Record<string, unknown> = {};
  try {
    parsedMeta = JSON.parse(metadataJson) as Record<string, unknown>;
  } catch {
    parsedMeta = {};
  }
  const defaultContentType =
    DEFAULT_KIND_CONTENT_TYPES[kind]?.contentType ?? "application/octet-stream";
  const contentType =
    typeof parsedMeta.contentType === "string" && parsedMeta.contentType
      ? parsedMeta.contentType
      : defaultContentType;

  return {
    id: String(row.id),
    scanId: String(row.scan_id),
    pageId:
      row.page_id !== null && row.page_id !== undefined
        ? String(row.page_id)
        : null,
    kind,
    r2Key: String(row.r2_key),
    contentType,
    byteSize: Number(row.byte_size ?? 0),
    sha256: String(row.sha256),
    metadata: {
      ...parsedMeta,
      contentType,
    },
    metadataJson,
    createdAt: Number(row.created_at ?? 0),
  };
}

/**
 * Verifies the `THE-178` completeness invariant:
 * Every captured (`captured` or `partial`) page in a scan must have `html`, `headers`,
 * `screenshot_desktop`, and `screenshot_mobile` artifacts recorded in D1 (and optionally verified in R2),
 * and every non-captured (`failed` or `skipped`) page must have an explicit `failure_reason` in D1.
 */
export async function verifyScanEvidenceCompletenessInD1(
  d1: D1DatabaseLike,
  scanId: string,
  r2?: R2BucketLike,
): Promise<ScanEvidenceCompletenessReport> {
  const pagesStmt = d1
    .prepare(
      `SELECT id, normalized_url, capture_status, failure_reason
       FROM pages
       WHERE scan_id = ?
       ORDER BY created_at ASC`,
    )
    .bind(scanId);
  const pagesRes = pagesStmt.all
    ? await pagesStmt.all<{
        id: string;
        normalized_url: string;
        capture_status: string;
        failure_reason: string | null;
      }>()
    : { success: true, results: [] };

  const pages = pagesRes.results ?? [];
  const artifacts = await listScanEvidenceArtifactsInD1(d1, scanId);
  const artifactsByPage = new Map<string, PersistedEvidenceArtifact[]>();
  for (const artifact of artifacts) {
    if (!artifact.pageId) continue;
    const list = artifactsByPage.get(artifact.pageId) ?? [];
    list.push(artifact);
    artifactsByPage.set(artifact.pageId, list);
  }

  const requiredKinds: readonly EvidenceArtifactKind[] = [
    "html",
    "headers",
    "screenshot_desktop",
    "screenshot_mobile",
  ];

  const violations: ScanEvidenceCompletenessReport["violations"] = [];
  let capturedPagesChecked = 0;
  let nonCapturedPagesChecked = 0;

  for (const page of pages) {
    if (
      page.capture_status === "captured" ||
      page.capture_status === "partial"
    ) {
      capturedPagesChecked += 1;
      const pageArtifacts = artifactsByPage.get(page.id) ?? [];
      for (const reqKind of requiredKinds) {
        const matching = pageArtifacts.find((a) => a.kind === reqKind);
        if (!matching) {
          violations.push({
            pageId: page.id,
            normalizedUrl: page.normalized_url,
            captureStatus: page.capture_status,
            issue: `Missing required '${reqKind}' evidence artifact in D1.`,
          });
          continue;
        }
        if (matching.sha256.length !== 64) {
          violations.push({
            pageId: page.id,
            normalizedUrl: page.normalized_url,
            captureStatus: page.capture_status,
            issue: `Invalid SHA-256 checksum length on '${reqKind}' artifact (${matching.id}).`,
          });
        }
        if (r2) {
          const headMeta = await r2.head(matching.r2Key);
          if (!headMeta) {
            violations.push({
              pageId: page.id,
              normalizedUrl: page.normalized_url,
              captureStatus: page.capture_status,
              issue: `Missing R2 object '${matching.r2Key}' for '${reqKind}' artifact.`,
            });
          }
        }
      }
    } else {
      nonCapturedPagesChecked += 1;
      if (!page.failure_reason || page.failure_reason.trim().length === 0) {
        violations.push({
          pageId: page.id,
          normalizedUrl: page.normalized_url,
          captureStatus: page.capture_status,
          issue: `Page has capture_status='${page.capture_status}' without an explicit failure_reason in D1.`,
        });
      }
    }
  }

  return {
    complete: violations.length === 0 && pages.length > 0,
    totalPages: pages.length,
    capturedPagesChecked,
    nonCapturedPagesChecked,
    violations,
  };
}

async function computeHmacSha256Hex(
  secret: string,
  message: string,
): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret) as unknown as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    enc.encode(message) as unknown as BufferSource,
  );
  const sigBytes = new Uint8Array(sigBuffer);
  let hex = "";
  for (const b of sigBytes) {
    hex += b.toString(16).padStart(2, "0");
  }
  return hex;
}

function timingSafeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Generates a short-lived HMAC-SHA256 signed token (`{expiresAtMs}.{signatureHex}`)
 * scoped to a specific `{artifactId, scanId, workspaceId}` tuple.
 */
export async function createSignedEvidenceToken(params: {
  artifactId: string;
  scanId: string;
  workspaceId: string;
  expiresAtMs: number;
  secret: string;
}): Promise<string> {
  if (!params.secret || params.secret.trim().length === 0) {
    throw new Error("A non-empty signing secret is required.");
  }
  const exp = Math.floor(params.expiresAtMs);
  const payload = `v1:${params.artifactId}:${params.scanId}:${params.workspaceId}:${exp}`;
  const sig = await computeHmacSha256Hex(params.secret, payload);
  return `${exp}.${sig}`;
}

/**
 * Verifies a short-lived HMAC-SHA256 signed evidence token against `{artifactId, scanId, workspaceId}`
 * and the current timestamp (`nowMs`).
 */
export async function verifySignedEvidenceToken(params: {
  token: string;
  artifactId: string;
  scanId: string;
  workspaceId: string;
  secret: string;
  nowMs?: number;
}): Promise<{ valid: boolean; reason?: string; expiresAtMs?: number }> {
  const nowMs = params.nowMs ?? Date.now();
  if (!params.secret || params.secret.trim().length === 0) {
    return { valid: false, reason: "Missing evidence signing secret." };
  }

  const trimmed = params.token.trim();
  const dotIndex = trimmed.indexOf(".");
  if (dotIndex <= 0) {
    return { valid: false, reason: "Malformed evidence token format." };
  }

  const expStr = trimmed.slice(0, dotIndex);
  const providedSig = trimmed.slice(dotIndex + 1).toLowerCase();
  const expiresAtMs = Number(expStr);

  if (
    !Number.isFinite(expiresAtMs) ||
    !Number.isInteger(expiresAtMs) ||
    !/^[0-9a-f]{64}$/.test(providedSig)
  ) {
    return { valid: false, reason: "Malformed evidence token signature." };
  }

  if (expiresAtMs <= nowMs) {
    return {
      valid: false,
      reason: "Signed evidence token has expired.",
      expiresAtMs,
    };
  }

  const payload = `v1:${params.artifactId}:${params.scanId}:${params.workspaceId}:${expiresAtMs}`;
  const expectedSig = await computeHmacSha256Hex(params.secret, payload);
  if (!timingSafeHexEqual(providedSig, expectedSig)) {
    return {
      valid: false,
      reason: "Invalid signed evidence token signature.",
    };
  }

  return { valid: true, expiresAtMs };
}

/**
 * Builds a short-lived HMAC-signed URL (`/api/evidence/{artifactId}?token={exp}.{sig}`)
 * for embedding evidence artifacts inside report and shared report views.
 */
export async function buildSignedEvidenceUrl(params: {
  artifactId: string;
  scanId: string;
  workspaceId: string;
  secret: string;
  baseUrl?: string;
  ttlSeconds?: number;
  nowMs?: number;
}): Promise<{ url: string; token: string; expiresAtMs: number }> {
  const nowMs = params.nowMs ?? Date.now();
  const ttlSeconds = params.ttlSeconds ?? DEFAULT_EVIDENCE_TOKEN_TTL_SECONDS;
  const expiresAtMs = nowMs + Math.max(1, ttlSeconds) * 1000;
  const token = await createSignedEvidenceToken({
    artifactId: params.artifactId,
    scanId: params.scanId,
    workspaceId: params.workspaceId,
    expiresAtMs,
    secret: params.secret,
  });

  const path = `/api/evidence/${encodeURIComponent(params.artifactId)}?token=${encodeURIComponent(token)}`;
  if (!params.baseUrl) {
    return { url: path, token, expiresAtMs };
  }

  const normalizedBase = params.baseUrl.replace(/\/+$/, "");
  return {
    url: `${normalizedBase}${path}`,
    token,
    expiresAtMs,
  };
}

/**
 * Authorizes access to an evidence artifact via:
 * 1. A short-lived HMAC-signed token (`?token=...`), OR
 * 2. A valid non-revoked, non-expired report share token (`?shareToken=...`), OR
 * 3. Active workspace membership (`requireWorkspaceAccess` with `"viewer"` role)
 * and loads the raw artifact stream/bytes from Cloudflare R2 (`env.EVIDENCE`).
 */
export async function authorizeAndLoadEvidenceArtifact(params: {
  d1: D1DatabaseLike;
  r2: R2BucketLike;
  artifactId: string;
  userId?: string | null;
  shareToken?: string | null;
  signedToken?: string | null;
  signingSecret?: string;
  nowMs?: number;
}): Promise<LoadedEvidenceArtifactStream> {
  const nowMs = params.nowMs ?? Date.now();
  const artifactId = params.artifactId.trim();
  const hasAnyCredential = Boolean(
    params.userId?.trim() ||
    params.shareToken?.trim() ||
    params.signedToken?.trim(),
  );

  if (!hasAnyCredential) {
    throw new EvidenceAccessError(
      "EVIDENCE_FORBIDDEN",
      "Authentication, a valid share token, or a signed evidence token is required to access scan evidence.",
      403,
    );
  }

  if (!artifactId) {
    throw new EvidenceAccessError(
      "EVIDENCE_NOT_FOUND",
      "Evidence artifact not found.",
      404,
    );
  }

  const rawRow = await params.d1
    .prepare(
      `SELECT
         ea.id,
         ea.scan_id,
         ea.page_id,
         ea.kind,
         ea.r2_key,
         ea.byte_size,
         ea.sha256,
         ea.metadata_json,
         ea.created_at,
         s.workspace_id
       FROM evidence_artifacts ea
       INNER JOIN scans s ON s.id = ea.scan_id
       WHERE ea.id = ?
       LIMIT 1`,
    )
    .bind(artifactId)
    .first<Record<string, unknown>>();

  if (!rawRow) {
    throw new EvidenceAccessError(
      "EVIDENCE_NOT_FOUND",
      "Evidence artifact not found.",
      404,
    );
  }

  const mapped = mapEvidenceArtifactRow(rawRow);
  const workspaceId = String(rawRow.workspace_id);
  let authorizedVia: LoadedEvidenceArtifactStream["authorizedVia"] | null =
    null;

  // 1. Check short-lived HMAC-signed token if provided
  if (params.signedToken && params.signedToken.trim().length > 0) {
    const verification = await verifySignedEvidenceToken({
      token: params.signedToken,
      artifactId: mapped.id,
      scanId: mapped.scanId,
      workspaceId,
      secret: params.signingSecret ?? "",
      nowMs,
    });
    if (!verification.valid) {
      throw new EvidenceAccessError(
        "INVALID_EVIDENCE_TOKEN",
        verification.reason ?? "Invalid or expired signed evidence token.",
        403,
      );
    }
    authorizedVia = "signed_token";
  }

  // 2. Check report share token if provided and not yet authorized
  if (
    !authorizedVia &&
    params.shareToken &&
    params.shareToken.trim().length > 0
  ) {
    const shareRow = await params.d1
      .prepare(
        `SELECT rs.id, rs.expires_at, rs.revoked_at
         FROM report_shares rs
         INNER JOIN reports r ON r.id = rs.report_id
         WHERE rs.share_token = ? AND r.scan_id = ?
         LIMIT 1`,
      )
      .bind(params.shareToken.trim(), mapped.scanId)
      .first<{
        id: string;
        expires_at: number | null;
        revoked_at: number | null;
      }>();

    if (
      !shareRow ||
      shareRow.revoked_at !== null ||
      (shareRow.expires_at !== null && shareRow.expires_at <= nowMs)
    ) {
      throw new EvidenceAccessError(
        "INVALID_SHARE_TOKEN",
        "Report share token is invalid, expired, or has been revoked.",
        403,
      );
    }
    authorizedVia = "share_token";
  }

  // 3. Check authenticated workspace session membership if not yet authorized
  if (!authorizedVia) {
    if (!params.userId || params.userId.trim().length === 0) {
      throw new EvidenceAccessError(
        "EVIDENCE_FORBIDDEN",
        "Authentication is required to view workspace evidence.",
        403,
      );
    }
    try {
      await requireWorkspaceAccess(
        params.d1,
        params.userId.trim(),
        workspaceId,
        "viewer",
      );
      authorizedVia = "workspace_session";
    } catch (err) {
      if (err instanceof WorkspaceAccessError) {
        throw new EvidenceAccessError("EVIDENCE_FORBIDDEN", err.message, 403);
      }
      throw err;
    }
  }

  // Load object from R2
  if (typeof params.r2.get !== "function") {
    throw new PlatformBindingError(
      "STORAGE_READ_FAILED",
      "EVIDENCE",
      "Cloudflare R2 binding 'EVIDENCE' does not support object reads (get).",
    );
  }

  let r2Obj;
  try {
    r2Obj = await params.r2.get(mapped.r2Key);
  } catch (err) {
    const reason =
      err instanceof Error ? err.message : "Unknown R2 storage read error";
    throw new PlatformBindingError(
      "STORAGE_READ_FAILED",
      "EVIDENCE",
      `Failed to read evidence object from R2 (${mapped.r2Key}): ${reason}`,
      { cause: err },
    );
  }

  if (!r2Obj) {
    throw new EvidenceAccessError(
      "EVIDENCE_OBJECT_MISSING",
      `Evidence object '${mapped.r2Key}' was not found in R2 storage.`,
      404,
    );
  }

  const contentType =
    r2Obj.httpMetadata?.contentType ||
    mapped.contentType ||
    "application/octet-stream";

  const body: ReadableStream<Uint8Array> | Uint8Array = r2Obj.body
    ? r2Obj.body
    : new Uint8Array(await r2Obj.arrayBuffer());

  return {
    artifact: {
      ...mapped,
      workspaceId,
    },
    body,
    contentType,
    byteSize: mapped.byteSize,
    etag: `"${mapped.sha256}"`,
    cacheControl: EVIDENCE_CACHE_CONTROL_HEADER,
    authorizedVia,
  };
}
