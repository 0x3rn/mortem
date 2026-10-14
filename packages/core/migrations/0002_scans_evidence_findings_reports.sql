-- Migration number: 0002 	 2026-10-14T02:20:00.000Z
-- THE-172: Core D1 schema for sites, scans, scan_events, pages, evidence_artifacts,
-- findings, finding_occurrences, scores, reports, and report_shares.

CREATE TABLE IF NOT EXISTS sites (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  origin TEXT NOT NULL,
  display_name TEXT NOT NULL,
  schedule_cron TEXT,
  schedule_enabled INTEGER NOT NULL DEFAULT 0 CHECK (schedule_enabled IN (0, 1)),
  last_scanned_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sites_workspace_origin
  ON sites(workspace_id, origin);
CREATE INDEX IF NOT EXISTS idx_sites_workspace_id
  ON sites(workspace_id);

CREATE TABLE IF NOT EXISTS scans (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  target_url TEXT NOT NULL,
  normalized_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (
    status IN (
      'queued',
      'discovering',
      'capturing',
      'checking',
      'scoring',
      'generating_report',
      'complete',
      'partial',
      'failed'
    )
  ),
  failure_class TEXT CHECK (
    failure_class IS NULL OR failure_class IN (
      'ssrf_blocked',
      'dns_resolution_failed',
      'robots_disallowed',
      'navigation_timeout',
      'browser_crash',
      'upstream_blocked',
      'budget_exceeded',
      'internal_error'
    )
  ),
  failure_reason TEXT,
  options_json TEXT NOT NULL DEFAULT '{}',
  scoring_version TEXT NOT NULL DEFAULT 'v1.0.0',
  budgets_json TEXT NOT NULL DEFAULT '{}',
  usage_json TEXT NOT NULL DEFAULT '{}',
  started_at INTEGER,
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scans_workspace_id
  ON scans(workspace_id);
CREATE INDEX IF NOT EXISTS idx_scans_site_id
  ON scans(site_id);
CREATE INDEX IF NOT EXISTS idx_scans_status
  ON scans(status);
CREATE INDEX IF NOT EXISTS idx_scans_workspace_status
  ON scans(workspace_id, status);

CREATE TABLE IF NOT EXISTS scan_events (
  id TEXT PRIMARY KEY NOT NULL,
  scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  stage TEXT NOT NULL CHECK (
    stage IN (
      'queued',
      'discovering',
      'capturing',
      'checking',
      'scoring',
      'generating_report',
      'complete',
      'partial',
      'failed'
    )
  ),
  message TEXT NOT NULL,
  pages_discovered INTEGER NOT NULL DEFAULT 0 CHECK (pages_discovered >= 0),
  pages_captured INTEGER NOT NULL DEFAULT 0 CHECK (pages_captured >= 0),
  checks_completed INTEGER NOT NULL DEFAULT 0 CHECK (checks_completed >= 0),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scan_events_scan_id
  ON scan_events(scan_id, created_at);

CREATE TABLE IF NOT EXISTS pages (
  id TEXT PRIMARY KEY NOT NULL,
  scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  normalized_url TEXT NOT NULL,
  template_type TEXT NOT NULL DEFAULT 'other' CHECK (
    template_type IN (
      'home',
      'pricing',
      'product',
      'contact',
      'auth',
      'blog',
      'docs',
      'legal',
      'other'
    )
  ),
  status_code INTEGER,
  redirect_chain_json TEXT NOT NULL DEFAULT '[]',
  load_timings_json TEXT NOT NULL DEFAULT '{}',
  capture_status TEXT NOT NULL DEFAULT 'pending' CHECK (
    capture_status IN ('pending', 'captured', 'partial', 'failed', 'skipped')
  ),
  failure_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pages_scan_id
  ON pages(scan_id);
CREATE INDEX IF NOT EXISTS idx_pages_scan_status
  ON pages(scan_id, capture_status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pages_scan_normalized_url
  ON pages(scan_id, normalized_url);

CREATE TABLE IF NOT EXISTS evidence_artifacts (
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
      'pdf'
    )
  ),
  r2_key TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_evidence_artifacts_scan_id
  ON evidence_artifacts(scan_id);
CREATE INDEX IF NOT EXISTS idx_evidence_artifacts_page_id
  ON evidence_artifacts(page_id);
CREATE INDEX IF NOT EXISTS idx_evidence_artifacts_scan_kind
  ON evidence_artifacts(scan_id, kind);

CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY NOT NULL,
  scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  check_id TEXT NOT NULL,
  check_version TEXT NOT NULL DEFAULT '1.0.0',
  category TEXT NOT NULL CHECK (
    category IN (
      'performance',
      'conversion',
      'seo',
      'accessibility',
      'mobile',
      'security',
      'links_assets'
    )
  ),
  severity TEXT NOT NULL CHECK (
    severity IN ('critical', 'high', 'medium', 'low', 'info')
  ),
  effort TEXT NOT NULL CHECK (effort IN ('low', 'medium', 'high')),
  impact TEXT NOT NULL CHECK (impact IN ('low', 'medium', 'high', 'critical')),
  priority_score REAL NOT NULL CHECK (priority_score >= 0 AND priority_score <= 100),
  title TEXT NOT NULL,
  measured_value_json TEXT NOT NULL,
  threshold_json TEXT NOT NULL,
  fix_role TEXT NOT NULL CHECK (
    fix_role IN ('developer', 'designer', 'marketer', 'content', 'devops')
  ),
  status TEXT NOT NULL DEFAULT 'open' CHECK (
    status IN ('open', 'acknowledged', 'resolved', 'ignored')
  ),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_findings_scan_id
  ON findings(scan_id);
CREATE INDEX IF NOT EXISTS idx_findings_scan_category
  ON findings(scan_id, category);
CREATE INDEX IF NOT EXISTS idx_findings_scan_status
  ON findings(scan_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_findings_scan_check
  ON findings(scan_id, check_id);

CREATE TABLE IF NOT EXISTS finding_occurrences (
  id TEXT PRIMARY KEY NOT NULL,
  finding_id TEXT NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  evidence_artifact_id TEXT NOT NULL REFERENCES evidence_artifacts(id) ON DELETE RESTRICT,
  selector TEXT,
  excerpt TEXT,
  bbox_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_finding_occurrences_finding_id
  ON finding_occurrences(finding_id);
CREATE INDEX IF NOT EXISTS idx_finding_occurrences_page_id
  ON finding_occurrences(page_id);
CREATE INDEX IF NOT EXISTS idx_finding_occurrences_evidence_id
  ON finding_occurrences(evidence_artifact_id);

CREATE TABLE IF NOT EXISTS scores (
  id TEXT PRIMARY KEY NOT NULL,
  scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (
    category IN (
      'performance',
      'conversion',
      'seo',
      'accessibility',
      'mobile',
      'security',
      'links_assets'
    )
  ),
  score INTEGER CHECK (score IS NULL OR (score >= 0 AND score <= 100)),
  weight REAL NOT NULL CHECK (weight >= 0 AND weight <= 1),
  included INTEGER NOT NULL DEFAULT 1 CHECK (included IN (0, 1)),
  exclusion_reason TEXT,
  scoring_version TEXT NOT NULL DEFAULT 'v1.0.0',
  created_at INTEGER NOT NULL,
  CHECK (
    (included = 1 AND score IS NOT NULL AND exclusion_reason IS NULL)
    OR (
      included = 0
      AND score IS NULL
      AND exclusion_reason IS NOT NULL
      AND length(trim(exclusion_reason)) > 0
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_scores_scan_id
  ON scores(scan_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_scores_scan_category
  ON scores(scan_id, category);

CREATE TABLE IF NOT EXISTS reports (
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

CREATE INDEX IF NOT EXISTS idx_reports_workspace_id
  ON reports(workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_scan_id
  ON reports(scan_id);

CREATE TABLE IF NOT EXISTS report_shares (
  id TEXT PRIMARY KEY NOT NULL,
  report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  share_token TEXT NOT NULL UNIQUE,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  expires_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_report_shares_report_id
  ON report_shares(report_id);
CREATE INDEX IF NOT EXISTS idx_report_shares_workspace_id
  ON report_shares(workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_report_shares_token
  ON report_shares(share_token);
