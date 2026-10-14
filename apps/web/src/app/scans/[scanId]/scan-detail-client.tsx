"use client";

import type {
  ScanStatus,
  WorkspaceAccessContext,
  WorkspaceScanDetail,
} from "@mortem/core";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import {
  formatScanStatusLabel,
  formatScanTimestamp,
  getScanStatusBadgeClass,
} from "@/components/scan-history-table";
import type { AuthenticatedUserSummary } from "@/lib/workspace-session";

interface WorkspaceApiPayload {
  ok: boolean;
  user?: AuthenticatedUserSummary;
  activeWorkspace?: WorkspaceAccessContext;
  workspaces?: WorkspaceAccessContext[];
}

interface ScanDetailApiPayload {
  ok: boolean;
  workspaceId?: string;
  scanDetail?: WorkspaceScanDetail;
  error?: string;
}

const LIFECYCLE_STEPS: Array<{
  stage: ScanStatus;
  title: string;
  description: string;
}> = [
  {
    stage: "queued",
    title: "Queued & Pre-flight Verified",
    description:
      "URL canonicalized, Cloudflare 1.1.1.1 DoH DNS verified against SSRF ranges, and dispatched to SCAN_QUEUE.",
  },
  {
    stage: "discovering",
    title: "Page Discovery",
    description:
      "Inspecting robots.txt, XML sitemaps, and same-origin commercial links (pricing, product, signup, contact).",
  },
  {
    stage: "capturing",
    title: "Dual-Viewport Browser Capture",
    description:
      "Rendering discovered templates in Cloudflare Browser Run at desktop (1440×900) and mobile (390×844).",
  },
  {
    stage: "checking",
    title: "7 Clinical Diagnostic Checks",
    description:
      "Evaluating performance, conversion clarity, SEO, WCAG 2.2 AA accessibility, mobile usability, security, and link health.",
  },
  {
    stage: "scoring",
    title: "Deterministic Scoring",
    description:
      "Computing weighted category and overall 0–100 health scores from measured evidence.",
  },
  {
    stage: "generating_report",
    title: "Report & Fix Generation",
    description:
      "Generating evidence-grounded explanations and stack-aware remediation instructions.",
  },
  {
    stage: "complete",
    title: "Autopsy Finalized",
    description:
      "Report persisted to Cloudflare D1 and immutable evidence artifacts sealed in R2.",
  },
];

const STAGE_ORDER: Record<ScanStatus, number> = {
  queued: 0,
  discovering: 1,
  capturing: 2,
  checking: 3,
  scoring: 4,
  generating_report: 5,
  complete: 6,
  partial: 6,
  failed: 6,
};

export function ScanDetailClient({ scanId }: { scanId: string }) {
  const router = useRouter();
  const [loadingSession, setLoadingSession] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(true);
  const [user, setUser] = useState<AuthenticatedUserSummary | null>(null);
  const [activeWorkspace, setActiveWorkspace] =
    useState<WorkspaceAccessContext | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceAccessContext[]>([]);
  const [detail, setDetail] = useState<WorkspaceScanDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  const loadScanDetail = useCallback(
    async (workspaceId: string) => {
      setLoadingDetail(true);
      setDetailError(null);
      try {
        const response = await fetch(
          `/api/scans/${encodeURIComponent(scanId)}?workspaceId=${encodeURIComponent(workspaceId)}`,
          {
            credentials: "include",
            cache: "no-store",
          },
        );
        const data = (await response
          .json()
          .catch(() => null)) as ScanDetailApiPayload | null;
        if (!response.ok || !data?.ok || !data.scanDetail) {
          setDetail(null);
          setDetailError(
            data?.error ?? "Scan not found in the active workspace.",
          );
          return;
        }
        setDetail(data.scanDetail);
      } catch {
        setDetailError("Network error while loading scan lifecycle details.");
      } finally {
        setLoadingDetail(false);
      }
    },
    [scanId],
  );

  useEffect(() => {
    let cancelled = false;
    async function init() {
      try {
        const response = await fetch("/api/workspaces", {
          credentials: "include",
          cache: "no-store",
        });
        if (!response.ok) {
          if (!cancelled) {
            setLoadingSession(false);
            router.replace(
              `/sign-in?next=${encodeURIComponent(`/scans/${scanId}`)}`,
            );
          }
          return;
        }
        const data = (await response.json()) as WorkspaceApiPayload;
        if (!cancelled && data.ok && data.user && data.activeWorkspace) {
          setUser(data.user);
          setActiveWorkspace(data.activeWorkspace);
          setWorkspaces(data.workspaces ?? [data.activeWorkspace]);
          await loadScanDetail(data.activeWorkspace.workspaceId);
        }
      } finally {
        if (!cancelled) {
          setLoadingSession(false);
        }
      }
    }
    void init();
    return () => {
      cancelled = true;
    };
  }, [loadScanDetail, router, scanId]);

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await fetch("/api/auth/sign-out", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({}),
      });
      router.push("/sign-in");
      router.refresh();
    } finally {
      setSigningOut(false);
    }
  }

  if (loadingSession) {
    return (
      <div className="min-h-screen bg-background text-foreground">
        <main
          id="main-content"
          className="mx-auto max-w-5xl px-4 py-16 sm:px-6"
        >
          <p className="font-mono text-xs text-muted-foreground">
            Loading scan lifecycle...
          </p>
        </main>
      </div>
    );
  }

  if (!user || !activeWorkspace) {
    return (
      <div className="min-h-screen bg-background text-foreground">
        <main id="main-content" className="mx-auto max-w-xl px-4 py-16 sm:px-6">
          <h1 className="font-display text-2xl font-bold text-foreground">
            Redirecting to sign in...
          </h1>
        </main>
      </div>
    );
  }

  const currentStageIndex = detail ? (STAGE_ORDER[detail.scan.status] ?? 0) : 0;

  return (
    <AppShell
      user={user}
      activeWorkspace={activeWorkspace}
      workspaces={workspaces}
      activeNav="scan-detail"
      onWorkspaceChange={(nextWs) => {
        setActiveWorkspace(nextWs);
        void loadScanDetail(nextWs.workspaceId);
      }}
      onSignOut={handleSignOut}
      signingOut={signingOut}
    >
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Link
            href="/dashboard"
            data-testid="back-to-dashboard-link"
            className="text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground"
          >
            ← Back to Dashboard &amp; Scan History
          </Link>
          <button
            type="button"
            onClick={() => void loadScanDetail(activeWorkspace.workspaceId)}
            disabled={loadingDetail}
            data-testid="refresh-scan-detail-button"
            className="cursor-pointer rounded-md border border-border bg-card px-3 py-1.5 text-xs font-semibold text-foreground transition-colors hover:bg-accent disabled:opacity-50"
          >
            {loadingDetail ? "Refreshing..." : "Refresh status"}
          </button>
        </div>

        {loadingDetail && !detail ? (
          <div
            aria-busy="true"
            className="space-y-3 rounded-lg border border-border bg-card p-6"
          >
            <p className="font-mono text-xs text-muted-foreground">
              Loading scan record {scanId} from Cloudflare D1...
            </p>
            <div className="h-8 w-2/3 animate-pulse rounded bg-background/60" />
            <div className="h-24 w-full animate-pulse rounded bg-background/60" />
          </div>
        ) : detailError || !detail ? (
          <div
            role="alert"
            data-testid="scan-detail-error"
            className="rounded-lg border border-border bg-card p-6"
          >
            <p className="font-mono text-xs font-semibold text-destructive uppercase">
              Scan Unavailable
            </p>
            <h1 className="mt-1 font-display text-xl font-bold text-foreground">
              {detailError ?? "Scan not found in this workspace."}
            </h1>
            <p className="mt-2 text-xs text-muted-foreground">
              Scans are strictly isolated to the workspace that created them.
            </p>
            <div className="mt-4">
              <Link
                href="/dashboard"
                className="inline-flex rounded-md bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground transition-colors hover:bg-destructive"
              >
                Return to Dashboard
              </Link>
            </div>
          </div>
        ) : (
          <>
            {/* Scan Summary Header */}
            <section
              aria-labelledby="scan-target-heading"
              className="rounded-lg border border-border bg-card p-6"
            >
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      data-testid="scan-detail-status"
                      className={`inline-block rounded px-2.5 py-0.5 font-mono text-xs font-semibold uppercase ${getScanStatusBadgeClass(detail.scan.status)}`}
                    >
                      {formatScanStatusLabel(detail.scan.status)}
                    </span>
                    <span className="font-mono text-xs text-muted-foreground">
                      Scan ID: {detail.scan.id}
                    </span>
                    <span className="rounded border border-border bg-background/60 px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
                      Scoring {detail.scan.scoring_version}
                    </span>
                  </div>
                  <h1
                    id="scan-target-heading"
                    data-testid="scan-detail-target-url"
                    className="mt-2 font-display text-2xl font-bold tracking-tight text-foreground"
                  >
                    {detail.scan.normalized_url}
                  </h1>
                  <p className="mt-1 font-mono text-xs text-muted-foreground">
                    Created: {formatScanTimestamp(detail.scan.created_at)} ·
                    Pages captured: {detail.scan.pages_captured} /{" "}
                    {detail.scan.pages_discovered}
                  </p>
                </div>

                <div className="rounded-md border border-border bg-background/60 px-4 py-3 text-right">
                  <p className="font-mono text-[11px] text-muted-foreground uppercase">
                    Overall Score
                  </p>
                  <p
                    data-testid="scan-detail-overall-score"
                    className="mt-0.5 font-display text-2xl font-bold text-foreground"
                  >
                    {detail.report
                      ? `${detail.report.overall_score}/100`
                      : "Pending"}
                  </p>
                </div>
              </div>
            </section>

            {/* 7-Stage Diagnostic Lifecycle Progress */}
            <section
              aria-labelledby="lifecycle-heading"
              className="rounded-lg border border-border bg-card p-6"
            >
              <h2
                id="lifecycle-heading"
                className="font-display text-base font-bold text-foreground"
              >
                Diagnostic Lifecycle Stage
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Real-time pipeline stages recorded in Cloudflare D1. Full live
                streaming and interactive category tabs connect in THE-198 and
                THE-194.
              </p>

              <ol
                data-testid="scan-lifecycle-stepper"
                className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
              >
                {LIFECYCLE_STEPS.map((step, index) => {
                  const isCurrent = detail.scan.status === step.stage;
                  const isDone =
                    currentStageIndex > index ||
                    detail.scan.status === "complete";
                  return (
                    <li
                      key={step.stage}
                      aria-current={isCurrent ? "step" : undefined}
                      className={`rounded-md border p-3.5 text-xs ${
                        isCurrent
                          ? "border-primary bg-background ring-1 ring-primary"
                          : isDone
                            ? "border-border bg-background/70"
                            : "border-border/50 bg-background/30"
                      }`}
                    >
                      <div className="flex items-center justify-between font-mono text-[11px]">
                        <span className="font-semibold text-foreground uppercase">
                          0{index + 1} · {step.stage}
                        </span>
                        <span className="text-muted-foreground">
                          {isCurrent ? "Active" : isDone ? "Done" : "Pending"}
                        </span>
                      </div>
                      <p className="mt-1.5 font-semibold text-foreground">
                        {step.title}
                      </p>
                      <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                        {step.description}
                      </p>
                    </li>
                  );
                })}
              </ol>
            </section>

            {/* Stage Event Log from D1 scan_events */}
            <section
              aria-labelledby="scan-events-heading"
              className="rounded-lg border border-border bg-card p-6"
            >
              <h2
                id="scan-events-heading"
                className="font-display text-base font-bold text-foreground"
              >
                Recorded Stage Events ({detail.events.length})
              </h2>
              {detail.events.length === 0 ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  No stage transition events recorded yet.
                </p>
              ) : (
                <ul
                  data-testid="scan-events-list"
                  className="mt-4 space-y-2.5 text-xs"
                >
                  {detail.events.map((ev) => (
                    <li
                      key={ev.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/70 bg-background/50 px-3.5 py-2.5"
                    >
                      <div>
                        <span className="rounded bg-primary px-2 py-0.5 font-mono text-[11px] font-semibold text-primary-foreground uppercase">
                          {ev.stage}
                        </span>
                        <span className="ml-2.5 font-medium text-foreground">
                          {ev.message}
                        </span>
                      </div>
                      <span className="font-mono text-[11px] text-muted-foreground">
                        {formatScanTimestamp(ev.created_at)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </AppShell>
  );
}
