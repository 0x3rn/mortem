import { describe, expect, it } from "vitest";
import {
  BROWSER_VIEWPORT_PROFILES,
  READ_ONLY_SCAN_POLICY,
  capturePageAcrossViewports,
  detectBotChallengeOrBlock,
  inspectBrowserRequestSafety,
  type PlaywrightBrowserContextLike,
  type PlaywrightBrowserLike,
  type PlaywrightConsoleMessageLike,
  type PlaywrightContextOptions,
  type PlaywrightPageLike,
  type PlaywrightRequestLike,
  type PlaywrightResponseLike,
  type PlaywrightRouteLike,
} from "./index";

interface MockFixtureBehavior {
  finalUrl?: string;
  statusCode?: number;
  headers?: Record<string, string>;
  title?: string;
  renderedHtml?: string;
  redirectFromUrl?: string;
  redirectStatusCode?: number;
  networkIdleTimeout?: boolean;
  timings?: {
    ttfbMs?: number;
    domContentLoadedMs?: number;
    loadEventMs?: number;
    fcpMs?: number;
    lcpMs?: number;
    cls?: number;
  };
  subrequests?: {
    url: string;
    method?: string;
    resourceType?: string;
    isNavigationRequest?: boolean;
    statusCode?: number;
    failedErrorText?: string;
  }[];
  consoleMessages?: {
    type: string;
    text: string;
  }[];
  pageError?: string;
}

function createFixtureBrowser(behavior: MockFixtureBehavior = {}) {
  const createdContexts: {
    options: PlaywrightContextOptions;
    closed: boolean;
    pageClosed: boolean;
    abortedUrls: string[];
    continuedUrls: string[];
    initScriptsCount: number;
  }[] = [];
  let browserClosed = false;

  const browser: PlaywrightBrowserLike = {
    async newContext(
      options: PlaywrightContextOptions,
    ): Promise<PlaywrightBrowserContextLike> {
      const state = {
        options,
        closed: false,
        pageClosed: false,
        abortedUrls: [] as string[],
        continuedUrls: [] as string[],
        initScriptsCount: 0,
      };
      createdContexts.push(state);

      let routeHandler:
        ((route: PlaywrightRouteLike) => Promise<void> | void) | null = null;
      const consoleListeners: ((msg: PlaywrightConsoleMessageLike) => void)[] =
        [];
      const pageErrorListeners: ((err: Error) => void)[] = [];
      const requestFailedListeners: ((req: PlaywrightRequestLike) => void)[] =
        [];
      const responseListeners: ((res: PlaywrightResponseLike) => void)[] = [];
      let currentUrl = "about:blank";

      const page: PlaywrightPageLike = {
        async addInitScript() {
          state.initScriptsCount += 1;
        },
        async route(_pattern, handler) {
          routeHandler = handler;
        },
        on(event: string, listener: (...args: never[]) => void) {
          if (event === "console") {
            consoleListeners.push(
              listener as unknown as (
                msg: PlaywrightConsoleMessageLike,
              ) => void,
            );
          } else if (event === "pageerror") {
            pageErrorListeners.push(
              listener as unknown as (err: Error) => void,
            );
          } else if (event === "requestfailed") {
            requestFailedListeners.push(
              listener as unknown as (req: PlaywrightRequestLike) => void,
            );
          } else if (event === "response") {
            responseListeners.push(
              listener as unknown as (res: PlaywrightResponseLike) => void,
            );
          }
        },
        async goto(targetUrl) {
          currentUrl = behavior.finalUrl ?? targetUrl;

          if (routeHandler) {
            const navReq: PlaywrightRequestLike = {
              url: () => currentUrl,
              method: () => "GET",
              resourceType: () => "document",
              isNavigationRequest: () => true,
            };
            await routeHandler({
              request: () => navReq,
              continue: async () => {
                state.continuedUrls.push(currentUrl);
              },
              abort: async () => {
                state.abortedUrls.push(currentUrl);
              },
            });
          }

          for (const sub of behavior.subrequests ?? []) {
            const subReq: PlaywrightRequestLike = {
              url: () => sub.url,
              method: () => sub.method ?? "GET",
              resourceType: () => sub.resourceType ?? "fetch",
              isNavigationRequest: () => sub.isNavigationRequest ?? false,
              failure: () =>
                sub.failedErrorText ? { errorText: sub.failedErrorText } : null,
            };
            let wasAborted = false;
            if (routeHandler) {
              await routeHandler({
                request: () => subReq,
                continue: async () => {
                  state.continuedUrls.push(sub.url);
                },
                abort: async () => {
                  wasAborted = true;
                  state.abortedUrls.push(sub.url);
                },
              });
            }
            if (!wasAborted && sub.failedErrorText) {
              for (const l of requestFailedListeners) l(subReq);
            } else if (!wasAborted && sub.statusCode) {
              const subRes: PlaywrightResponseLike = {
                url: () => sub.url,
                status: () => sub.statusCode!,
                headers: () => ({}),
                request: () => subReq,
              };
              for (const l of responseListeners) l(subRes);
            }
          }

          for (const c of behavior.consoleMessages ?? []) {
            for (const l of consoleListeners) {
              l({
                type: () => c.type,
                text: () => c.text,
                location: () => ({ url: currentUrl, lineNumber: 12 }),
              });
            }
          }

          if (behavior.pageError) {
            for (const l of pageErrorListeners) {
              l(new Error(behavior.pageError));
            }
          }

          const initialHopReq: PlaywrightRequestLike | null =
            behavior.redirectFromUrl
              ? {
                  url: () => behavior.redirectFromUrl!,
                  method: () => "GET",
                  resourceType: () => "document",
                  isNavigationRequest: () => true,
                  redirectedFrom: () => null,
                  response: async () => ({
                    url: () => behavior.redirectFromUrl!,
                    status: () => behavior.redirectStatusCode ?? 301,
                    headers: () => ({ location: currentUrl }),
                    request: () => initialHopReq!,
                  }),
                }
              : null;

          const finalReq: PlaywrightRequestLike = {
            url: () => currentUrl,
            method: () => "GET",
            resourceType: () => "document",
            isNavigationRequest: () => true,
            redirectedFrom: () => initialHopReq,
          };

          const mainResponse: PlaywrightResponseLike = {
            url: () => currentUrl,
            status: () => behavior.statusCode ?? 200,
            headers: () =>
              behavior.headers ?? {
                "content-type": "text/html; charset=utf-8",
                "strict-transport-security": "max-age=63072000",
              },
            request: () => finalReq,
          };

          for (const l of responseListeners) l(mainResponse);
          return mainResponse;
        },
        async waitForLoadState(loadState) {
          if (loadState === "networkidle" && behavior.networkIdleTimeout) {
            throw new Error("Timeout 4000ms exceeded waiting for networkidle");
          }
        },
        async evaluate<R>(): Promise<R> {
          return (behavior.timings ?? {
            ttfbMs: 85,
            domContentLoadedMs: 340,
            loadEventMs: 620,
            fcpMs: 290,
            lcpMs: 780,
            cls: 0.012,
          }) as unknown as R;
        },
        async content() {
          return (
            behavior.renderedHtml ??
            "<!doctype html><html><head><title>Acme Cloud — Modern Infrastructure</title></head><body><main id='app'><h1>Ship faster with Acme Cloud</h1><a href='/signup'>Start free trial</a></main></body></html>"
          );
        },
        async title() {
          return behavior.title ?? "Acme Cloud — Modern Infrastructure";
        },
        url() {
          return currentUrl;
        },
        async screenshot(opts) {
          return opts?.fullPage
            ? new Uint8Array([137, 80, 78, 71, 1, 1, 1, 1])
            : new Uint8Array([137, 80, 78, 71, 0, 0, 0, 1]);
        },
        async close() {
          state.pageClosed = true;
        },
      };

      return {
        async newPage() {
          return page;
        },
        async close() {
          state.closed = true;
        },
      };
    },
    async close() {
      browserClosed = true;
    },
  };

  return {
    browser,
    createdContexts,
    isBrowserClosed: () => browserClosed,
  };
}

describe("Browser Run isolated desktop + mobile Playwright capture (THE-176)", () => {
  it("captures hydrated SPA DOM, timings, redirect chain, console/network logs, and screenshots across isolated desktop and mobile contexts", async () => {
    const fixture = createFixtureBrowser({
      redirectFromUrl: "https://acme.example.com/pricing",
      finalUrl: "https://www.acme.example.com/pricing",
      redirectStatusCode: 301,
      subrequests: [
        {
          url: "https://www.acme.example.com/static/app.js",
          method: "GET",
          resourceType: "script",
          statusCode: 200,
        },
        {
          url: "https://www.acme.example.com/api/broken-widget",
          method: "GET",
          resourceType: "fetch",
          statusCode: 502,
        },
        {
          url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA",
          method: "GET",
          resourceType: "image",
        },
      ],
      consoleMessages: [
        {
          type: "error",
          text: "Failed to load widget configuration: HTTP 502",
        },
      ],
    });

    const result = await capturePageAcrossViewports({
      targetUrl: "acme.example.com/pricing?utm_source=twitter",
      browserLauncher: async () => fixture.browser,
      now: () => 1_760_000_000_000,
    });

    expect(result.captureStatus).toBe("captured");
    expect(result.dbCaptureStatus).toBe("captured");
    expect(result.normalizedUrl).toBe("https://acme.example.com/pricing");
    expect(result.finalUrl).toBe("https://www.acme.example.com/pricing");
    expect(result.statusCode).toBe(200);
    expect(result.redirectChain).toEqual([
      {
        fromUrl: "https://acme.example.com/pricing",
        toUrl: "https://www.acme.example.com/pricing",
        statusCode: 301,
      },
    ]);

    // Verify both desktop (1440x900, scale 1) and mobile (390x844, scale 3, touch/mobile) contexts were isolated and closed
    expect(fixture.createdContexts).toHaveLength(2);
    const [desktopCtx, mobileCtx] = fixture.createdContexts;
    expect(desktopCtx?.options.viewport).toEqual(
      BROWSER_VIEWPORT_PROFILES.desktop.viewport,
    );
    expect(desktopCtx?.options.deviceScaleFactor).toBe(1);
    expect(desktopCtx?.options.isMobile).toBe(false);
    expect(desktopCtx?.options.userAgent).toBe(READ_ONLY_SCAN_POLICY.userAgent);
    expect(desktopCtx?.closed).toBe(true);
    expect(desktopCtx?.pageClosed).toBe(true);

    expect(mobileCtx?.options.viewport).toEqual(
      BROWSER_VIEWPORT_PROFILES.mobile.viewport,
    );
    expect(mobileCtx?.options.deviceScaleFactor).toBe(3);
    expect(mobileCtx?.options.isMobile).toBe(true);
    expect(mobileCtx?.options.hasTouch).toBe(true);
    expect(mobileCtx?.options.userAgent).toBe(READ_ONLY_SCAN_POLICY.userAgent);
    expect(mobileCtx?.closed).toBe(true);
    expect(mobileCtx?.pageClosed).toBe(true);
    expect(fixture.isBrowserClosed()).toBe(true);

    // Verify captured desktop and mobile artifacts
    expect(result.desktop.renderedHtml).toContain(
      "Ship faster with Acme Cloud",
    );
    expect(result.desktop.loadTimings.lcpMs).toBe(780);
    expect(result.desktop.loadTimings.cls).toBe(0.012);
    expect(result.desktop.consoleEntries).toHaveLength(1);
    expect(result.desktop.consoleEntries[0]?.text).toContain("HTTP 502");
    expect(result.desktop.networkSummary.failedRequests).toHaveLength(1);
    expect(result.desktop.networkSummary.failedRequests[0]?.statusCode).toBe(
      502,
    );
    expect(result.desktop.aboveTheFoldScreenshot.byteLength).toBeGreaterThan(0);
    expect(result.desktop.fullPageScreenshot.byteLength).toBeGreaterThan(0);
  });

  it("captures pages at the timeout mark and flags them as partial when networkidle never settles", async () => {
    const fixture = createFixtureBrowser({
      networkIdleTimeout: true,
      renderedHtml:
        "<!doctype html><html><head><title>Live Dashboard</title></head><body><h1>Real-time metrics</h1></body></html>",
    });

    const result = await capturePageAcrossViewports({
      targetUrl: "https://metrics.example.com/",
      browserLauncher: async () => fixture.browser,
      networkIdleTimeoutMs: 2_000,
    });

    expect(result.captureStatus).toBe("partial");
    expect(result.dbCaptureStatus).toBe("partial");
    expect(result.desktop.networkIdleTimedOut).toBe(true);
    expect(result.mobile.networkIdleTimedOut).toBe(true);
    expect(result.desktop.renderedHtml).toContain("Real-time metrics");
    expect(result.desktop.aboveTheFoldScreenshot.byteLength).toBeGreaterThan(0);
    expect(result.mobile.fullPageScreenshot.byteLength).toBeGreaterThan(0);
  });

  it("detects WAF / Cloudflare / CAPTCHA / HTTP 429 bot-challenge screens and classifies them as blocked (upstream_blocked)", async () => {
    const cfChallenge = detectBotChallengeOrBlock({
      statusCode: 403,
      responseHeaders: { "cf-mitigated": "challenge" },
      title: "Just a moment...",
      renderedHtml:
        "<html><head><title>Just a moment...</title></head><body><div id='cf-browser-verification'></div></body></html>",
    });
    expect(cfChallenge.blocked).toBe(true);
    expect(cfChallenge.provider).toBe("cloudflare_challenge");

    const fixture = createFixtureBrowser({
      statusCode: 403,
      headers: {
        "cf-mitigated": "challenge",
        "content-type": "text/html",
      },
      title: "Just a moment...",
      renderedHtml:
        "<!doctype html><html><head><title>Just a moment...</title></head><body><script src='/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1'></script></body></html>",
    });

    const result = await capturePageAcrossViewports({
      targetUrl: "https://protected.example.com/",
      browserLauncher: async () => fixture.browser,
    });

    expect(result.captureStatus).toBe("blocked");
    expect(result.dbCaptureStatus).toBe("skipped");
    expect(result.failureClass).toBe("upstream_blocked");
    expect(result.failureReason).toContain("Cloudflare challenge");
  });

  it("aborts SSRF subrequests and non-read-only POST requests inside the browser route guard and closes contexts in finally on SSRF redirect", async () => {
    expect(
      inspectBrowserRequestSafety({
        url: "http://169.254.169.254/latest/meta-data/",
        method: "GET",
      }),
    ).toMatchObject({
      allowed: false,
      blockedBySsrfGuard: true,
    });

    expect(
      inspectBrowserRequestSafety({
        url: "https://acme.example.com/api/lead-form",
        method: "POST",
      }),
    ).toMatchObject({
      allowed: false,
      blockedByReadOnlyPolicy: true,
    });

    // Subrequests to metadata IP and POST endpoints are aborted while page load succeeds
    const subrequestFixture = createFixtureBrowser({
      subrequests: [
        {
          url: "http://169.254.169.254/latest/meta-data/",
          method: "GET",
          resourceType: "fetch",
        },
        {
          url: "https://acme.example.com/api/mutate",
          method: "POST",
          resourceType: "fetch",
        },
      ],
    });

    const result = await capturePageAcrossViewports({
      targetUrl: "https://acme.example.com/",
      browserLauncher: async () => subrequestFixture.browser,
    });

    expect(subrequestFixture.createdContexts[0]?.abortedUrls).toEqual([
      "http://169.254.169.254/latest/meta-data/",
      "https://acme.example.com/api/mutate",
    ]);
    expect(result.desktop.networkSummary.failedRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: "http://169.254.169.254/latest/meta-data/",
          blockedBySsrfGuard: true,
        }),
        expect.objectContaining({
          url: "https://acme.example.com/api/mutate",
          blockedByReadOnlyPolicy: true,
        }),
      ]),
    );

    // If main navigation redirects to an internal SSRF IP, capturePageAcrossViewports throws and still closes contexts
    const ssrfRedirectFixture = createFixtureBrowser({
      redirectFromUrl: "https://acme.example.com/",
      finalUrl: "http://127.0.0.1:8080/internal",
    });

    await expect(
      capturePageAcrossViewports({
        targetUrl: "https://acme.example.com/",
        browserLauncher: async () => ssrfRedirectFixture.browser,
      }),
    ).rejects.toThrow();

    expect(ssrfRedirectFixture.createdContexts[0]?.closed).toBe(true);
    expect(ssrfRedirectFixture.createdContexts[0]?.pageClosed).toBe(true);
    expect(ssrfRedirectFixture.isBrowserClosed()).toBe(true);
  });
});
