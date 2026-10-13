import { describe, expect, it } from "vitest";
import {
  CATEGORY_WEIGHTS,
  DIAGNOSTIC_CATEGORIES,
  FINDING_SEVERITIES,
  PlatformBindingError,
  READ_ONLY_SCAN_POLICY,
  SCAN_STAGES,
  buildSmokeArtifactKey,
  isAllowedScanMethod,
  normalizeUrlInput,
  requireScanWorkerBindings,
  requireWebBindings,
} from "./index";

describe("@mortem/core domain contracts", () => {
  it("defines all 7 diagnostic categories whose weights sum to 1.0", () => {
    expect(DIAGNOSTIC_CATEGORIES).toHaveLength(7);
    const totalWeight = DIAGNOSTIC_CATEGORIES.reduce(
      (sum, category) => sum + CATEGORY_WEIGHTS[category],
      0,
    );
    expect(totalWeight).toBeCloseTo(1.0, 5);
  });

  it("exposes ordered finding severities and scan lifecycle stages", () => {
    expect(FINDING_SEVERITIES).toEqual([
      "critical",
      "high",
      "medium",
      "low",
      "info",
    ]);
    expect(SCAN_STAGES[0]).toBe("queued");
    expect(SCAN_STAGES[SCAN_STAGES.length - 1]).toBe("failed");
  });

  it("enforces read-only HTTP method invariants (ADR-0001)", () => {
    expect(READ_ONLY_SCAN_POLICY.submitForms).toBe(false);
    expect(READ_ONLY_SCAN_POLICY.authenticateOrLogin).toBe(false);
    expect(READ_ONLY_SCAN_POLICY.mutateRemoteState).toBe(false);
    expect(READ_ONLY_SCAN_POLICY.respectRobotsTxt).toBe(true);

    expect(isAllowedScanMethod("GET")).toBe(true);
    expect(isAllowedScanMethod("head")).toBe(true);
    expect(isAllowedScanMethod("POST")).toBe(false);
    expect(isAllowedScanMethod("PUT")).toBe(false);
    expect(isAllowedScanMethod("PATCH")).toBe(false);
    expect(isAllowedScanMethod("DELETE")).toBe(false);
  });

  it("normalizes valid domain and URL inputs and strips fragments", () => {
    expect(normalizeUrlInput("stripe.com")).toBe("https://stripe.com/");
    expect(normalizeUrlInput("  acme-cloud.io/pricing#faq ")).toBe(
      "https://acme-cloud.io/pricing",
    );
    expect(normalizeUrlInput("http://example.com/contact?ref=nav")).toBe(
      "http://example.com/contact?ref=nav",
    );
  });

  it("rejects empty, non-HTTP(S), credentialed, or malformed URLs", () => {
    expect(normalizeUrlInput("")).toBeNull();
    expect(normalizeUrlInput("   ")).toBeNull();
    expect(normalizeUrlInput("javascript:alert(1)")).toBeNull();
    expect(normalizeUrlInput("file:///etc/passwd")).toBeNull();
    expect(normalizeUrlInput("https://user:pass@example.com")).toBeNull();
    expect(normalizeUrlInput("localhost")).toBeNull();
    expect(normalizeUrlInput("invalid..domain.")).toBeNull();
  });

  it("fails closed when Cloudflare bindings are missing on mortem-web or mortem-scan", () => {
    expect(() => requireWebBindings({})).toThrowError(PlatformBindingError);
    try {
      requireWebBindings({});
    } catch (err) {
      expect(err).toBeInstanceOf(PlatformBindingError);
      expect((err as PlatformBindingError).code).toBe("MISSING_BINDING");
      expect((err as PlatformBindingError).bindingName).toBe("DB");
    }

    const fakeDb = {
      prepare: () => ({
        bind: () => ({
          run: async () => ({ success: true }),
          first: async () => null,
        }),
      }),
    };
    const fakeR2 = { put: async () => null, head: async () => null };

    expect(() =>
      requireScanWorkerBindings(
        { DB: fakeDb, EVIDENCE: fakeR2 },
        { requireBrowser: true },
      ),
    ).toThrowError(/BROWSER/);
  });

  it("formats R2 smoke artifact keys under scans/smoke-{id}/...", () => {
    expect(buildSmokeArtifactKey("abc_123")).toBe(
      "scans/smoke-abc_123/pages/example-com/screenshot.png",
    );
  });
});
