-- Migration number: 0004 	 2026-10-14T20:00:00.000Z
-- THE-180: Per-page, per-strategy PageSpeed Insights results.
-- Lab metrics (Lighthouse) and field metrics (CrUX) are stored separately.
-- A row is either 'ok' (lab data present) or 'unavailable' (explicit reason, no lab data).

CREATE TABLE IF NOT EXISTS page_performance_results (
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_page_performance_page_strategy
  ON page_performance_results(page_id, strategy);
CREATE INDEX IF NOT EXISTS idx_page_performance_scan_id
  ON page_performance_results(scan_id);
CREATE INDEX IF NOT EXISTS idx_page_performance_scan_status
  ON page_performance_results(scan_id, status);
