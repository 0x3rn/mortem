# Mortem Cloudflare D1 Entity-Relationship Diagram

This document is the canonical relational schema reference for Mortem's Cloudflare D1 database (`mortem-db`). It covers both identity/workspace ownership (`0001_auth_and_workspaces.sql`) and the diagnostic crawl, evidence, finding, score, and report pipeline (`0002_scans_evidence_findings_reports.sql`).

## Mermaid ER Diagram

```mermaid
erDiagram
  users ||--o{ workspaces : "owns (owner_user_id)"
  users ||--o{ workspace_memberships : "has"
  users ||--o{ sessions : "authenticates"
  users ||--o{ accounts : "links"
  workspaces ||--o{ workspace_memberships : "grants access"
  workspaces ||--o{ workspace_claim_tokens : "claims into"
  workspaces ||--o{ sites : "tracks"
  workspaces ||--o{ scans : "owns"
  workspaces ||--o{ reports : "owns"
  workspaces ||--o{ report_shares : "scopes"

  sites ||--o{ scans : "runs"
  scans ||--o{ scan_events : "emits"
  scans ||--o{ pages : "discovers & captures"
  scans ||--o{ evidence_artifacts : "stores in R2"
  scans ||--o{ findings : "detects"
  scans ||--o{ scores : "computes"
  scans ||--|| reports : "produces"

  pages ||--o{ evidence_artifacts : "captures"
  pages ||--o{ finding_occurrences : "exhibits"
  findings ||--o{ finding_occurrences : "instantiates"
  evidence_artifacts ||--o{ finding_occurrences : "proves (ON DELETE RESTRICT)"
  evidence_artifacts ||--o| reports : "exports PDF (pdf_artifact_id)"
  reports ||--o{ report_shares : "shares via token"

  users {
    text id PK
    text name
    text email UK
    integer email_verified
    text image
    text default_workspace_id
    integer created_at
    integer updated_at
  }

  workspaces {
    text id PK
    text name
    text slug UK
    text owner_user_id FK
    text plan "free | single | starter | growth | agency"
    integer created_at
    integer updated_at
  }

  workspace_memberships {
    text id PK
    text workspace_id FK
    text user_id FK
    text role "viewer | member | admin | owner"
    integer created_at
    integer updated_at
  }

  sites {
    text id PK
    text workspace_id FK
    text origin
    text display_name
    text schedule_cron
    integer schedule_enabled
    integer last_scanned_at
    integer created_at
    integer updated_at
  }

  scans {
    text id PK
    text workspace_id FK
    text site_id FK
    text target_url
    text normalized_url
    text status "queued -> discovering -> capturing -> checking -> scoring -> generating_report -> complete | partial | failed"
    text failure_class
    text failure_reason
    text options_json
    text scoring_version
    text budgets_json
    text usage_json
    integer started_at
    integer completed_at
    integer created_at
    integer updated_at
  }

  scan_events {
    text id PK
    text scan_id FK
    text stage
    text message
    integer pages_discovered
    integer pages_captured
    integer checks_completed
    text metadata_json
    integer created_at
  }

  pages {
    text id PK
    text scan_id FK
    text url
    text normalized_url
    text template_type "home | pricing | product | contact | auth | blog | docs | legal | other"
    integer status_code
    text redirect_chain_json
    text load_timings_json
    text capture_status "pending | captured | partial | failed | skipped"
    text failure_reason
    integer created_at
    integer updated_at
  }

  evidence_artifacts {
    text id PK
    text scan_id FK
    text page_id FK
    text kind "html | screenshot_desktop | screenshot_mobile | screenshot_element | headers | network_log | console_log | psi_raw | axe_raw | pdf"
    text r2_key
    integer byte_size
    text sha256
    text metadata_json
    integer created_at
  }

  findings {
    text id PK
    text scan_id FK
    text check_id
    text check_version
    text category "performance | conversion | seo | accessibility | mobile | security | links_assets"
    text severity "critical | high | medium | low | info"
    text effort "low | medium | high"
    text impact "low | medium | high | critical"
    real priority_score
    text title
    text measured_value_json
    text threshold_json
    text fix_role "developer | designer | marketer | content | devops"
    text status "open | acknowledged | resolved | ignored"
    integer created_at
    integer updated_at
  }

  finding_occurrences {
    text id PK
    text finding_id FK
    text page_id FK
    text evidence_artifact_id FK
    text selector
    text excerpt
    text bbox_json
    integer created_at
  }

  scores {
    text id PK
    text scan_id FK
    text category
    integer score "0..100 when included=1, NULL when included=0"
    real weight
    integer included "1 | 0"
    text exclusion_reason "NULL when included=1, required when included=0"
    text scoring_version
    integer created_at
  }

  reports {
    text id PK
    text scan_id FK, UK
    text workspace_id FK
    text scoring_version
    integer overall_score
    text summary_json
    text ai_content_json
    integer unlocked
    text pdf_artifact_id FK
    integer created_at
    integer updated_at
  }

  report_shares {
    text id PK
    text report_id FK
    text workspace_id FK
    text share_token UK
    text created_by_user_id FK
    integer expires_at
    integer revoked_at
    integer created_at
  }
```

## Key Relational Invariants

1. **Workspace Isolation (`workspace_id`)**:
   Every `sites`, `scans`, `reports`, and `report_shares` row belongs to a `workspaces.id` with `ON DELETE CASCADE`.
2. **Evidence-Backed Findings (`finding_occurrences`)**:
   Every `finding_occurrences` row requires non-null foreign keys to `findings(id)`, `pages(id)`, and `evidence_artifacts(id)` (`ON DELETE RESTRICT` on `evidence_artifact_id` so raw proof in R2/D1 cannot be orphaned while a finding references it).
3. **Provenance-Backed Category Scores (`scores`)**:
   Enforced via SQL `CHECK` constraint and `validateCategoryScoreInput`:
   - When `included = 1`: `score` must be an integer in `[0, 100]` and `exclusion_reason` must be `NULL`.
   - When `included = 0` (partial scan): `score` must be `NULL` and `exclusion_reason` must be a non-empty string explaining why the category was excluded.
