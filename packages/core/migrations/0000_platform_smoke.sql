-- Migration 0000: Platform smoke test verification table (THE-213)
CREATE TABLE IF NOT EXISTS _platform_smoke_runs (
  id TEXT PRIMARY KEY NOT NULL,
  target_url TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'completed', 'failed')),
  r2_object_key TEXT,
  r2_byte_size INTEGER,
  browser_title TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_platform_smoke_runs_status
  ON _platform_smoke_runs (status, created_at);
