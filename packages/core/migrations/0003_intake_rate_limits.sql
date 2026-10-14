-- Migration number: 0003 	 2026-10-14T02:35:00.000Z
-- THE-173: Per-workspace, per-IP, and per-target-host scan intake rate-limit tracking.

CREATE TABLE IF NOT EXISTS scan_intake_events (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ip_hash TEXT NOT NULL,
  target_host TEXT NOT NULL,
  scan_id TEXT REFERENCES scans(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scan_intake_events_workspace_created
  ON scan_intake_events(workspace_id, created_at);
CREATE INDEX IF NOT EXISTS idx_scan_intake_events_ip_created
  ON scan_intake_events(ip_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_scan_intake_events_host_created
  ON scan_intake_events(target_host, created_at);
