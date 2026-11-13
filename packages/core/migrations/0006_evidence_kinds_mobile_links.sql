-- THE-184: allow two new evidence kinds.
--   mobile_raw : in-browser mobile layout audit (viewport meta, overflow, tap
--                targets, small text, overlays) from the 390x844 capture.
--   links_raw  : reserved for THE-185 (link and asset checks), added now so
--                this rebuild happens only once.
--
-- SQLite cannot change a CHECK constraint in place, so evidence_artifacts is
-- rebuilt. Three tables reference it: finding_occurrences (ON DELETE RESTRICT,
-- changed below to NO ACTION),
-- page_performance_results and reports (ON DELETE SET NULL); report_shares
-- references reports (ON DELETE CASCADE). Dropping a referenced
-- table runs an implicit DELETE that would fire those actions (RESTRICT fails,
-- SET NULL silently clears PSI evidence links), and with foreign keys on
-- SQLite rewrites child references when a parent is renamed. So:
--   1. rename evidence_artifacts aside (children follow the rename),
--   2. create the new evidence_artifacts and copy every row,
--   3. rebuild the child tables pointing at the new table (dropping a table
--      nothing references fires no actions; reports has its own child,
--      report_shares, so it gets the same rename-aside treatment),
--   4. drop the old evidence table, which nothing references any more.
-- Column definitions are copied verbatim from 0002 and 0004.
-- Final check: no table definition may still mention a *_pre_0006 table.
PRAGMA defer_foreign_keys = on;

-- 1.
ALTER TABLE evidence_artifacts RENAME TO evidence_artifacts_pre_0006;

-- 2.
CREATE TABLE evidence_artifacts (
  id TEXT PRIMARY KEY NOT NULL,
  scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  page_id TEXT REFERENCES pages(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (
    kind IN (
      'html',
      'screenshot_desktop',
      'screenshot_mobile',
      'screenshot_element',
      'headers',
      'network_log',
      'console_log',
      'psi_raw',
      'axe_raw',
      'pdf',
      'mobile_raw',
      'links_raw'
    )
  ),
  r2_key TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

INSERT INTO evidence_artifacts (id, scan_id, page_id, kind, r2_key, byte_size, sha256, metadata_json, created_at)
SELECT id, scan_id, page_id, kind, r2_key, byte_size, sha256, metadata_json, created_at FROM evidence_artifacts_pre_0006;

-- 3a. finding_occurrences
CREATE TABLE finding_occurrences_new (
  id TEXT PRIMARY KEY NOT NULL,
  finding_id TEXT NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  -- NO ACTION, not RESTRICT: cited evidence still cannot be deleted on its own,
  -- but the check runs at statement end, so deleting a scan cascades cleanly
  -- whatever order SQLite visits the child tables in (rebuilding
  -- evidence_artifacts changes that order).
  evidence_artifact_id TEXT NOT NULL REFERENCES evidence_artifacts(id) ON DELETE NO ACTION,
  selector TEXT,
  excerpt TEXT,
  bbox_json TEXT,
  created_at INTEGER NOT NULL
);

INSERT INTO finding_occurrences_new (id, finding_id, page_id, evidence_artifact_id, selector, excerpt, bbox_json, created_at)
SELECT id, finding_id, page_id, evidence_artifact_id, selector, excerpt, bbox_json, created_at FROM finding_occurrences;

DROP TABLE finding_occurrences;
ALTER TABLE finding_occurrences_new RENAME TO finding_occurrences;

CREATE INDEX IF NOT EXISTS idx_finding_occurrences_finding_id
  ON finding_occurrences(finding_id);
CREATE INDEX IF NOT EXISTS idx_finding_occurrences_page_id
  ON finding_occurrences(page_id);
CREATE INDEX IF NOT EXISTS idx_finding_occurrences_evidence_id
  ON finding_occurrences(evidence_artifact_id);

-- 3b. page_performance_results
CREATE TABLE page_performance_results_new (
  id TEXT PRIMARY KEY NOT NULL,
  scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  strategy TEXT NOT NULL CHECK (strategy IN ('mobile', 'desktop')),
  status TEXT NOT NULL CHECK (status IN ('ok', 'unavailable')),
  unavailable_reason TEXT CHECK (
    unavailable_reason IS NULL OR unavailable_reason IN (
      'api_key_missing',
      'api_key_rejected',
      'quota_exceeded',
      'timeout',
      'network_error',
      'upstream_error',
      'invalid_request',
      'target_unreachable',
      'lighthouse_runtime_error',
      'invalid_response'
    )
  ),
  unavailable_message TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lighthouse_version TEXT,
  lighthouse_fetch_time TEXT,
  lab_json TEXT,
  field_json TEXT,
  audits_json TEXT NOT NULL DEFAULT '[]',
  navigation_timings_json TEXT,
  psi_evidence_artifact_id TEXT REFERENCES evidence_artifacts(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (
      status = 'ok'
      AND unavailable_reason IS NULL
      AND unavailable_message IS NULL
      AND lab_json IS NOT NULL
      AND field_json IS NOT NULL
    )
    OR (
      status = 'unavailable'
      AND unavailable_reason IS NOT NULL
      AND unavailable_message IS NOT NULL
      AND length(trim(unavailable_message)) > 0
      AND lab_json IS NULL
      AND field_json IS NULL
    )
  )
);

INSERT INTO page_performance_results_new (id, scan_id, page_id, strategy, status, unavailable_reason, unavailable_message, attempts, lighthouse_version, lighthouse_fetch_time, lab_json, field_json, audits_json, navigation_timings_json, psi_evidence_artifact_id, created_at, updated_at)
SELECT id, scan_id, page_id, strategy, status, unavailable_reason, unavailable_message, attempts, lighthouse_version, lighthouse_fetch_time, lab_json, field_json, audits_json, navigation_timings_json, psi_evidence_artifact_id, created_at, updated_at FROM page_performance_results;

DROP TABLE page_performance_results;
ALTER TABLE page_performance_results_new RENAME TO page_performance_results;

CREATE UNIQUE INDEX IF NOT EXISTS idx_page_performance_page_strategy
  ON page_performance_results(page_id, strategy);
CREATE INDEX IF NOT EXISTS idx_page_performance_scan_id
  ON page_performance_results(scan_id);
CREATE INDEX IF NOT EXISTS idx_page_performance_scan_status
  ON page_performance_results(scan_id, status);

-- 3c. reports (references evidence_artifacts) and report_shares (references
--     reports). Same pattern one level down: rename reports aside so
--     report_shares follows it, rebuild report_shares against the new reports,
--     then drop the old reports, which nothing references any more.
ALTER TABLE reports RENAME TO reports_pre_0006;

CREATE TABLE reports (
  id TEXT PRIMARY KEY NOT NULL,
  scan_id TEXT NOT NULL UNIQUE REFERENCES scans(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scoring_version TEXT NOT NULL DEFAULT 'v1.0.0',
  overall_score INTEGER NOT NULL CHECK (overall_score >= 0 AND overall_score <= 100),
  summary_json TEXT NOT NULL DEFAULT '{}',
  ai_content_json TEXT NOT NULL DEFAULT '{}',
  unlocked INTEGER NOT NULL DEFAULT 0 CHECK (unlocked IN (0, 1)),
  pdf_artifact_id TEXT REFERENCES evidence_artifacts(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO reports (id, scan_id, workspace_id, scoring_version, overall_score, summary_json, ai_content_json, unlocked, pdf_artifact_id, created_at, updated_at)
SELECT id, scan_id, workspace_id, scoring_version, overall_score, summary_json, ai_content_json, unlocked, pdf_artifact_id, created_at, updated_at FROM reports_pre_0006;

CREATE TABLE report_shares_new (
  id TEXT PRIMARY KEY NOT NULL,
  report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  share_token TEXT NOT NULL UNIQUE,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  expires_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);

INSERT INTO report_shares_new (id, report_id, workspace_id, share_token, created_by_user_id, expires_at, revoked_at, created_at)
SELECT id, report_id, workspace_id, share_token, created_by_user_id, expires_at, revoked_at, created_at FROM report_shares;

DROP TABLE report_shares;
ALTER TABLE report_shares_new RENAME TO report_shares;

CREATE INDEX IF NOT EXISTS idx_report_shares_report_id
  ON report_shares(report_id);
CREATE INDEX IF NOT EXISTS idx_report_shares_workspace_id
  ON report_shares(workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_report_shares_token
  ON report_shares(share_token);

DROP TABLE reports_pre_0006;

CREATE INDEX IF NOT EXISTS idx_reports_workspace_id
  ON reports(workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_scan_id
  ON reports(scan_id);

-- 4.
DROP TABLE evidence_artifacts_pre_0006;

CREATE INDEX IF NOT EXISTS idx_evidence_artifacts_scan_id
  ON evidence_artifacts(scan_id);
CREATE INDEX IF NOT EXISTS idx_evidence_artifacts_page_id
  ON evidence_artifacts(page_id);
CREATE INDEX IF NOT EXISTS idx_evidence_artifacts_scan_kind
  ON evidence_artifacts(scan_id, kind);
