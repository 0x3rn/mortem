import type { D1DatabaseLike } from "./cloudflare";
import type { DiagnosticCategory, ScanStage } from "./index";
import type {
  PageCaptureStatus,
  PageTemplateType,
  ScanFailureClass,
  ScanStatus,
} from "./schema/scans";

export interface WorkspaceScanHistoryRow {
  id: string;
  workspace_id: string;
  site_id: string;
  site_origin: string | null;
  site_display_name: string | null;
  target_url: string;
  normalized_url: string;
  status: ScanStatus;
  failure_class: ScanFailureClass | null;
  failure_reason: string | null;
  scoring_version: string;
  pages_discovered: number;
  pages_captured: number;
  overall_score: number | null;
  report_id: string | null;
  started_at: number | null;
  completed_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface WorkspaceScanEventRow {
  id: string;
  scan_id: string;
  stage: ScanStage;
  message: string;
  pages_discovered: number;
  pages_captured: number;
  checks_completed: number;
  metadata_json: string;
  created_at: number;
}

export interface WorkspaceScanPageRow {
  id: string;
  scan_id: string;
  url: string;
  normalized_url: string;
  template_type: PageTemplateType;
  status_code: number | null;
  capture_status: PageCaptureStatus;
  failure_reason: string | null;
  created_at: number;
  updated_at: number;
}

export interface WorkspaceScanCategoryScoreRow {
  id: string;
  scan_id: string;
  category: DiagnosticCategory;
  score: number | null;
  weight: number;
  included: boolean;
  exclusion_reason: string | null;
  scoring_version: string;
}

export interface WorkspaceScanReportSummary {
  id: string;
  scan_id: string;
  workspace_id: string;
  scoring_version: string;
  overall_score: number;
  unlocked: boolean;
  created_at: number;
  updated_at: number;
}

export interface WorkspaceScanDetail {
  scan: WorkspaceScanHistoryRow;
  events: WorkspaceScanEventRow[];
  pages: WorkspaceScanPageRow[];
  scores: WorkspaceScanCategoryScoreRow[];
  report: WorkspaceScanReportSummary | null;
}

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function mapScanHistoryRow(
  raw: Record<string, unknown>,
): WorkspaceScanHistoryRow {
  return {
    id: String(raw.id),
    workspace_id: String(raw.workspace_id),
    site_id: String(raw.site_id),
    site_origin:
      raw.site_origin !== null && raw.site_origin !== undefined
        ? String(raw.site_origin)
        : null,
    site_display_name:
      raw.site_display_name !== null && raw.site_display_name !== undefined
        ? String(raw.site_display_name)
        : null,
    target_url: String(raw.target_url),
    normalized_url: String(raw.normalized_url),
    status: String(raw.status) as ScanStatus,
    failure_class:
      raw.failure_class !== null && raw.failure_class !== undefined
        ? (String(raw.failure_class) as ScanFailureClass)
        : null,
    failure_reason:
      raw.failure_reason !== null && raw.failure_reason !== undefined
        ? String(raw.failure_reason)
        : null,
    scoring_version: String(raw.scoring_version ?? "v1.0.0"),
    pages_discovered: Number(raw.pages_discovered ?? 0),
    pages_captured: Number(raw.pages_captured ?? 0),
    overall_score: toNumberOrNull(raw.overall_score),
    report_id:
      raw.report_id !== null && raw.report_id !== undefined
        ? String(raw.report_id)
        : null,
    started_at: toNumberOrNull(raw.started_at),
    completed_at: toNumberOrNull(raw.completed_at),
    created_at: Number(raw.created_at ?? 0),
    updated_at: Number(raw.updated_at ?? 0),
  };
}

/**
 * Lists recent scans strictly scoped to a single workspace (`THE-174`).
 * Joins `sites`, `reports`, and real page capture counts from D1 without fabricating scores.
 */
export async function listWorkspaceScans(
  d1: D1DatabaseLike,
  workspaceId: string,
  limit = 50,
): Promise<WorkspaceScanHistoryRow[]> {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const stmt = d1
    .prepare(
      `SELECT
         s.id,
         s.workspace_id,
         s.site_id,
         st.origin AS site_origin,
         st.display_name AS site_display_name,
         s.target_url,
         s.normalized_url,
         s.status,
         s.failure_class,
         s.failure_reason,
         s.scoring_version,
         (SELECT COUNT(*) FROM pages p WHERE p.scan_id = s.id) AS pages_discovered,
         (SELECT COUNT(*) FROM pages p WHERE p.scan_id = s.id AND p.capture_status = 'captured') AS pages_captured,
         r.overall_score AS overall_score,
         r.id AS report_id,
         s.started_at,
         s.completed_at,
         s.created_at,
         s.updated_at
       FROM scans s
       LEFT JOIN sites st ON st.id = s.site_id
       LEFT JOIN reports r ON r.scan_id = s.id
       WHERE s.workspace_id = ?
       ORDER BY s.created_at DESC, s.rowid DESC
       LIMIT ?`,
    )
    .bind(workspaceId, safeLimit);

  const res = stmt.all
    ? await stmt.all<Record<string, unknown>>()
    : { success: true, results: [] };

  return (res.results ?? []).map(mapScanHistoryRow);
}

/**
 * Loads full scan lifecycle detail for a workspace-scoped scan (`THE-174`).
 * Returns `null` if the scan does not exist or belongs to a different workspace.
 */
export async function getWorkspaceScanDetail(
  d1: D1DatabaseLike,
  workspaceId: string,
  scanId: string,
): Promise<WorkspaceScanDetail | null> {
  const scanStmt = d1
    .prepare(
      `SELECT
         s.id,
         s.workspace_id,
         s.site_id,
         st.origin AS site_origin,
         st.display_name AS site_display_name,
         s.target_url,
         s.normalized_url,
         s.status,
         s.failure_class,
         s.failure_reason,
         s.scoring_version,
         (SELECT COUNT(*) FROM pages p WHERE p.scan_id = s.id) AS pages_discovered,
         (SELECT COUNT(*) FROM pages p WHERE p.scan_id = s.id AND p.capture_status = 'captured') AS pages_captured,
         r.overall_score AS overall_score,
         r.id AS report_id,
         s.started_at,
         s.completed_at,
         s.created_at,
         s.updated_at
       FROM scans s
       LEFT JOIN sites st ON st.id = s.site_id
       LEFT JOIN reports r ON r.scan_id = s.id
       WHERE s.id = ? AND s.workspace_id = ?
       LIMIT 1`,
    )
    .bind(scanId, workspaceId);

  const rawScan = await scanStmt.first<Record<string, unknown>>();
  if (!rawScan) {
    return null;
  }

  const scan = mapScanHistoryRow(rawScan);

  const eventsStmt = d1
    .prepare(
      `SELECT id, scan_id, stage, message, pages_discovered, pages_captured, checks_completed, metadata_json, created_at
       FROM scan_events
       WHERE scan_id = ?
       ORDER BY created_at ASC, rowid ASC`,
    )
    .bind(scanId);
  const eventsRes = eventsStmt.all
    ? await eventsStmt.all<Record<string, unknown>>()
    : { success: true, results: [] };
  const events: WorkspaceScanEventRow[] = (eventsRes.results ?? []).map(
    (row) => ({
      id: String(row.id),
      scan_id: String(row.scan_id),
      stage: String(row.stage) as ScanStage,
      message: String(row.message),
      pages_discovered: Number(row.pages_discovered ?? 0),
      pages_captured: Number(row.pages_captured ?? 0),
      checks_completed: Number(row.checks_completed ?? 0),
      metadata_json: String(row.metadata_json ?? "{}"),
      created_at: Number(row.created_at ?? 0),
    }),
  );

  const pagesStmt = d1
    .prepare(
      `SELECT id, scan_id, url, normalized_url, template_type, status_code, capture_status, failure_reason, created_at, updated_at
       FROM pages
       WHERE scan_id = ?
       ORDER BY created_at ASC, rowid ASC`,
    )
    .bind(scanId);
  const pagesRes = pagesStmt.all
    ? await pagesStmt.all<Record<string, unknown>>()
    : { success: true, results: [] };
  const pages: WorkspaceScanPageRow[] = (pagesRes.results ?? []).map((row) => ({
    id: String(row.id),
    scan_id: String(row.scan_id),
    url: String(row.url),
    normalized_url: String(row.normalized_url),
    template_type: String(row.template_type ?? "other") as PageTemplateType,
    status_code: toNumberOrNull(row.status_code),
    capture_status: String(
      row.capture_status ?? "pending",
    ) as PageCaptureStatus,
    failure_reason:
      row.failure_reason !== null && row.failure_reason !== undefined
        ? String(row.failure_reason)
        : null,
    created_at: Number(row.created_at ?? 0),
    updated_at: Number(row.updated_at ?? 0),
  }));

  const scoresStmt = d1
    .prepare(
      `SELECT id, scan_id, category, score, weight, included, exclusion_reason, scoring_version
       FROM scores
       WHERE scan_id = ?
       ORDER BY category ASC`,
    )
    .bind(scanId);
  const scoresRes = scoresStmt.all
    ? await scoresStmt.all<Record<string, unknown>>()
    : { success: true, results: [] };
  const scores: WorkspaceScanCategoryScoreRow[] = (scoresRes.results ?? []).map(
    (row) => ({
      id: String(row.id),
      scan_id: String(row.scan_id),
      category: String(row.category) as DiagnosticCategory,
      score: toNumberOrNull(row.score),
      weight: Number(row.weight ?? 0),
      included: Number(row.included ?? 0) === 1,
      exclusion_reason:
        row.exclusion_reason !== null && row.exclusion_reason !== undefined
          ? String(row.exclusion_reason)
          : null,
      scoring_version: String(row.scoring_version ?? "v1.0.0"),
    }),
  );

  const reportStmt = d1
    .prepare(
      `SELECT id, scan_id, workspace_id, scoring_version, overall_score, unlocked, created_at, updated_at
       FROM reports
       WHERE scan_id = ? AND workspace_id = ?
       LIMIT 1`,
    )
    .bind(scanId, workspaceId);
  const rawReport = await reportStmt.first<Record<string, unknown>>();
  const report: WorkspaceScanReportSummary | null = rawReport
    ? {
        id: String(rawReport.id),
        scan_id: String(rawReport.scan_id),
        workspace_id: String(rawReport.workspace_id),
        scoring_version: String(rawReport.scoring_version ?? "v1.0.0"),
        overall_score: Number(rawReport.overall_score ?? 0),
        unlocked: Number(rawReport.unlocked ?? 0) === 1,
        created_at: Number(rawReport.created_at ?? 0),
        updated_at: Number(rawReport.updated_at ?? 0),
      }
    : null;

  return {
    scan,
    events,
    pages,
    scores,
    report,
  };
}
