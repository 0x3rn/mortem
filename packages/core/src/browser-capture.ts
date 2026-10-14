import type { BrowserBindingLike, D1DatabaseLike } from "./cloudflare";
import { READ_ONLY_SCAN_POLICY, isAllowedScanMethod } from "./index";
import {
  ScanIntakeError,
  preflightAndValidateTargetUrl,
  validateAndNormalizeIntakeUrl,
  type DohResolverFn,
} from "./intake";
import type {
  PageCaptureStatus,
  PageLoadTimingsJson,
  PageTemplateType,
  RedirectHop,
  ScanFailureClass,
} from "./schema/scans";

export const BROWSER_VIEWPORT_PROFILES = {
  desktop: {
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
  },
  mobile: {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  },
} as const;

export type CaptureViewportName = keyof typeof BROWSER_VIEWPORT_PROFILES;

export interface CapturedConsoleEntry {
  level: "error" | "warning" | "info" | "log";
  text: string;
  url?: string;
  lineNumber?: number;
  timestampMs: number;
}

export interface CapturedFailedRequest {
  url: string;
  method: string;
  resourceType: string;
  errorText?: string;
  statusCode?: number;
  blockedBySsrfGuard?: boolean;
  blockedByReadOnlyPolicy?: boolean;
}

export interface CapturedNetworkSummary {
  totalRequests: number;
  totalResponses: number;
  statusBuckets: Record<string, number>;
  failedRequests: CapturedFailedRequest[];
}

export type BotChallengeProvider =
  | "cloudflare_challenge"
  | "cloudflare_turnstile"
  | "captcha_challenge"
  | "waf_access_denied"
  | "rate_limited";

export interface BotChallengeDetectionResult {
  blocked: boolean;
  provider: BotChallengeProvider | null;
  reason: string | null;
}

export interface ViewportCaptureEvidence {
  viewport: CaptureViewportName;
  width: number;
  height: number;
  deviceScaleFactor: number;
  requestedUrl: string;
  finalUrl: string;
  statusCode: number | null;
  responseHeaders: Record<string, string>;
  redirectChain: RedirectHop[];
  title: string;
  renderedHtml: string;
  loadTimings: PageLoadTimingsJson;
  consoleEntries: CapturedConsoleEntry[];
  networkSummary: CapturedNetworkSummary;
  aboveTheFoldScreenshot: Uint8Array;
  fullPageScreenshot: Uint8Array;
  screenshotContentType: "image/png" | "image/webp";
  networkIdleTimedOut: boolean;
  htmlTruncated?: boolean;
  browserMs?: number;
  botChallenge: BotChallengeDetectionResult;
  captureStatus: "captured" | "partial" | "blocked";
}

export interface DualViewportPageCaptureResult {
  requestedUrl: string;
  normalizedUrl: string;
  finalUrl: string;
  statusCode: number | null;
  captureStatus: "captured" | "partial" | "blocked";
  dbCaptureStatus: PageCaptureStatus;
  failureClass: ScanFailureClass | null;
  failureReason: string | null;
  redirectChain: RedirectHop[];
  loadTimings: PageLoadTimingsJson;
  browserMs?: number;
  htmlTruncated?: boolean;
  desktop: ViewportCaptureEvidence;
  mobile: ViewportCaptureEvidence;
}

export interface PlaywrightRequestLike {
  url(): string;
  method(): string;
  resourceType(): string;
  isNavigationRequest(): boolean;
  failure?(): { errorText?: string } | null;
  redirectedFrom?(): PlaywrightRequestLike | null;
  redirectedTo?(): PlaywrightRequestLike | null;
  response?(): Promise<PlaywrightResponseLike | null>;
}

export interface PlaywrightResponseLike {
  url(): string;
  status(): number;
  headers(): Record<string, string>;
  request(): PlaywrightRequestLike;
}

export interface PlaywrightRouteLike {
  request(): PlaywrightRequestLike;
  continue(): Promise<void>;
  abort(errorCode?: string): Promise<void>;
}

export interface PlaywrightConsoleMessageLike {
  type(): string;
  text(): string;
  location?(): { url?: string; lineNumber?: number };
}

export interface PlaywrightPageLike {
  addInitScript(script: string | (() => void)): Promise<void>;
  route(
    urlPattern: string,
    handler: (route: PlaywrightRouteLike) => Promise<void> | void,
  ): Promise<void>;
  on(
    event: "console",
    listener: (msg: PlaywrightConsoleMessageLike) => void,
  ): void;
  on(event: "pageerror", listener: (err: Error) => void): void;
  on(
    event: "requestfailed",
    listener: (req: PlaywrightRequestLike) => void,
  ): void;
  on(event: "response", listener: (res: PlaywrightResponseLike) => void): void;
  goto(
    url: string,
    options?: {
      waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit";
      timeout?: number;
    },
  ): Promise<PlaywrightResponseLike | null>;
  waitForLoadState(
    state?: "load" | "domcontentloaded" | "networkidle",
    options?: { timeout?: number },
  ): Promise<void>;
  evaluate<R>(pageFunction: string | (() => R | Promise<R>)): Promise<R>;
  content(): Promise<string>;
  title(): Promise<string>;
  url(): string;
  screenshot(options?: {
    type?: "png" | "jpeg";
    fullPage?: boolean;
  }): Promise<Uint8Array | ArrayBuffer>;
  close(): Promise<void>;
}

export interface PlaywrightContextOptions {
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
  isMobile: boolean;
  hasTouch: boolean;
  userAgent: string;
  locale: string;
  timezoneId: string;
  javaScriptEnabled: boolean;
  serviceWorkers?: "allow" | "block";
}

export interface PlaywrightBrowserContextLike {
  newPage(): Promise<PlaywrightPageLike>;
  close(): Promise<void>;
}

export interface PlaywrightBrowserLike {
  newContext(
    options: PlaywrightContextOptions,
  ): Promise<PlaywrightBrowserContextLike>;
  close(): Promise<void>;
}

export type BrowserLauncherFn = (
  browserBinding?: BrowserBindingLike,
) => Promise<PlaywrightBrowserLike>;

export interface CapturePageAcrossViewportsOptions {
  targetUrl: string;
  browserBinding?: BrowserBindingLike;
  browserLauncher: BrowserLauncherFn;
  navigationTimeoutMs?: number;
  networkIdleTimeoutMs?: number;
  maxBytesPerPage?: number;
  runPreflight?: boolean;
  dohResolver?: DohResolverFn;
  fetchFn?: typeof fetch;
  now?: () => number;
}

export interface RequestSafetyDecision {
  allowed: boolean;
  normalizedUrl: string | null;
  blockedBySsrfGuard: boolean;
  blockedByReadOnlyPolicy: boolean;
  reason: string | null;
}

/**
 * Inspects outgoing Playwright requests to enforce:
 * 1. Read-only scanning policy (`GET` and `HEAD` only; never submit forms or mutate remote state)
 * 2. SSRF protection on every navigation and subresource request (blocking localhost, private/loopback/link-local/metadata IPs, and unsafe schemes)
 */
export function inspectBrowserRequestSafety(params: {
  url: string;
  method: string;
  resourceType?: string;
  isNavigationRequest?: boolean;
}): RequestSafetyDecision {
  const rawUrl = params.url.trim();
  const lower = rawUrl.toLowerCase();

  // Allow inline data: and blob: URLs only for non-navigation subresources (e.g. fonts/images/stylesheets)
  if (
    !params.isNavigationRequest &&
    (lower.startsWith("data:") || lower.startsWith("blob:"))
  ) {
    return {
      allowed: true,
      normalizedUrl: rawUrl,
      blockedBySsrfGuard: false,
      blockedByReadOnlyPolicy: false,
      reason: null,
    };
  }

  if (!isAllowedScanMethod(params.method)) {
    return {
      allowed: false,
      normalizedUrl: null,
      blockedBySsrfGuard: false,
      blockedByReadOnlyPolicy: true,
      reason: `Blocked non-read-only HTTP method '${params.method.toUpperCase()}' for ${rawUrl}`,
    };
  }

  try {
    const validated = validateAndNormalizeIntakeUrl(rawUrl);
    return {
      allowed: true,
      normalizedUrl: validated.normalizedUrl,
      blockedBySsrfGuard: false,
      blockedByReadOnlyPolicy: false,
      reason: null,
    };
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : `Blocked unsafe target URL: ${rawUrl}`;
    return {
      allowed: false,
      normalizedUrl: null,
      blockedBySsrfGuard: true,
      blockedByReadOnlyPolicy: false,
      reason: message,
    };
  }
}

/**
 * Detects WAF, anti-bot, CAPTCHA, or rate-limit challenge screens so Mortem
 * classifies the page as `blocked` (`upstream_blocked`) rather than scoring the challenge screen.
 */
export function detectBotChallengeOrBlock(params: {
  statusCode: number | null;
  responseHeaders: Record<string, string>;
  title: string;
  renderedHtml: string;
}): BotChallengeDetectionResult {
  const headersLower: Record<string, string> = {};
  for (const [key, value] of Object.entries(params.responseHeaders)) {
    headersLower[key.toLowerCase()] = value.toLowerCase();
  }

  const titleLower = params.title.trim().toLowerCase();
  const htmlLower = params.renderedHtml.toLowerCase();
  const status = params.statusCode;

  if (headersLower["cf-mitigated"]?.includes("challenge")) {
    return {
      blocked: true,
      provider: "cloudflare_challenge",
      reason: `Cloudflare challenge header (cf-mitigated: challenge${status ? `, HTTP ${status}` : ""})`,
    };
  }

  if (status === 429) {
    return {
      blocked: true,
      provider: "rate_limited",
      reason: "Target site returned HTTP 429 Too Many Requests.",
    };
  }

  const hasCloudflareChallengeMarkup =
    titleLower === "just a moment..." ||
    titleLower.includes("attention required! | cloudflare") ||
    htmlLower.includes("/cdn-cgi/challenge-platform/") ||
    htmlLower.includes("cf-browser-verification") ||
    htmlLower.includes("window._cf_chl_opt");

  if (hasCloudflareChallengeMarkup) {
    return {
      blocked: true,
      provider: "cloudflare_challenge",
      reason: `Cloudflare interstitial bot challenge detected (${params.title || `HTTP ${status ?? 403}`})`,
    };
  }

  const hasTurnstileInterstitial =
    (htmlLower.includes("challenges.cloudflare.com/turnstile") ||
      htmlLower.includes('class="cf-turnstile"')) &&
    (status === 403 ||
      status === 503 ||
      titleLower.includes("verify you are human") ||
      titleLower.includes("security check"));

  if (hasTurnstileInterstitial) {
    return {
      blocked: true,
      provider: "cloudflare_turnstile",
      reason: `Cloudflare Turnstile challenge screen detected (${params.title || `HTTP ${status ?? 403}`})`,
    };
  }

  const hasCaptchaInterstitial =
    titleLower.includes("verify you are human") ||
    titleLower.includes("are you a robot") ||
    titleLower.includes("human verification") ||
    htmlLower.includes("px-captcha") ||
    htmlLower.includes("datadome") ||
    (htmlLower.includes("g-recaptcha") &&
      (status === 403 || status === 503 || titleLower.includes("challenge")));

  if (hasCaptchaInterstitial) {
    return {
      blocked: true,
      provider: "captcha_challenge",
      reason: `Anti-bot CAPTCHA challenge screen detected (${params.title || `HTTP ${status ?? 403}`})`,
    };
  }

  if (
    status === 403 &&
    (titleLower.includes("access denied") ||
      titleLower.includes("403 forbidden") ||
      titleLower.includes("request blocked") ||
      htmlLower.includes("access denied") ||
      htmlLower.includes("akamaighost"))
  ) {
    return {
      blocked: true,
      provider: "waf_access_denied",
      reason: `WAF HTTP 403 Access Denied screen detected (${params.title || "403 Forbidden"})`,
    };
  }

  return {
    blocked: false,
    provider: null,
    reason: null,
  };
}

const PERFORMANCE_OBSERVER_INIT_SCRIPT = `
(() => {
  try {
    const state = { lcpMs: null, cls: 0 };
    Object.defineProperty(window, "__mortemPerf", {
      value: state,
      writable: false,
      configurable: true
    });
    if (typeof PerformanceObserver === "function") {
      try {
        const lcpObserver = new PerformanceObserver((entryList) => {
          const entries = entryList.getEntries();
          const last = entries[entries.length - 1];
          if (last && typeof last.startTime === "number") {
            state.lcpMs = Math.round(last.startTime);
          }
        });
        lcpObserver.observe({ type: "largest-contentful-paint", buffered: true });
      } catch {}
      try {
        const clsObserver = new PerformanceObserver((entryList) => {
          for (const entry of entryList.getEntries()) {
            if (!entry.hadRecentInput && typeof entry.value === "number") {
              state.cls = Number((state.cls + entry.value).toFixed(4));
            }
          }
        });
        clsObserver.observe({ type: "layout-shift", buffered: true });
      } catch {}
    }
  } catch {}
})();
`;

const COLLECT_TIMINGS_EVAL_SCRIPT = `
(() => {
  const navEntries = typeof performance !== "undefined" && typeof performance.getEntriesByType === "function"
    ? performance.getEntriesByType("navigation")
    : [];
  const nav = navEntries && navEntries[0] ? navEntries[0] : null;
  const paintEntries = typeof performance !== "undefined" && typeof performance.getEntriesByType === "function"
    ? performance.getEntriesByType("paint")
    : [];
  let fcpMs;
  if (Array.isArray(paintEntries)) {
    for (const entry of paintEntries) {
      if (entry && entry.name === "first-contentful-paint" && typeof entry.startTime === "number") {
        fcpMs = Math.round(entry.startTime);
      }
    }
  }
  const perf = window.__mortemPerf || {};
  return {
    ttfbMs: nav && typeof nav.responseStart === "number" ? Math.max(0, Math.round(nav.responseStart)) : undefined,
    domContentLoadedMs: nav && typeof nav.domContentLoadedEventEnd === "number" ? Math.max(0, Math.round(nav.domContentLoadedEventEnd)) : undefined,
    loadEventMs: nav && typeof nav.loadEventEnd === "number" && nav.loadEventEnd > 0 ? Math.max(0, Math.round(nav.loadEventEnd)) : undefined,
    fcpMs,
    lcpMs: typeof perf.lcpMs === "number" ? perf.lcpMs : undefined,
    cls: typeof perf.cls === "number" ? perf.cls : undefined
  };
})()
`;

const GENTLE_HYDRATION_SCROLL_SCRIPT = `
(async () => {
  try {
    const viewHeight = window.innerHeight || 800;
    const totalHeight = Math.max(
      document.body ? document.body.scrollHeight : 0,
      document.documentElement ? document.documentElement.scrollHeight : 0
    );
    const targetY = Math.min(totalHeight, viewHeight);
    window.scrollTo({ top: targetY, behavior: "instant" });
    await new Promise((resolve) => setTimeout(resolve, 60));
    window.scrollTo({ top: 0, behavior: "instant" });
  } catch {}
})()
`;

async function extractPlaywrightRedirectChain(
  response: PlaywrightResponseLike | null,
  fallbackChain: RedirectHop[],
): Promise<RedirectHop[]> {
  if (!response) {
    return [...fallbackChain];
  }

  const requests: PlaywrightRequestLike[] = [];
  let cursor: PlaywrightRequestLike | null = response.request();
  while (cursor) {
    requests.unshift(cursor);
    cursor =
      typeof cursor.redirectedFrom === "function"
        ? cursor.redirectedFrom()
        : null;
  }

  if (requests.length <= 1) {
    return [...fallbackChain];
  }

  const hops: RedirectHop[] = [];
  for (let i = 0; i < requests.length - 1; i += 1) {
    const fromReq = requests[i]!;
    const toReq = requests[i + 1]!;
    let statusCode = 302;
    if (typeof fromReq.response === "function") {
      try {
        const hopRes = await fromReq.response();
        if (hopRes) {
          statusCode = hopRes.status();
        }
      } catch {
        // Ignore hop status lookup error
      }
    }
    hops.push({
      fromUrl: fromReq.url(),
      toUrl: toReq.url(),
      statusCode,
    });
  }

  return hops;
}

function validateRedirectChainAndFinalUrlSafety(
  redirectChain: readonly RedirectHop[],
  finalUrl: string,
): void {
  for (const hop of redirectChain) {
    validateAndNormalizeIntakeUrl(hop.fromUrl);
    validateAndNormalizeIntakeUrl(hop.toUrl);
  }
  validateAndNormalizeIntakeUrl(finalUrl);
}

function toUint8Array(input: Uint8Array | ArrayBuffer): Uint8Array {
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

/**
 * Captures a single viewport (`desktop` or `mobile`) inside a fresh, isolated `BrowserContext`
 * with empty cookies/storage, `MortemBot/1.0` user agent, read-only & SSRF request filtering,
 * bounded `domcontentloaded` + `networkidle` wait (falling back to `partial` at timeout),
 * `PerformanceObserver` timings, and full-page + above-the-fold screenshots.
 * Always closes the `Page` and `BrowserContext` in `finally`.
 */
export async function captureSingleViewportInIsolatedContext(params: {
  browser: PlaywrightBrowserLike;
  viewportName: CaptureViewportName;
  targetUrl: string;
  preflightRedirectChain?: RedirectHop[];
  navigationTimeoutMs: number;
  networkIdleTimeoutMs: number;
  maxBytesPerPage?: number;
  now: () => number;
}): Promise<ViewportCaptureEvidence> {
  const viewportStartMs = params.now();
  const maxBytesPerPage = params.maxBytesPerPage ?? 10 * 1024 * 1024;
  const profile = BROWSER_VIEWPORT_PROFILES[params.viewportName];
  const context = await params.browser.newContext({
    viewport: profile.viewport,
    deviceScaleFactor: profile.deviceScaleFactor,
    isMobile: profile.isMobile,
    hasTouch: profile.hasTouch,
    userAgent: READ_ONLY_SCAN_POLICY.userAgent,
    locale: "en-US",
    timezoneId: "UTC",
    javaScriptEnabled: true,
    serviceWorkers: "block",
  });

  let page: PlaywrightPageLike | null = null;
  const consoleEntries: CapturedConsoleEntry[] = [];
  const failedRequests: CapturedFailedRequest[] = [];
  const statusBuckets: Record<string, number> = {};
  let totalRequests = 0;
  let totalResponses = 0;
  let blockedNavigationFailure: {
    url: string;
    reason: string;
  } | null = null;

  try {
    page = await context.newPage();

    await page.addInitScript(PERFORMANCE_OBSERVER_INIT_SCRIPT);

    await page.route("**/*", async (route) => {
      const req = route.request();
      totalRequests += 1;
      const decision = inspectBrowserRequestSafety({
        url: req.url(),
        method: req.method(),
        resourceType: req.resourceType(),
        isNavigationRequest: req.isNavigationRequest(),
      });

      if (!decision.allowed) {
        failedRequests.push({
          url: req.url(),
          method: req.method(),
          resourceType: req.resourceType(),
          errorText: decision.reason ?? "Blocked by Mortem safety policy",
          blockedBySsrfGuard: decision.blockedBySsrfGuard,
          blockedByReadOnlyPolicy: decision.blockedByReadOnlyPolicy,
        });
        if (req.isNavigationRequest() && decision.blockedBySsrfGuard) {
          blockedNavigationFailure = {
            url: req.url(),
            reason:
              decision.reason ??
              `Navigation target blocked by SSRF guard: ${req.url()}`,
          };
        }
        await route.abort("blockedbyclient");
        return;
      }

      await route.continue();
    });

    page.on("console", (msg) => {
      const rawType = msg.type().toLowerCase();
      const level: CapturedConsoleEntry["level"] =
        rawType === "error"
          ? "error"
          : rawType === "warning" || rawType === "warn"
            ? "warning"
            : rawType === "info"
              ? "info"
              : "log";
      if (level === "error" || level === "warning") {
        const loc = typeof msg.location === "function" ? msg.location() : {};
        consoleEntries.push({
          level,
          text: msg.text(),
          url: loc?.url,
          lineNumber: loc?.lineNumber,
          timestampMs: params.now(),
        });
      }
    });

    page.on("pageerror", (err) => {
      consoleEntries.push({
        level: "error",
        text: err instanceof Error ? err.message : String(err),
        timestampMs: params.now(),
      });
    });

    page.on("requestfailed", (req) => {
      const failure = typeof req.failure === "function" ? req.failure() : null;
      failedRequests.push({
        url: req.url(),
        method: req.method(),
        resourceType: req.resourceType(),
        errorText: failure?.errorText ?? "net::ERR_FAILED",
      });
    });

    page.on("response", (res) => {
      totalResponses += 1;
      const status = res.status();
      const bucket = `${Math.floor(status / 100)}xx`;
      statusBuckets[bucket] = (statusBuckets[bucket] ?? 0) + 1;
      if (status >= 400) {
        const req = res.request();
        failedRequests.push({
          url: res.url(),
          method: req.method(),
          resourceType: req.resourceType(),
          statusCode: status,
          errorText: `HTTP ${status}`,
        });
      }
    });

    const response = await page.goto(params.targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: params.navigationTimeoutMs,
    });

    if (blockedNavigationFailure !== null) {
      const failure: { url: string; reason: string } = blockedNavigationFailure;
      throw new ScanIntakeError("ssrf_blocked", failure.reason, 422);
    }

    const finalUrl = page.url() || response?.url() || params.targetUrl;
    const redirectChain = await extractPlaywrightRedirectChain(
      response,
      params.preflightRedirectChain ?? [],
    );

    // Re-verify every redirect hop and the final URL against the SSRF guard
    validateRedirectChainAndFinalUrlSafety(redirectChain, finalUrl);

    // Bounded network-idle wait: if the page never reaches networkidle (e.g. long-polling/analytics),
    // capture at the timeout mark and flag as `partial` rather than dropping the page!
    let networkIdleTimedOut = false;
    try {
      await page.waitForLoadState("networkidle", {
        timeout: params.networkIdleTimeoutMs,
      });
    } catch {
      networkIdleTimedOut = true;
    }

    // Gentle scroll pass to trigger hydration on lazy near-fold components without interacting or clicking
    await page.evaluate(GENTLE_HYDRATION_SCROLL_SCRIPT).catch(() => undefined);

    const loadTimings = await page
      .evaluate<PageLoadTimingsJson>(COLLECT_TIMINGS_EVAL_SCRIPT)
      .catch((): PageLoadTimingsJson => ({}));

    const rawRenderedHtml = await page.content();
    const rawHtmlBytes = new TextEncoder().encode(rawRenderedHtml);
    let renderedHtml = rawRenderedHtml;
    let htmlTruncated = false;
    if (rawHtmlBytes.byteLength > maxBytesPerPage) {
      htmlTruncated = true;
      renderedHtml = `${new TextDecoder("utf-8", { fatal: false }).decode(
        rawHtmlBytes.subarray(0, maxBytesPerPage),
      )}\n<!-- [MORTEM_TRUNCATED: HTML exceeded maxBytesPerPage budget] -->`;
    }

    const title = (await page.title().catch(() => "")) || finalUrl;
    const statusCode = response ? response.status() : null;
    const responseHeaders = response ? { ...response.headers() } : {};

    const aboveTheFoldBuffer = await page.screenshot({
      type: "png",
      fullPage: false,
    });
    const fullPageBuffer = await page.screenshot({
      type: "png",
      fullPage: true,
    });

    const botChallenge = detectBotChallengeOrBlock({
      statusCode,
      responseHeaders,
      title,
      renderedHtml,
    });

    const captureStatus: ViewportCaptureEvidence["captureStatus"] =
      botChallenge.blocked
        ? "blocked"
        : networkIdleTimedOut || htmlTruncated
          ? "partial"
          : "captured";

    const browserMs = Math.max(1, params.now() - viewportStartMs);

    return {
      viewport: params.viewportName,
      width: profile.viewport.width,
      height: profile.viewport.height,
      deviceScaleFactor: profile.deviceScaleFactor,
      requestedUrl: params.targetUrl,
      finalUrl,
      statusCode,
      responseHeaders,
      redirectChain,
      title,
      renderedHtml,
      loadTimings,
      consoleEntries,
      networkSummary: {
        totalRequests,
        totalResponses,
        statusBuckets,
        failedRequests,
      },
      aboveTheFoldScreenshot: toUint8Array(aboveTheFoldBuffer),
      fullPageScreenshot: toUint8Array(fullPageBuffer),
      screenshotContentType: "image/png",
      networkIdleTimedOut,
      htmlTruncated,
      browserMs,
      botChallenge,
      captureStatus,
    };
  } finally {
    if (page) {
      await page.close().catch(() => undefined);
    }
    await context.close().catch(() => undefined);
  }
}

/**
 * Renders a target page across both desktop (`1440×900`, scale 1) and mobile (`390×844`, scale 3, touch/mobile)
 * viewports using isolated `BrowserContext` instances on Cloudflare Browser Run (`@cloudflare/playwright`).
 * Re-verifies navigation and redirect targets against SSRF guards, captures hydrated DOM, headers, timings,
 * console/network logs, and screenshots, and detects WAF/bot challenges (`upstream_blocked`).
 */
export async function capturePageAcrossViewports(
  options: CapturePageAcrossViewportsOptions,
): Promise<DualViewportPageCaptureResult> {
  const now = options.now ?? (() => Date.now());
  const navigationTimeoutMs = options.navigationTimeoutMs ?? 20_000;
  const networkIdleTimeoutMs = options.networkIdleTimeoutMs ?? 4_000;
  const maxBytesPerPage = options.maxBytesPerPage ?? 10 * 1024 * 1024;

  // 1. Validate URL against SSRF guard (and run DoH + redirect preflight when enabled)
  const initialValidated = validateAndNormalizeIntakeUrl(options.targetUrl);
  let targetUrlToLoad = initialValidated.normalizedUrl;
  let preflightRedirectChain: RedirectHop[] = [];

  if (options.runPreflight || options.dohResolver || options.fetchFn) {
    const preflight = await preflightAndValidateTargetUrl(
      initialValidated.normalizedUrl,
      {
        dohResolver: options.dohResolver,
        fetchFn: options.fetchFn,
      },
    );
    targetUrlToLoad = preflight.finalUrl;
    preflightRedirectChain = preflight.redirectChain;
  }

  const browser = await options.browserLauncher(options.browserBinding);

  try {
    const desktop = await captureSingleViewportInIsolatedContext({
      browser,
      viewportName: "desktop",
      targetUrl: targetUrlToLoad,
      preflightRedirectChain,
      navigationTimeoutMs,
      networkIdleTimeoutMs,
      maxBytesPerPage,
      now,
    });

    const mobile = await captureSingleViewportInIsolatedContext({
      browser,
      viewportName: "mobile",
      targetUrl: targetUrlToLoad,
      preflightRedirectChain,
      navigationTimeoutMs,
      networkIdleTimeoutMs,
      maxBytesPerPage,
      now,
    });

    const isBlocked =
      desktop.captureStatus === "blocked" || mobile.captureStatus === "blocked";
    const htmlTruncated = Boolean(
      desktop.htmlTruncated || mobile.htmlTruncated,
    );
    const isPartial =
      !isBlocked &&
      (desktop.captureStatus === "partial" ||
        mobile.captureStatus === "partial");

    const captureStatus: DualViewportPageCaptureResult["captureStatus"] =
      isBlocked ? "blocked" : isPartial ? "partial" : "captured";

    const dbCaptureStatus: PageCaptureStatus = isBlocked
      ? "skipped"
      : isPartial
        ? "partial"
        : "captured";

    const failureClass: ScanFailureClass | null = isBlocked
      ? "upstream_blocked"
      : htmlTruncated
        ? "budget_exceeded"
        : null;

    const failureReason: string | null = isBlocked
      ? desktop.botChallenge.reason ||
        mobile.botChallenge.reason ||
        "Target page returned a WAF or bot challenge screen."
      : htmlTruncated
        ? `Rendered HTML exceeded maxBytesPerPage budget (${maxBytesPerPage} bytes) and was truncated.`
        : isPartial
          ? "Page did not reach network idle within timeout; captured at timeout mark as partial."
          : null;

    const redirectChain =
      desktop.redirectChain.length > 0
        ? desktop.redirectChain
        : mobile.redirectChain;

    const browserMs = (desktop.browserMs ?? 1) + (mobile.browserMs ?? 1);

    return {
      requestedUrl: options.targetUrl,
      normalizedUrl: initialValidated.normalizedUrl,
      finalUrl: desktop.finalUrl || mobile.finalUrl || targetUrlToLoad,
      statusCode: desktop.statusCode ?? mobile.statusCode,
      captureStatus,
      dbCaptureStatus,
      failureClass,
      failureReason,
      redirectChain,
      loadTimings: desktop.loadTimings,
      browserMs,
      htmlTruncated,
      desktop,
      mobile,
    };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

/**
 * Upserts a captured page row into D1 (`pages`) with its HTTP status, redirect chain,
 * load timings, and capture status (`captured`, `partial`, or `skipped` when blocked by WAF).
 */
export async function recordCapturedPageInD1(params: {
  d1: D1DatabaseLike;
  scanId: string;
  pageId?: string;
  templateType?: PageTemplateType;
  capture: DualViewportPageCaptureResult;
  nowMs?: number;
}): Promise<{ pageId: string }> {
  const nowMs = params.nowMs ?? Date.now();
  const existing = await params.d1
    .prepare(
      `SELECT id FROM pages WHERE scan_id = ? AND normalized_url = ? LIMIT 1`,
    )
    .bind(params.scanId, params.capture.normalizedUrl)
    .first<{ id: string }>();

  const pageId =
    existing?.id ??
    params.pageId ??
    `page_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const templateType = params.templateType ?? "home";

  if (existing?.id) {
    await params.d1
      .prepare(
        `UPDATE pages
         SET url = ?,
             status_code = ?,
             redirect_chain_json = ?,
             load_timings_json = ?,
             capture_status = ?,
             failure_reason = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .bind(
        params.capture.finalUrl,
        params.capture.statusCode,
        JSON.stringify(params.capture.redirectChain),
        JSON.stringify(params.capture.loadTimings),
        params.capture.dbCaptureStatus,
        params.capture.failureReason,
        nowMs,
        pageId,
      )
      .run();
  } else {
    await params.d1
      .prepare(
        `INSERT INTO pages (
          id, scan_id, url, normalized_url, template_type, status_code,
          redirect_chain_json, load_timings_json, capture_status, failure_reason,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        pageId,
        params.scanId,
        params.capture.finalUrl,
        params.capture.normalizedUrl,
        templateType,
        params.capture.statusCode,
        JSON.stringify(params.capture.redirectChain),
        JSON.stringify(params.capture.loadTimings),
        params.capture.dbCaptureStatus,
        params.capture.failureReason,
        nowMs,
        nowMs,
      )
      .run();
  }

  return { pageId };
}
