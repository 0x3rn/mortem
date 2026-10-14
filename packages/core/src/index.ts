/**
 * @mortem/core
 * Shared domain constants, read-only scanning invariants, diagnostic categories,
 * scan stage lifecycle states, and URL normalization utilities.
 */

export const DIAGNOSTIC_CATEGORIES = [
  "performance",
  "conversion",
  "seo",
  "accessibility",
  "mobile",
  "security",
  "links_assets",
] as const;

export type DiagnosticCategory = (typeof DIAGNOSTIC_CATEGORIES)[number];

export const CATEGORY_WEIGHTS: Readonly<Record<DiagnosticCategory, number>> = {
  performance: 0.2,
  conversion: 0.2,
  seo: 0.15,
  accessibility: 0.15,
  mobile: 0.1,
  security: 0.1,
  links_assets: 0.1,
} as const;

export const FINDING_SEVERITIES = [
  "critical",
  "high",
  "medium",
  "low",
  "info",
] as const;

export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export const SCAN_STAGES = [
  "queued",
  "discovering",
  "capturing",
  "checking",
  "scoring",
  "generating_report",
  "complete",
  "partial",
  "failed",
] as const;

export type ScanStage = (typeof SCAN_STAGES)[number];

/**
 * Architectural invariant (ADR-0001):
 * Mortem is strictly read-only. It never submits forms, authenticates, or mutates
 * state on third-party target websites.
 */
export const READ_ONLY_SCAN_POLICY = {
  allowedHttpMethods: ["GET", "HEAD"] as const,
  submitForms: false as const,
  authenticateOrLogin: false as const,
  mutateRemoteState: false as const,
  respectRobotsTxt: true as const,
  userAgent:
    "MortemBot/1.0 (+https://mortem.dev/bot; read-only diagnostic crawler)",
} as const;

export type AllowedScanHttpMethod =
  (typeof READ_ONLY_SCAN_POLICY.allowedHttpMethods)[number];

export function isAllowedScanMethod(
  method: string,
): method is AllowedScanHttpMethod {
  const upper = method.trim().toUpperCase();
  return upper === "GET" || upper === "HEAD";
}

/**
 * Normalizes a user-supplied domain or URL string into a canonical HTTP(S) URL.
 * - Prepends `https://` when no scheme is provided
 * - Rejects non-HTTP(S) schemes (`javascript:`, `data:`, `file:`, `ftp:`)
 * - Rejects URLs containing embedded credentials (`user:pass@host`)
 * - Strips URL `#hash` fragments so identical pages normalize consistently
 * - Requires a hostname containing at least one dot and a non-empty TLD
 */
export function normalizeUrlInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const hasExplicitScheme = /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(trimmed);
  if (hasExplicitScheme && !/^https?:\/\//i.test(trimmed)) {
    return null;
  }

  const candidate = hasExplicitScheme ? trimmed : `https://${trimmed}`;

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    if (parsed.username || parsed.password) {
      return null;
    }

    const host = parsed.hostname.toLowerCase();
    if (
      !host ||
      !host.includes(".") ||
      host.startsWith(".") ||
      host.endsWith(".")
    ) {
      return null;
    }

    const parts = host.split(".");
    const tld = parts[parts.length - 1];
    if (!tld || tld.length < 2) {
      return null;
    }

    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

export * from "./cloudflare";
export * from "./schema/auth";
export * from "./schema/scans";
export * from "./workspaces";
