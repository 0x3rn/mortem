"use client";

import type { WorkspaceAccessContext } from "@mortem/core";
import Link from "next/link";
import type { ReactNode } from "react";
import type { AuthenticatedUserSummary } from "@/lib/workspace-session";

export interface AppShellProps {
  user: AuthenticatedUserSummary;
  activeWorkspace: WorkspaceAccessContext;
  workspaces: WorkspaceAccessContext[];
  activeNav: "dashboard" | "workspace" | "scan-detail";
  onWorkspaceChange?: (workspace: WorkspaceAccessContext) => void;
  onSignOut: () => void;
  signingOut?: boolean;
  children: ReactNode;
}

export function AppShell({
  user,
  activeWorkspace,
  workspaces,
  activeNav,
  onWorkspaceChange,
  onSignOut,
  signingOut = false,
  children,
}: AppShellProps) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-xs focus:font-semibold focus:text-primary-foreground"
      >
        Skip to main content
      </a>

      {/* Top Application Header */}
      <header className="border-b border-border bg-card/60">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-4 py-3.5 sm:px-6">
          <div className="flex flex-wrap items-center gap-3">
            <Link
              href="/dashboard"
              className="flex items-center gap-2 font-display text-lg font-bold tracking-tight text-foreground"
            >
              <span
                aria-hidden="true"
                className="inline-block h-2.5 w-2.5 rounded-full bg-primary"
              />
              <span>Mortem</span>
            </Link>

            <span aria-hidden="true" className="text-muted-foreground">
              /
            </span>

            <div
              data-testid="active-workspace-indicator"
              className="flex flex-wrap items-center gap-2"
            >
              {workspaces.length > 1 && onWorkspaceChange ? (
                <div>
                  <label htmlFor="workspace-switcher" className="sr-only">
                    Active workspace
                  </label>
                  <select
                    id="workspace-switcher"
                    data-testid="workspace-switcher"
                    value={activeWorkspace.workspaceId}
                    onChange={(event) => {
                      const nextWs = workspaces.find(
                        (w) => w.workspaceId === event.target.value,
                      );
                      if (nextWs) {
                        onWorkspaceChange(nextWs);
                      }
                    }}
                    className="rounded-md border border-border bg-background px-2.5 py-1 text-xs font-semibold text-foreground focus:ring-2 focus:ring-ring focus:outline-none"
                  >
                    {workspaces.map((ws) => (
                      <option key={ws.workspaceId} value={ws.workspaceId}>
                        {ws.workspaceName} ({ws.role})
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <span className="text-xs font-semibold text-foreground">
                  {activeWorkspace.workspaceName}
                </span>
              )}

              <span className="rounded bg-primary px-2 py-0.5 font-mono text-[11px] font-semibold text-primary-foreground uppercase">
                {activeWorkspace.role}
              </span>
              <span className="rounded border border-border bg-background/70 px-2 py-0.5 font-mono text-[11px] text-muted-foreground uppercase">
                {activeWorkspace.workspacePlan} plan
              </span>
            </div>
          </div>

          {/* Account Menu */}
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
              onClick={onSignOut}
              disabled={signingOut}
              data-testid="sign-out-button"
              className="cursor-pointer rounded-md border border-border bg-background/80 px-3.5 py-2 text-xs font-semibold text-foreground transition-colors hover:bg-accent disabled:opacity-50"
            >
              {signingOut ? "Signing out..." : "Sign out"}
            </button>
          </div>
        </div>
      </header>

      {/* Shell Body: Responsive Sidebar + Main Content */}
      <div className="mx-auto grid max-w-7xl gap-6 px-4 py-6 sm:px-6 lg:grid-cols-12 lg:py-8">
        <aside
          aria-label="Workspace navigation"
          className="lg:col-span-3 xl:col-span-2"
        >
          <nav aria-label="Workspace menu" className="space-y-1.5">
            <Link
              href="/dashboard"
              data-testid="nav-dashboard"
              aria-current={activeNav === "dashboard" ? "page" : undefined}
              className={`block rounded-md px-3.5 py-2.5 text-xs font-semibold transition-colors ${
                activeNav === "dashboard" || activeNav === "scan-detail"
                  ? "bg-primary text-primary-foreground"
                  : "border border-border/60 bg-card/60 text-foreground hover:bg-accent"
              }`}
            >
              Dashboard &amp; Scans
            </Link>
            <Link
              href="/workspace"
              data-testid="nav-workspace"
              aria-current={activeNav === "workspace" ? "page" : undefined}
              className={`block rounded-md px-3.5 py-2.5 text-xs font-semibold transition-colors ${
                activeNav === "workspace"
                  ? "bg-primary text-primary-foreground"
                  : "border border-border/60 bg-card/60 text-foreground hover:bg-accent"
              }`}
            >
              Workspace &amp; Access
            </Link>
            <Link
              href="/"
              data-testid="nav-landing"
              className="block rounded-md border border-border/60 bg-card/60 px-3.5 py-2.5 text-xs font-semibold text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              Public Home ↗
            </Link>
          </nav>

          <div className="mt-6 hidden rounded-lg border border-border bg-card/70 p-4 lg:block">
            <p className="font-mono text-[11px] font-semibold tracking-wider text-primary uppercase">
              Active Scope
            </p>
            <p className="mt-1 text-xs font-semibold text-foreground">
              {activeWorkspace.workspaceName}
            </p>
            <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
              {activeWorkspace.workspaceSlug}
            </p>
            <p className="mt-2.5 text-[11px] leading-relaxed text-muted-foreground">
              All scan runs, captured evidence, and autopsy reports are isolated
              to this workspace on Cloudflare D1.
            </p>
          </div>
        </aside>

        <main id="main-content" className="lg:col-span-9 xl:col-span-10">
          {children}
        </main>
      </div>
    </div>
  );
}
