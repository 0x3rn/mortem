"use client";

import type { ScanStatus, WorkspaceScanHistoryRow } from "@mortem/core";
import Link from "next/link";

export function formatScanStatusLabel(status: ScanStatus): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "discovering":
      return "Discovering pages";
    case "capturing":
      return "Capturing browser";
    case "checking":
      return "Running checks";
    case "scoring":
      return "Scoring";
    case "generating_report":
      return "Generating report";
    case "complete":
      return "Complete";
    case "partial":
      return "Partial";
    case "failed":
      return "Failed";
    default:
      return status;
  }
}

export function getScanStatusBadgeClass(status: ScanStatus): string {
  switch (status) {
    case "complete":
      return "bg-primary text-primary-foreground";
    case "partial":
      return "border border-border bg-accent text-foreground";
    case "failed":
      return "border border-border bg-card text-destructive";
    default:
      return "border border-border bg-background/80 text-foreground";
  }
}

export function formatScanTimestamp(epochMs: number | null): string {
  if (!epochMs) return "—";
  try {
    return (
      new Date(epochMs).toISOString().replace("T", " ").slice(0, 16) + " UTC"
    );
  } catch {
    return "—";
  }
}

export interface ScanHistoryTableProps {
  scans: WorkspaceScanHistoryRow[];
  loading: boolean;
  workspaceName: string;
  onFocusQuickScan?: () => void;
}

export function ScanHistoryTable({
  scans,
  loading,
  workspaceName,
  onFocusQuickScan,
}: ScanHistoryTableProps) {
  if (loading) {
    return (
      <div
        data-testid="scan-history-loading"
        aria-busy="true"
        aria-live="polite"
        className="space-y-2.5 rounded-lg border border-border bg-card p-6"
      >
        <p className="font-mono text-xs text-muted-foreground">
          Loading scan history from Cloudflare D1...
        </p>
        <div className="h-9 w-full animate-pulse rounded bg-background/60" />
        <div className="h-9 w-full animate-pulse rounded bg-background/60" />
        <div className="h-9 w-full animate-pulse rounded bg-background/60" />
      </div>
    );
  }

  if (scans.length === 0) {
    return (
      <div
        data-testid="scan-history-empty"
        className="rounded-lg border border-border bg-card p-8 text-center"
      >
        <p className="font-mono text-xs font-semibold tracking-wider text-primary uppercase">
          Zero Scans Recorded
        </p>
        <h3 className="mt-2 font-display text-lg font-bold text-foreground">
          No website autopsies in {workspaceName} yet
        </h3>
        <p className="mx-auto mt-2 max-w-lg text-xs leading-relaxed text-muted-foreground">
          Mortem never pre-populates sample scores, fake findings, or
          placeholder reports in your workspace. Submit a public domain above to
          queue your first real diagnostic scan.
        </p>
        {onFocusQuickScan ? (
          <div className="mt-5">
            <button
              type="button"
              onClick={onFocusQuickScan}
              data-testid="empty-state-start-scan-button"
              className="cursor-pointer rounded-md bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground transition-colors hover:bg-destructive"
            >
              Run your first scan
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card">
      <table
        data-testid="scan-history-table"
        className="w-full border-collapse text-left text-xs"
      >
        <thead>
          <tr className="border-b border-border bg-background/50 font-mono text-[11px] text-muted-foreground uppercase">
            <th scope="col" className="px-4 py-3 font-semibold">
              Target URL
            </th>
            <th scope="col" className="px-4 py-3 font-semibold">
              Status
            </th>
            <th scope="col" className="px-4 py-3 font-semibold">
              Pages Scanned
            </th>
            <th scope="col" className="px-4 py-3 font-semibold">
              Overall Score
            </th>
            <th scope="col" className="px-4 py-3 font-semibold">
              Created
            </th>
            <th scope="col" className="px-4 py-3 text-right font-semibold">
              Report / Status
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/70">
          {scans.map((scan) => (
            <tr
              key={scan.id}
              data-testid={`scan-history-row-${scan.id}`}
              className="transition-colors hover:bg-background/40"
            >
              <td className="px-4 py-3.5">
                <Link
                  href={`/scans/${encodeURIComponent(scan.id)}`}
                  className="font-semibold text-foreground underline-offset-2 hover:underline"
                >
                  {scan.normalized_url}
                </Link>
                <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                  ID: {scan.id}
                </p>
              </td>
              <td className="px-4 py-3.5">
                <span
                  data-testid={`scan-status-badge-${scan.id}`}
                  className={`inline-block rounded px-2 py-0.5 font-mono text-[11px] font-semibold uppercase ${getScanStatusBadgeClass(scan.status)}`}
                >
                  {formatScanStatusLabel(scan.status)}
                </span>
              </td>
              <td className="px-4 py-3.5 font-mono text-muted-foreground">
                {scan.pages_captured} / {scan.pages_discovered}
              </td>
              <td className="px-4 py-3.5">
                {scan.overall_score !== null ? (
                  <span className="font-display text-sm font-bold text-foreground">
                    {scan.overall_score}
                    <span className="text-xs font-normal text-muted-foreground">
                      /100
                    </span>
                  </span>
                ) : (
                  <span className="font-mono text-[11px] text-muted-foreground">
                    Pending
                  </span>
                )}
              </td>
              <td className="px-4 py-3.5 font-mono text-[11px] text-muted-foreground">
                {formatScanTimestamp(scan.created_at)}
              </td>
              <td className="px-4 py-3.5 text-right">
                <Link
                  href={`/scans/${encodeURIComponent(scan.id)}`}
                  data-testid={`scan-view-link-${scan.id}`}
                  className="inline-flex items-center rounded-md border border-border bg-background/70 px-3 py-1.5 text-xs font-semibold text-foreground transition-colors hover:bg-accent"
                >
                  View scan →
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
