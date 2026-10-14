import { describe, expect, it } from "vitest";
import { capturePageAcrossViewports } from "./browser-capture";
import {
  CrawlBudgetEnforcer,
  DEFAULT_SCAN_BUDGETS,
  classifyScanErrorForRetry,
  createBrowserSessionPool,
  fetchWithAbortTimeout,
  resolveScanBudgets,
  updateScanUsageInD1,
} from "./crawl-budgets";
import type {
  PlaywrightBrowserContextLike,
  PlaywrightBrowserLike,
  PlaywrightPageLike,
} from "./browser-capture";
import type { D1DatabaseLike } from "./cloudflare";
import { ScanIntakeError } from "./intake";

describe("THE-179 crawl budgets, retry classification, and browser session cleanup", () => {
  it("resolves scan budgets from plan defaults, budgets_json, and options_json overrides", () => {
    const proDefault = resolveScanBudgets({ plan: "pro" });
    expect(proDefault.maxPages).toBe(10);
    expect(proDefault.maxWallTimeMs).toBe(DEFAULT_SCAN_BUDGETS.maxWallTimeMs);
    expect(proDefault.maxBytesPerPage).toBe(
      DEFAULT_SCAN_BUDGETS.maxBytesPerPage,
    );
    expect(proDefault.maxBrowserMs).toBe(DEFAULT_SCAN_BUDGETS.maxBrowserMs);
    expect(proDefault.maxExternalLinkChecks).toBe(
      DEFAULT_SCAN_BUDGETS.maxExternalLinkChecks,
    );

    const overridden = resolveScanBudgets({
      plan: "agency",
      budgetsJson: JSON.stringify({
        maxWallTimeMs: 45_000,
        maxBrowserMs: 30_000,
        maxBytesPerPage: 2_000_000,
        maxExternalLinkChecks: 15,
      }),
      optionsJson: JSON.stringify({
        maxPages: 3,
      }),
    });
    expect(overridden.maxPages).toBe(3);
    expect(overridden.maxWallTimeMs).toBe(45_000);
    expect(overridden.maxBrowserMs).toBe(30_000);
    expect(overridden.maxBytesPerPage).toBe(2_000_000);
    expect(overridden.maxExternalLinkChecks).toBe(15);
  });

  it("enforces maxWallTimeMs, maxBrowserMs, maxPages, and maxExternalLinkChecks via CrawlBudgetEnforcer", () => {
    const startMs = 1_760_000_000_000;
    const enforcer = new CrawlBudgetEnforcer(
      resolveScanBudgets({
        plan: "pro",
        budgetsJson: {
          maxPages: 3,
          maxWallTimeMs: 60_000,
          maxBrowserMs: 20_000,
          maxExternalLinkChecks: 2,
        },
      }),
      startMs,
    );

    expect(enforcer.checkBeforeNextPage(startMs + 5_000)).toEqual({
      allowed: true,
      exceededBudget: null,
      reason: null,
    });

    // Record 1st page using 12,000ms browserMs
    enforcer.recordPageCapture({
      browserMs: 12_000,
      r2BytesWritten: 50_000,
      captured: true,
    });
    expect(enforcer.checkBeforeNextPage(startMs + 15_000)).toEqual({
      allowed: true,
      exceededBudget: null,
      reason: null,
    });

    // Record 2nd page pushing browserMs to 21,000ms (> 20,000ms limit)
    enforcer.recordPageCapture({
      browserMs: 9_000,
      r2BytesWritten: 40_000,
      captured: true,
    });
    const browserBudgetCheck = enforcer.checkBeforeNextPage(startMs + 25_000);
    expect(browserBudgetCheck.allowed).toBe(false);
    expect(browserBudgetCheck.exceededBudget).toBe("maxBrowserMs");
    expect(browserBudgetCheck.reason).toContain("browser execution budget");

    // Wall clock budget check
    const wallEnforcer = new CrawlBudgetEnforcer(
      resolveScanBudgets({
        budgetsJson: { maxWallTimeMs: 30_000, maxPages: 5 },
      }),
      startMs,
    );
    const wallCheck = wallEnforcer.checkBeforeNextPage(startMs + 31_000);
    expect(wallCheck.allowed).toBe(false);
    expect(wallCheck.exceededBudget).toBe("maxWallTimeMs");

    // External link budget check
    expect(
      enforcer.checkBeforeExternalLinkCheck(startMs + 10_000).allowed,
    ).toBe(true);
    enforcer.recordExternalLinkCheck(2);
    const linkCheck = enforcer.checkBeforeExternalLinkCheck(startMs + 10_000);
    expect(linkCheck.allowed).toBe(false);
    expect(linkCheck.exceededBudget).toBe("maxExternalLinkChecks");
  });

  it("truncates HTML payloads exceeding maxBytesPerPage (>10 MB) and marks capture partial with budget_exceeded", async () => {
    const oversizedHtml = `<html><head><title>Huge Document</title></head><body>${"A".repeat(
      250_000,
    )}</body></html>`;

    const capture = await capturePageAcrossViewports({
      targetUrl: "https://example.com/huge",
      maxBytesPerPage: 64 * 1024, // 64 KB cap for fast deterministic test, same code path as 10 MB default
      now: () => 1_760_000_000_000,
      browserLauncher: async () => ({
        async newContext() {
          return {
            async newPage() {
              const url = "https://example.com/huge";
              return {
                async addInitScript() {},
                async route() {},
                on() {},
                async goto() {
                  const req = {
                    url: () => url,
                    method: () => "GET",
                    resourceType: () => "document",
                    isNavigationRequest: () => true,
                    redirectedFrom: () => null,
                  };
                  return {
                    url: () => url,
                    status: () => 200,
                    headers: () => ({ "content-type": "text/html" }),
                    request: () => req,
                  };
                },
                async waitForLoadState() {},
                async evaluate<R>() {
                  return { ttfbMs: 25 } as unknown as R;
                },
                async content() {
                  return oversizedHtml;
                },
                async title() {
                  return "Huge Document";
                },
                url: () => url,
                async screenshot() {
                  return new Uint8Array([137, 80, 78, 71]);
                },
                async close() {},
              };
            },
            async close() {},
          };
        },
        async close() {},
      }),
    });

    expect(capture.htmlTruncated).toBe(true);
    expect(capture.captureStatus).toBe("partial");
    expect(capture.failureClass).toBe("budget_exceeded");
    expect(capture.failureReason).toContain("exceeded maxBytesPerPage");
    expect(
      new TextEncoder().encode(capture.desktop.renderedHtml).byteLength,
    ).toBeLessThanOrEqual(64 * 1024 + 128);
    expect(capture.desktop.renderedHtml).toContain(
      "<!-- [MORTEM_TRUNCATED: HTML exceeded maxBytesPerPage budget] -->",
    );
  });

  it("classifies transient errors as retryable and permanent errors as non-retryable", () => {
    // Permanent errors -> retryable: false
    expect(
      classifyScanErrorForRetry(
        new ScanIntakeError(
          "ssrf_blocked",
          "Blocked private IPv4 target 127.0.0.1",
          403,
        ),
      ),
    ).toEqual(
      expect.objectContaining({
        retryable: false,
        failureClass: "ssrf_blocked",
      }),
    );

    expect(
      classifyScanErrorForRetry(
        new Error("getaddrinfo ENOTFOUND nonexistent.invalid"),
      ),
    ).toEqual(
      expect.objectContaining({
        retryable: false,
        failureClass: "dns_resolution_failed",
      }),
    );

    expect(
      classifyScanErrorForRetry(
        new Error("net::ERR_CERT_AUTHORITY_INVALID at https://expired.example"),
      ),
    ).toEqual(
      expect.objectContaining({
        retryable: false,
        failureClass: "upstream_blocked",
      }),
    );

    expect(
      classifyScanErrorForRetry(
        new Error("net::ERR_TOO_MANY_REDIRECTS at https://loop.example"),
      ),
    ).toEqual(
      expect.objectContaining({
        retryable: false,
        failureClass: "navigation_timeout",
      }),
    );

    expect(
      classifyScanErrorForRetry(
        new Error("Target returned permanent HTTP 404 Not Found"),
      ),
    ).toEqual(
      expect.objectContaining({
        retryable: false,
        failureClass: "upstream_blocked",
      }),
    );

    // Transient errors -> retryable: true
    expect(
      classifyScanErrorForRetry(
        new Error("Browser Rendering API HTTP 429 Too Many Requests"),
      ),
    ).toEqual(
      expect.objectContaining({
        retryable: true,
        failureClass: "browser_crash",
      }),
    );

    expect(
      classifyScanErrorForRetry(
        new Error("Upstream HTTP 503 Service Unavailable"),
      ),
    ).toEqual(
      expect.objectContaining({
        retryable: true,
        failureClass: "browser_crash",
      }),
    );

    expect(
      classifyScanErrorForRetry(
        new Error("Playwright navigation timed out after 25000ms"),
      ),
    ).toEqual(
      expect.objectContaining({
        retryable: true,
        failureClass: "navigation_timeout",
      }),
    );
  });

  it("attaches an AbortSignal timeout via fetchWithAbortTimeout", async () => {
    let observedSignal: AbortSignal | null | undefined;
    const res = await fetchWithAbortTimeout(
      "https://example.com/robots.txt",
      { method: "GET" },
      5_000,
      async (_input, init) => {
        observedSignal = init?.signal;
        return new Response("User-agent: *\nAllow: /\n", { status: 200 });
      },
    );

    expect(res.status).toBe(200);
    expect(observedSignal).toBeDefined();
    expect(observedSignal?.aborted).toBe(false);
  });

  it("guarantees zero leaked Browser, BrowserContext, or Page instances across 50 consecutive dual-viewport scans (including mid-scan errors)", async () => {
    const pool = createBrowserSessionPool({
      maxConcurrentBrowsers: 2,
      reuseWarmSession: false,
    });

    const baseLauncher = async (): Promise<PlaywrightBrowserLike> => ({
      async newContext(): Promise<PlaywrightBrowserContextLike> {
        return {
          async newPage(): Promise<PlaywrightPageLike> {
            const url = "https://example.com/";
            return {
              async addInitScript() {},
              async route() {},
              on() {},
              async goto(targetUrl: string) {
                if (targetUrl.includes("explode")) {
                  throw new Error("Simulated mid-navigation crash");
                }
                const req = {
                  url: () => targetUrl,
                  method: () => "GET",
                  resourceType: () => "document",
                  isNavigationRequest: () => true,
                  redirectedFrom: () => null,
                };
                return {
                  url: () => targetUrl,
                  status: () => 200,
                  headers: () => ({ "content-type": "text/html" }),
                  request: () => req,
                };
              },
              async waitForLoadState() {},
              async evaluate<R>() {
                return { ttfbMs: 15 } as unknown as R;
              },
              async content() {
                return "<html><head><title>OK</title></head><body>Body</body></html>";
              },
              async title() {
                return "OK";
              },
              url: () => url,
              async screenshot() {
                return new Uint8Array([137, 80, 78, 71]);
              },
              async close() {},
            };
          },
          async close() {},
        };
      },
      async close() {},
    });

    const trackedLauncher = pool.createTrackedLauncher(baseLauncher);

    for (let i = 0; i < 50; i += 1) {
      const targetUrl =
        i % 10 === 7
          ? `https://example.com/explode-${i}`
          : `https://example.com/page-${i}`;
      try {
        await capturePageAcrossViewports({
          targetUrl,
          browserLauncher: trackedLauncher,
          now: () => 1_760_000_000_000 + i * 100,
        });
      } catch {
        // Expected for simulated mid-navigation crash iterations
      }
    }

    await pool.closeIdleBrowsers();
    const stats = pool.getStats();

    expect(stats.activeBrowsers).toBe(0);
    expect(stats.activeContexts).toBe(0);
    expect(stats.activePages).toBe(0);
    expect(stats.totalContextsOpened).toBeGreaterThanOrEqual(90);
    expect(stats.totalContextsOpened).toBe(stats.totalContextsClosed);
    expect(stats.totalPagesOpened).toBe(stats.totalPagesClosed);
    expect(stats.totalBrowsersLaunched).toBe(stats.totalBrowsersClosed);
  });

  it("accumulates browserMs, r2BytesWritten, psiCalls, and page counts in D1 scans.usage_json", async () => {
    let currentUsageJson = JSON.stringify({
      browserDurationMs: 0,
      r2BytesWritten: 0,
      psiRequests: 0,
      pagesDiscovered: 0,
      pagesCaptured: 0,
    });

    const mockD1: D1DatabaseLike = {
      prepare(query: string) {
        return {
          bind(...values: unknown[]) {
            return {
              async first<T>() {
                if (query.includes("SELECT usage_json")) {
                  return { usage_json: currentUsageJson } as unknown as T;
                }
                return null;
              },
              async run() {
                if (query.includes("UPDATE scans SET usage_json")) {
                  currentUsageJson = String(values[0]);
                }
                return { success: true };
              },
            };
          },
          async first() {
            return null;
          },
          async run() {
            return { success: true };
          },
        };
      },
    };

    await updateScanUsageInD1({
      d1: mockD1,
      scanId: "scan_usage_1",
      increment: {
        browserMs: 4200,
        r2BytesWritten: 128_000,
        psiCalls: 2,
      },
      set: {
        pagesDiscovered: 5,
        pagesCaptured: 4,
      },
      nowMs: 1_760_000_000_000,
    });

    const updated = await updateScanUsageInD1({
      d1: mockD1,
      scanId: "scan_usage_1",
      increment: {
        browserMs: 1800,
        r2BytesWritten: 64_000,
        psiCalls: 1,
      },
      nowMs: 1_760_000_005_000,
    });

    expect(updated.browserMs).toBe(6000);
    expect(updated.browserDurationMs).toBe(6000);
    expect(updated.r2BytesWritten).toBe(192_000);
    expect(updated.psiCalls).toBe(3);
    expect(updated.psiRequests).toBe(3);
    expect(updated.pagesDiscovered).toBe(5);
    expect(updated.pagesCaptured).toBe(4);
  });
});
