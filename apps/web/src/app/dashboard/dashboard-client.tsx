"use client";

import type {
  WorkspaceAccessContext,
  WorkspaceScanHistoryRow,
} from "@mortem/core";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ExamineForm } from "@/app/examine-form";
import { AppShell } from "@/components/app-shell";
import { ScanHistoryTable } from "@/components/scan-history-table";
import type { AuthenticatedUserSummary } from "@/lib/workspace-session";

interface WorkspaceApiPayload {
  ok: boolean;
  user?: AuthenticatedUserSummary;
  activeWorkspace?: WorkspaceAccessContext;
  workspaces?: WorkspaceAccessContext[];
}

interface ScansListApiPayload {
  ok: boolean;
  workspaceId?: string;
  scans?: WorkspaceScanHistoryRow[];
  error?: string;
}

export function DashboardClient() {
  const router = useRouter();
  const [loadingSession, setLoadingSession] = useState(true);
  const [loadingScans, setLoadingScans] = useState(false);
  const [user, setUser] = useState<AuthenticatedUserSummary | null>(null);
  const [activeWorkspace, setActiveWorkspace] =
    useState<WorkspaceAccessContext | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceAccessContext[]>([]);
  const [scans, setScans] = useState<WorkspaceScanHistoryRow[]>([]);
  const [scansError, setScansError] = useState<string | null>(null);
  const [initialUrl] = useState(() =>
    typeof window !== "undefined"
      ? (new URLSearchParams(window.location.search).get("url") ?? "")
      : "",
  );
  const [signingOut, setSigningOut] = useState(false);

  const loadWorkspaceScans = useCallback(async (workspaceId: string) => {
    setLoadingScans(true);
    setScansError(null);
    try {
      const response = await fetch(
        `/api/scans?workspaceId=${encodeURIComponent(workspaceId)}`,
        {
          credentials: "include",
          cache: "no-store",
        },
      );
      const data = (await response
        .json()
        .catch(() => null)) as ScansListApiPayload | null;
      if (!response.ok || !data?.ok) {
        setScansError(
          data?.error ?? "Unable to load workspace scan history from D1.",
        );
        setScans([]);
        return;
      }
      setScans(data.scans ?? []);
    } catch {
      setScansError("Network error while loading workspace scan history.");
    } finally {
      setLoadingScans(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadSession() {
      try {
        const response = await fetch("/api/workspaces", {
          credentials: "include",
          cache: "no-store",
        });
        if (!response.ok) {
          if (!cancelled) {
            setLoadingSession(false);
            router.replace("/sign-in?next=%2Fdashboard");
          }
          return;
        }
        const data = (await response.json()) as WorkspaceApiPayload;
        if (!cancelled && data.ok && data.user && data.activeWorkspace) {
          setUser(data.user);
          setActiveWorkspace(data.activeWorkspace);
          setWorkspaces(data.workspaces ?? [data.activeWorkspace]);
          await loadWorkspaceScans(data.activeWorkspace.workspaceId);
        }
      } finally {
        if (!cancelled) {
          setLoadingSession(false);
        }
      }
    }
    void loadSession();
    return () => {
      cancelled = true;
    };
  }, [loadWorkspaceScans, router]);

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await fetch("/api/auth/sign-out", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({}),
      });
      setUser(null);
      setActiveWorkspace(null);
      router.push("/sign-in");
      router.refresh();
    } finally {
      setSigningOut(false);
    }
  }

  function handleFocusQuickScan() {
    const input = document.getElementById(
      "dashboard-examine-input",
    ) as HTMLInputElement | null;
    input?.focus();
  }

  if (loadingSession) {
    return (
      <div className="min-h-screen bg-background text-foreground">
        <main
          id="main-content"
          className="mx-auto max-w-5xl px-4 py-16 sm:px-6"
        >
          <p className="font-mono text-xs text-muted-foreground">
            Loading workspace dashboard...
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

  const completedWithScore = scans.filter(
    (s) => s.overall_score !== null && typeof s.overall_score === "number",
  );
  const averageScore =
    completedWithScore.length > 0
      ? Math.round(
          completedWithScore.reduce(
            (sum, s) => sum + (s.overall_score ?? 0),
            0,
          ) / completedWithScore.length,
        )
      : null;
  const activeCount = scans.filter(
    (s) =>
      s.status !== "complete" &&
      s.status !== "partial" &&
      s.status !== "failed",
  ).length;

  return (
    <AppShell
      user={user}
      activeWorkspace={activeWorkspace}
      workspaces={workspaces}
      activeNav="dashboard"
      onWorkspaceChange={(nextWs) => {
        setActiveWorkspace(nextWs);
        void loadWorkspaceScans(nextWs.workspaceId);
      }}
      onSignOut={handleSignOut}
      signingOut={signingOut}
    >
      <div className="space-y-6">
        {/* Quick Scan Intake Card */}
        <section
          aria-labelledby="quick-scan-heading"
          className="rounded-lg border border-border bg-card p-6"
        >
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="font-mono text-xs font-semibold tracking-wider text-primary uppercase">
                Diagnostic Intake · {activeWorkspace.workspaceName}
              </p>
              <h1
                id="quick-scan-heading"
                data-testid="dashboard-heading"
                className="mt-1 font-display text-2xl font-bold tracking-tight text-foreground"
              >
                Start a website autopsy
              </h1>
              <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">
                Enter any public domain or URL. Mortem canonicalizes the target,
                validates DNS via Cloudflare 1.1.1.1 against SSRF ranges, and
                queues a multi-page desktop and mobile capture.
              </p>
            </div>
          </div>

          <div className="mt-5">
            <ExamineForm
              id="dashboard-examine"
              buttonLabel="Start scan"
              workspaceId={activeWorkspace.workspaceId}
              initialUrl={initialUrl}
              onScanCreated={() => {
                void loadWorkspaceScans(activeWorkspace.workspaceId);
              }}
            />
          </div>
        </section>

        {/* Real D1 Workspace Metrics Strip */}
        <section
          aria-label="Workspace diagnostic summary"
          className="grid gap-4 sm:grid-cols-3"
        >
          <div className="rounded-lg border border-border bg-card p-4">
            <p className="font-mono text-[11px] text-muted-foreground uppercase">
              Workspace Scans
            </p>
            <p
              data-testid="metric-total-scans"
              className="mt-1 font-display text-2xl font-bold text-foreground"
            >
              {scans.length}
            </p>
          </div>
          <div className="rounded-lg border border-border bg-card p-4">
            <p className="font-mono text-[11px] text-muted-foreground uppercase">
              Queued / In Progress
            </p>
            <p
              data-testid="metric-active-scans"
              className="mt-1 font-display text-2xl font-bold text-foreground"
            >
              {activeCount}
            </p>
          </div>
          <div className="rounded-lg border border-border bg-card p-4">
            <p className="font-mono text-[11px] text-muted-foreground uppercase">
              Avg. Overall Score
            </p>
            <p
              data-testid="metric-avg-score"
              className="mt-1 font-display text-2xl font-bold text-foreground"
            >
              {averageScore !== null ? `${averageScore}/100` : "—"}
            </p>
          </div>
        </section>

        {/* Recent Scans & Report History */}
        <section aria-labelledby="recent-scans-heading" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2
                id="recent-scans-heading"
                className="font-display text-lg font-bold text-foreground"
              >
                Recent Scans &amp; Report History
              </h2>
              <p className="text-xs text-muted-foreground">
                Showing real Cloudflare D1 records for{" "}
                <span className="font-semibold text-foreground">
                  {activeWorkspace.workspaceName}
                </span>
                .
              </p>
            </div>
            <button
              type="button"
              onClick={() =>
                void loadWorkspaceScans(activeWorkspace.workspaceId)
              }
              disabled={loadingScans}
              data-testid="refresh-scans-button"
              className="cursor-pointer rounded-md border border-border bg-card px-3 py-1.5 text-xs font-semibold text-foreground transition-colors hover:bg-accent disabled:opacity-50"
            >
              {loadingScans ? "Refreshing..." : "Refresh history"}
            </button>
          </div>

          {scansError ? (
            <div
              role="alert"
              className="rounded-md border border-border bg-card px-4 py-3 text-xs text-destructive"
            >
              {scansError}
            </div>
          ) : null}

          <ScanHistoryTable
            scans={scans}
            loading={loadingScans}
            workspaceName={activeWorkspace.workspaceName}
            onFocusQuickScan={handleFocusQuickScan}
          />
        </section>
      </div>
    </AppShell>
  );
}
