"use client";

import { normalizeUrlInput } from "@mortem/core";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

export interface CreatedScanSummary {
  scanId: string;
  siteId: string;
  workspaceId: string;
  targetUrl: string;
  normalizedUrl: string;
  origin: string;
  hostname: string;
  status: "queued";
}

interface ExamineFormProps {
  id?: string;
  buttonLabel?: string;
  workspaceId?: string;
  initialUrl?: string;
  redirectOnSuccess?: boolean;
  onScanCreated?: (scan: CreatedScanSummary) => void;
}

export function ExamineForm({
  id,
  buttonLabel = "Run autopsy",
  workspaceId,
  initialUrl = "",
  redirectOnSuccess = false,
  onScanCreated,
}: ExamineFormProps) {
  const router = useRouter();
  const [value, setValue] = useState(initialUrl);
  const [submittedUrl, setSubmittedUrl] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [createdScan, setCreatedScan] = useState<CreatedScanSummary | null>(
    null,
  );
  const [existingScanId, setExistingScanId] = useState<string | null>(null);
  const [requiresAuthForLaunch, setRequiresAuthForLaunch] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setCreatedScan(null);
    setExistingScanId(null);
    setRequiresAuthForLaunch(false);

    const normalized = normalizeUrlInput(value);
    if (!normalized) {
      setSubmittedUrl(null);
      setError(
        "Enter a valid public domain or URL (for example, stripe.com or https://example.com).",
      );
      return;
    }

    setError(null);
    setSubmittedUrl(normalized);
    setSubmitting(true);

    try {
      const response = await fetch("/api/scans", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          url: normalized,
          workspaceId,
        }),
      });

      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        code?: string;
        error?: string;
        details?: { existingScanId?: string };
        scan?: CreatedScanSummary;
      } | null;

      if (response.ok && payload?.ok && payload.scan) {
        setCreatedScan(payload.scan);
        onScanCreated?.(payload.scan);
        if (redirectOnSuccess) {
          router.push(`/scans/${encodeURIComponent(payload.scan.scanId)}`);
        }
        return;
      }

      if (
        response.status === 401 ||
        payload?.code === "UNAUTHENTICATED" ||
        payload?.code === "turnstile_failed"
      ) {
        setRequiresAuthForLaunch(true);
        return;
      }

      if (
        response.status === 409 &&
        payload?.code === "duplicate_in_flight" &&
        payload.details?.existingScanId
      ) {
        setExistingScanId(payload.details.existingScanId);
        setError(
          payload.error ??
            "A scan for this URL is already in progress in your workspace.",
        );
        return;
      }

      setError(
        payload?.error ??
          "Unable to queue scan right now. Verify the target URL is publicly reachable.",
      );
    } catch {
      // Keep the normalized status banner visible if network intake fails
    } finally {
      setSubmitting(false);
    }
  }

  const inputId = id ? `${id}-input` : "examine-url-input";
  const dashboardNextUrl = submittedUrl
    ? `/dashboard?url=${encodeURIComponent(submittedUrl)}`
    : "/dashboard";

  return (
    <div id={id} className="mx-auto w-full max-w-xl">
      <form
        className="flex flex-col gap-2.5 sm:flex-row"
        onSubmit={handleSubmit}
        noValidate
      >
        <label htmlFor={inputId} className="sr-only">
          Website URL to examine
        </label>
        <input
          id={inputId}
          type="text"
          inputMode="url"
          autoComplete="url"
          required
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError(null);
          }}
          placeholder="yourwebsite.com or https://yourwebsite.com/pricing"
          className="flex-1 rounded-md border border-input bg-card px-4 py-3.5 text-sm text-foreground placeholder:text-muted-foreground focus:ring-2 focus:ring-ring focus:outline-none"
        />
        <button
          type="submit"
          disabled={submitting}
          className="cursor-pointer rounded-md bg-primary px-6 py-3.5 text-sm font-semibold whitespace-nowrap text-primary-foreground transition-colors hover:bg-destructive disabled:opacity-60"
        >
          {submitting ? "Verifying target..." : buttonLabel}
        </button>
      </form>

      {error ? (
        <div
          role="alert"
          className="mt-2.5 rounded-md border border-border bg-card px-3.5 py-2.5 text-left text-xs text-destructive"
        >
          <p>{error}</p>
          {existingScanId ? (
            <p className="mt-1.5">
              <Link
                href={`/scans/${encodeURIComponent(existingScanId)}`}
                className="font-semibold text-foreground underline underline-offset-2"
              >
                Open in-flight scan ({existingScanId}) →
              </Link>
            </p>
          ) : null}
        </div>
      ) : null}

      {submittedUrl ? (
        <div
          role="status"
          className="mt-3 rounded-md border border-border bg-card/90 px-4 py-3 text-left text-xs text-muted-foreground"
        >
          <p>
            <span className="font-semibold text-foreground">
              Target normalized:
            </span>{" "}
            <code className="text-foreground">{submittedUrl}</code>
            {submitting
              ? " — Running DNS-over-HTTPS SSRF and reachability pre-flight..."
              : createdScan
                ? ` — Queued in workspace (${createdScan.scanId}).`
                : requiresAuthForLaunch
                  ? " — Sign in or create a workspace to launch and save this autopsy."
                  : null}
          </p>
          {createdScan ? (
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <Link
                href={`/scans/${encodeURIComponent(createdScan.scanId)}`}
                data-testid="examine-created-scan-link"
                className="inline-flex items-center rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-colors hover:bg-destructive"
              >
                View scan lifecycle →
              </Link>
              <Link
                href="/dashboard"
                className="text-xs font-semibold text-foreground underline underline-offset-2"
              >
                Open dashboard history
              </Link>
            </div>
          ) : requiresAuthForLaunch ? (
            <div className="mt-2.5 flex flex-wrap items-center gap-2.5">
              <Link
                href={`/sign-in?next=${encodeURIComponent(dashboardNextUrl)}`}
                className="inline-flex items-center rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-colors hover:bg-destructive"
              >
                Sign in to run scan →
              </Link>
              <Link
                href={`/sign-up?next=${encodeURIComponent(dashboardNextUrl)}`}
                className="inline-flex items-center rounded-md border border-border bg-background/70 px-3 py-1.5 text-xs font-semibold text-foreground transition-colors hover:bg-accent"
              >
                Create workspace
              </Link>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
