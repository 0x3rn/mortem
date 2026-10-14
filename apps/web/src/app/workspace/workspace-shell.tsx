"use client";

import type { WorkspaceAccessContext } from "@mortem/core";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";
import type { AuthenticatedUserSummary } from "@/lib/workspace-session";

interface WorkspaceApiPayload {
  ok: boolean;
  user?: AuthenticatedUserSummary;
  activeWorkspace?: WorkspaceAccessContext;
  workspaces?: WorkspaceAccessContext[];
  error?: string;
}

export function WorkspaceShell() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<AuthenticatedUserSummary | null>(null);
  const [activeWorkspace, setActiveWorkspace] =
    useState<WorkspaceAccessContext | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceAccessContext[]>([]);
  const [claimToken, setClaimToken] = useState("");
  const [claimStatus, setClaimStatus] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);
  const [signingOut, setSigningOut] = useState(false);

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
            setUser(null);
            setActiveWorkspace(null);
            setLoading(false);
            router.replace("/sign-in?next=%2Fworkspace");
          }
          return;
        }
        const data = (await response.json()) as WorkspaceApiPayload;
        if (!cancelled && data.ok && data.user && data.activeWorkspace) {
          setUser(data.user);
          setActiveWorkspace(data.activeWorkspace);
          setWorkspaces(data.workspaces ?? [data.activeWorkspace]);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }
    void loadSession();
    return () => {
      cancelled = true;
    };
  }, [router]);

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

  async function handleRedeemClaimToken(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeWorkspace) return;
    setClaimStatus(null);
    const trimmed = claimToken.trim();
    if (!trimmed) {
      setClaimStatus({
        kind: "error",
        text: "Enter a claim token (mrtm_claim_...) to attach a report.",
      });
      return;
    }

    const response = await fetch(
      `/api/workspaces/${encodeURIComponent(activeWorkspace.workspaceId)}/claim`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ token: trimmed }),
      },
    );
    const data = (await response.json().catch(() => null)) as {
      ok?: boolean;
      error?: string;
      claim?: { resourceType: string; resourceId: string };
    } | null;

    if (!response.ok || !data?.ok) {
      setClaimStatus({
        kind: "error",
        text: data?.error ?? "Unable to redeem claim token.",
      });
      return;
    }

    setClaimToken("");
    setClaimStatus({
      kind: "success",
      text: `Attached ${data.claim?.resourceType} (${data.claim?.resourceId}) to ${activeWorkspace.workspaceName}.`,
    });
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-16 sm:px-6">
        <p className="font-mono text-xs text-muted-foreground">
          Loading workspace session...
        </p>
      </div>
    );
  }

  if (!user || !activeWorkspace) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 sm:px-6">
        <div className="rounded-lg border border-border bg-card p-6 sm:p-8">
          <p className="font-mono text-xs font-semibold tracking-wider text-primary uppercase">
            Authentication Required
          </p>
          <h1 className="mt-1 font-display text-2xl font-bold tracking-tight">
            Sign in to view your workspace
          </h1>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            Your Mortem scans, autopsy reports, and findings are scoped to an
            authenticated workspace.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Link
              href="/sign-in"
              className="rounded-md bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground transition-colors hover:bg-destructive"
            >
              Sign in
            </Link>
            <Link
              href="/sign-up"
              className="rounded-md border border-border bg-background/60 px-4 py-2 text-xs font-semibold text-foreground transition-colors hover:bg-accent"
            >
              Create workspace
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-10 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-border bg-card p-6">
        <div>
          <div className="flex items-center gap-2">
            <span className="rounded bg-primary/15 px-2 py-0.5 font-mono text-xs font-semibold text-primary uppercase">
              {activeWorkspace.role}
            </span>
            <span className="rounded border border-border bg-background/60 px-2 py-0.5 font-mono text-xs text-muted-foreground uppercase">
              {activeWorkspace.workspacePlan} plan
            </span>
          </div>
          <h1
            data-testid="workspace-heading"
            className="mt-2 font-display text-2xl font-bold tracking-tight text-foreground"
          >
            {activeWorkspace.workspaceName}
          </h1>
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            Slug: {activeWorkspace.workspaceSlug} · ID:{" "}
            {activeWorkspace.workspaceId}
          </p>
        </div>

        <div className="flex items-center gap-3">
          <div className="text-right">
            <p
              data-testid="workspace-user-name"
              className="text-xs font-semibold text-foreground"
            >
              {user.name}
            </p>
            <p
              data-testid="workspace-user-email"
              className="font-mono text-xs text-muted-foreground"
            >
              {user.email}
            </p>
          </div>
          <button
            type="button"
            onClick={handleSignOut}
            disabled={signingOut}
            data-testid="sign-out-button"
            className="rounded-md border border-border bg-background/60 px-3.5 py-2 text-xs font-semibold text-foreground transition-colors hover:bg-accent disabled:opacity-50"
          >
            {signingOut ? "Signing out..." : "Sign out"}
          </button>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <section className="rounded-lg border border-border bg-card p-6">
          <h2 className="font-display text-base font-semibold text-foreground">
            Workspace Memberships ({workspaces.length})
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Server-enforced RBAC ensures scans and reports are strictly isolated
            per workspace.
          </p>
          <ul className="mt-4 space-y-2.5">
            {workspaces.map((ws) => (
              <li
                key={ws.workspaceId}
                className="flex items-center justify-between rounded-md border border-border/70 bg-background/50 px-3.5 py-2.5 text-xs"
              >
                <div>
                  <p className="font-semibold text-foreground">
                    {ws.workspaceName}
                  </p>
                  <p className="font-mono text-[11px] text-muted-foreground">
                    {ws.workspaceSlug}
                  </p>
                </div>
                <span className="rounded bg-primary/15 px-2 py-0.5 font-mono text-[11px] font-semibold text-primary uppercase">
                  {ws.role}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className="rounded-lg border border-border bg-card p-6">
          <h2 className="font-display text-base font-semibold text-foreground">
            Claim Purchased Autopsy Report
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Bought a Single Autopsy before signing in? Paste your one-time claim
            token to attach the report to this workspace.
          </p>
          <form onSubmit={handleRedeemClaimToken} className="mt-4 space-y-3">
            <label htmlFor="claim-token-input" className="sr-only">
              Claim token
            </label>
            <input
              id="claim-token-input"
              type="text"
              value={claimToken}
              onChange={(event) => setClaimToken(event.target.value)}
              placeholder="mrtm_claim_..."
              className="w-full rounded-md border border-border bg-background px-3.5 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/30 focus:outline-none"
            />
            {claimStatus ? (
              <p
                role={claimStatus.kind === "error" ? "alert" : "status"}
                className={`rounded-md border px-3 py-2 text-xs ${
                  claimStatus.kind === "error"
                    ? "border-destructive/40 bg-destructive/10 text-destructive"
                    : "border-primary/40 bg-primary/10 text-foreground"
                }`}
              >
                {claimStatus.text}
              </p>
            ) : null}
            <button
              type="submit"
              className="rounded-md bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground transition-colors hover:bg-destructive"
            >
              Attach to workspace
            </button>
          </form>
        </section>
      </div>
    </div>
  );
}
