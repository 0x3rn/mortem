# ADR-0004: Authentication, Workspace Model, and Server-Side RBAC on D1

- **Status:** Accepted
- **Date:** 2026-10-14
- **Issue:** `THE-171`

## Context

Mortem is a workspace-scoped SaaS product where every site, scan, report, finding, and share link belongs to a workspace. At launch, every user owns a personal workspace (`owner`), while the data model must natively support multi-member workspaces (`owner`, `admin`, `member`, `viewer`) for the Agency Toolkit (`Milestone 09`) and one-time claim tokens so anonymous single-report buyers (`Milestone 08`) can attach a purchased report to a workspace after signing up or signing in.

Authentication and session management must run natively inside the Cloudflare Worker runtime (`workerd`) backed by Cloudflare D1 (`env.DB`) without external auth SaaS dependencies or Node-only TCP database drivers.

## Decision

### 1. Better Auth + Drizzle D1 Adapter (`usePlural: true`, `transaction: false`)

- `apps/web` uses **Better Auth** (`better-auth` + `@better-auth/drizzle-adapter`) backed by `drizzle-orm/d1` on `env.DB`.
- Better Auth is configured with:
  - Email/password authentication (`emailAndPassword: { enabled: true }`) including password reset token issuance and verification via the `verifications` table.
  - Google OAuth social provider (`socialProviders.google`, enabled whenever `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are configured).
  - HTTP-only signed session cookies (`better-auth.session_token`) backed by the `sessions` D1 table with automatic session expiry enforcement.
  - `transaction: false` in `drizzleAdapter` because Cloudflare D1 executes atomic multi-statement writes via `db.batch([...])` rather than interactive SQL `BEGIN TRANSACTION` blocks.

### 2. D1 Relational Tables (`0001_auth_and_workspaces.sql`)

- `users`: `id`, `name`, `email` (unique), `email_verified`, `image`, `default_workspace_id`, `created_at`, `updated_at`.
- `sessions`: `id`, `user_id` (`REFERENCES users(id) ON DELETE CASCADE`), `token` (unique), `expires_at`, `ip_address`, `user_agent`, `active_workspace_id` (`REFERENCES workspaces(id) ON DELETE SET NULL`), `created_at`, `updated_at`.
- `accounts`: `id`, `user_id` (`REFERENCES users(id) ON DELETE CASCADE`), `account_id`, `provider_id`, OAuth token fields, `password` (scrypt hash), `created_at`, `updated_at`.
- `verifications`: `id`, `identifier`, `value`, `expires_at`, `created_at`, `updated_at`.
- `workspaces`: `id`, `name`, `slug` (unique), `owner_user_id` (`REFERENCES users(id) ON DELETE RESTRICT`), `plan` (`'free' | 'single' | 'starter' | 'growth' | 'agency'`), `created_at`, `updated_at`.
- `workspace_memberships`: `id`, `workspace_id` (`REFERENCES workspaces(id) ON DELETE CASCADE`), `user_id` (`REFERENCES users(id) ON DELETE CASCADE`), `role` (`'owner' | 'admin' | 'member' | 'viewer'`), `created_at`, `updated_at`, with `UNIQUE(workspace_id, user_id)`.
- `workspace_claim_tokens`: `id`, `token_hash` (unique SHA-256 hex digest of the raw claim token), `resource_type` (`'scan' | 'report'`), `resource_id`, `purchaser_email`, `claimed_by_workspace_id`, `claimed_by_user_id`, `expires_at`, `claimed_at`, `created_at`.

### 3. Automatic Personal Workspace Provisioning

- A `databaseHooks.user.create.after` hook on Better Auth (backed by the idempotent `provisionPersonalWorkspace(db, user)` helper in `@mortem/core`) automatically creates a personal workspace and an `owner` membership row in `workspace_memberships` and sets `users.default_workspace_id` whenever a new user signs up via email/password or Google OAuth.

### 4. Server-Side RBAC (`requireWorkspaceAccess`)

- Authorization is enforced exclusively on the server using `requireWorkspaceAccess(db, userId, workspaceId, minRole)` in `@mortem/core`.
- Role hierarchy ranks:
  - `viewer`: `1` (read-only access to workspace scans and reports)
  - `member`: `2` (trigger scans, claim reports, manage findings)
  - `admin`: `3` (manage sites, schedules, alerts, and non-owner members)
  - `owner`: `4` (billing, plan changes, workspace deletion, full control)
- Any attempt by a user to read or mutate a workspace where they have no membership row fails closed with `WorkspaceAccessError` (`403 FORBIDDEN_NOT_A_MEMBER`), guaranteeing strict tenant isolation.

### 5. Anonymous Report Claim Token Protocol

- When an anonymous visitor purchases a Single Autopsy report (`Milestone 08`), Mortem issues a high-entropy token (`mrtm_claim_<random>`) via `issueWorkspaceClaimToken(db, ...)`. Only its SHA-256 hash (`token_hash`) is persisted in `workspace_claim_tokens`.
- After signing up or signing in, the user redeems the token into their workspace via `redeemWorkspaceClaimToken(db, { rawToken, userId, workspaceId })`, which enforces `requireWorkspaceAccess(db, userId, workspaceId, "member")`, validates token expiry and single-use status, and atomically records `claimed_by_workspace_id`, `claimed_by_user_id`, and `claimed_at`.

### 6. Cloudflare Turnstile Gate & 5-Minute Email Confirmation Code (OTP)

- Both `/sign-up` and `/sign-in` render an explicit **Cloudflare Turnstile** widget (`NEXT_PUBLIC_TURNSTILE_SITE_KEY`). The submit button (`Create workspace & account` / `Sign in to workspace`) remains disabled (`disabled={submitting || !turnstileToken}`) and visually greyed out until the Turnstile challenge completes.
- Direct `POST /api/auth/sign-in/email` and `POST /api/auth/sign-up/email` requests are blocked with `403 otp_required` whenever `TURNSTILE_SECRET_KEY` is configured.
- Authentication proceeds through a two-step OTP handshake (`packages/core/src/email-otp.ts`):
  1. `POST /api/auth/email-otp/send`:
     - Verifies the Turnstile token via Cloudflare `https://challenges.cloudflare.com/turnstile/v0/siteverify` using `TURNSTILE_SECRET_KEY` (skipped only for in-flow `isResend: true` requests).
     - Pre-validates account state (rejecting existing emails on `sign-up` with `409` or wrong credentials on `sign-in` with `401` before sending an email).
     - Issues a 6-digit numeric OTP code (`EMAIL_OTP_TTL_MS = 300_000` ms = 5 minutes), invalidates any previous active code for `(mode, email)` in D1 `verifications` (`identifier = "mortem_otp:${mode}:${email}"`), stores only its SHA-256 digest (`codeHash`), and delivers the code via Resend (`RESEND_API_KEY`, `MORTEM_EMAIL_FROM="mortem@corstack.dev"`).
  2. `POST /api/auth/email-otp/verify`:
     - Rejects expired codes (`nowMs > expires_at`) with `410 otp_expired` and immediately deletes the row from `verifications`.
     - Enforces a 5-attempt brute-force cap (`429 otp_max_attempts`), deletes the row upon successful verification (single-use), completes the Better Auth `sign-up` or `sign-in` session creation, and marks `users.email_verified = 1`.
