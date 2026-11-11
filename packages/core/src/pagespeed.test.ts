import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CRUX_UNAVAILABLE_MESSAGE,
  PERFORMANCE_AUDIT_RULES,
  PERFORMANCE_METRIC_RULES,
  PERFORMANCE_RULE_IDS,
  PSI_MAPPED_AUDIT_IDS,
  PSI_UNAVAILABLE_REASONS,
  buildPsiRequestUrl,
  evaluatePerformanceRules,
  fetchPageSpeedInsights,
  parsePsiResponse,
  rateMetric,
  redactPsiSecrets,
  runWithConcurrency,
  type ParsedPsiData,
  type PerformanceRuleInput,
} from "./pagespeed";

/*
 * Fixtures named `recorded-*` are real PageSpeed Insights v5 responses
 * (Lighthouse 13.6.0) captured with scripts/record-psi-fixtures.mjs; screenshots
 * and the raw network log are trimmed. Expected values below were read from the
 * raw JSON independently of the parser. `synthetic-*` fixtures cover cases no
 * live site produced (no CrUX data at all, HTTP 200 with a runtimeError).
 */
const FIXTURE_DIR = resolve(__dirname, "__fixtures__/psi");

function fixtureText(name: string): string {
  return readFileSync(resolve(FIXTURE_DIR, name), "utf8");
}

function fixtureJson(name: string): unknown {
  return JSON.parse(fixtureText(name));
}

function parsedFixture(
  name: string,
  strategy: "mobile" | "desktop",
): ParsedPsiData {
  const result = parsePsiResponse(fixtureJson(name), strategy);
  if (!result.ok) {
    throw new Error(`Fixture ${name} did not parse: ${result.message}`);
  }
  return result.data;
}

const CNN_MOBILE = "recorded-www.cnn.com-mobile.json";
const CNN_DESKTOP = "recorded-www.cnn.com-desktop.json";
const WEBDEV_MOBILE = "recorded-web.dev-mobile.json";
const WEBDEV_DESKTOP = "recorded-web.dev-desktop.json";
const CERN_MOBILE = "recorded-info.cern.ch-mobile.json";
const CERN_DESKTOP = "recorded-info.cern.ch-desktop.json";
const HTTPBIN_ORIGIN_FALLBACK =
  "recorded-httpbin.org-origin-fallback-mobile.json";

const API_KEY = "AIzaSyTESTKEY-do-not-leak-0123456789";
const noSleep = async (ms: number): Promise<void> => {
  void ms;
};

function jsonResponse(
  body: string,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function mockFetch(): ReturnType<typeof vi.fn> & typeof fetch {
  return vi.fn() as unknown as ReturnType<typeof vi.fn> & typeof fetch;
}

describe("PSI request building and secret redaction", () => {
  it("builds a v5 URL with uppercase strategy, PERFORMANCE category and encoded target", () => {
    const url = new URL(
      buildPsiRequestUrl({
        url: "https://example.com/a path?x=1&y=2",
        strategy: "mobile",
        apiKey: API_KEY,
      }),
    );
    expect(url.origin + url.pathname).toBe(
      "https://www.googleapis.com/pagespeedonline/v5/runPagespeed",
    );
    expect(url.searchParams.get("url")).toBe(
      "https://example.com/a path?x=1&y=2",
    );
    expect(url.searchParams.get("strategy")).toBe("MOBILE");
    expect(url.searchParams.get("category")).toBe("PERFORMANCE");
    expect(url.searchParams.get("key")).toBe(API_KEY);
  });

  it("redacts both key= query values and the literal key", () => {
    const text = `GET https://x/?url=a&key=${API_KEY}&z=1 failed; token ${API_KEY}`;
    const redacted = redactPsiSecrets(text, API_KEY);
    expect(redacted).not.toContain(API_KEY);
    expect(redacted).toContain("key=REDACTED");
  });
});

describe("fetchPageSpeedInsights", () => {
  it("does not call the network and reports api_key_missing without a key", async () => {
    const fetchFn = mockFetch();
    for (const apiKey of [undefined, null, "", "   "]) {
      const result = await fetchPageSpeedInsights({
        url: "https://example.com/",
        strategy: "mobile",
        apiKey,
        fetchFn,
      });
      expect(result).toMatchObject({
        status: "unavailable",
        reason: "api_key_missing",
        attempts: 0,
      });
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("returns the verbatim response body of a recorded success", async () => {
    const body = fixtureText(CNN_MOBILE);
    const fetchFn = mockFetch().mockResolvedValue(jsonResponse(body));
    const result = await fetchPageSpeedInsights({
      url: "https://www.cnn.com/",
      strategy: "mobile",
      apiKey: API_KEY,
      fetchFn,
      sleep: noSleep,
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.rawText).toBe(body);
    expect(result.attempts).toBe(1);
    const calledUrl = new URL(
      (fetchFn.mock.calls[0] as unknown[])[0] as string,
    );
    expect(calledUrl.searchParams.get("strategy")).toBe("MOBILE");
  });

  it("does not retry the recorded daily-quota 429 and reports quota_exceeded", async () => {
    const fetchFn = mockFetch().mockResolvedValue(
      jsonResponse(fixtureText("recorded-quota-exceeded-429.json"), 429),
    );
    const sleep = vi.fn(noSleep);
    const result = await fetchPageSpeedInsights({
      url: "https://example.com/",
      strategy: "desktop",
      apiKey: API_KEY,
      fetchFn,
      sleep,
    });
    expect(result).toMatchObject({
      status: "unavailable",
      reason: "quota_exceeded",
      httpStatus: 429,
      attempts: 1,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("classifies the recorded invalid-key 400 as api_key_rejected without retrying", async () => {
    const fetchFn = mockFetch().mockResolvedValue(
      jsonResponse(fixtureText("recorded-api-key-invalid-400.json"), 400),
    );
    const result = await fetchPageSpeedInsights({
      url: "https://example.com/",
      strategy: "mobile",
      apiKey: API_KEY,
      fetchFn,
      sleep: noSleep,
    });
    expect(result).toMatchObject({
      reason: "api_key_rejected",
      httpStatus: 400,
      attempts: 1,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("classifies the recorded Lighthouse NO_FCP 400 as lighthouse_runtime_error, not a bad request", async () => {
    const fetchFn = mockFetch().mockResolvedValue(
      jsonResponse(
        fixtureText("recorded-lighthouse-error-no-fcp-400.json"),
        400,
      ),
    );
    const result = await fetchPageSpeedInsights({
      url: "https://neverssl.com/",
      strategy: "mobile",
      apiKey: API_KEY,
      fetchFn,
      sleep: noSleep,
    });
    expect(result).toMatchObject({
      status: "unavailable",
      reason: "lighthouse_runtime_error",
      httpStatus: 400,
      attempts: 1,
    });
    expect(result.status === "unavailable" && result.message).toContain(
      "NO_FCP",
    );
  });

  it("classifies a FAILED_DOCUMENT_REQUEST error as target_unreachable without retrying", async () => {
    const fetchFn = mockFetch().mockResolvedValue(
      jsonResponse(
        JSON.stringify({
          error: {
            code: 500,
            message:
              "Lighthouse returned error: FAILED_DOCUMENT_REQUEST. Lighthouse was unable to reliably load the page you requested.",
          },
        }),
        500,
      ),
    );
    const result = await fetchPageSpeedInsights({
      url: "https://blocked.example.test/",
      strategy: "mobile",
      apiKey: API_KEY,
      fetchFn,
      sleep: noSleep,
    });
    expect(result).toMatchObject({ reason: "target_unreachable", attempts: 1 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("retries a per-minute 429 honouring Retry-After, then succeeds", async () => {
    const perMinute = JSON.stringify({
      error: {
        code: 429,
        message: "Quota exceeded for quota metric 'Queries' per minute",
        errors: [{ reason: "rateLimitExceeded" }],
      },
    });
    const fetchFn = mockFetch()
      .mockResolvedValueOnce(
        jsonResponse(perMinute, 429, { "retry-after": "2" }),
      )
      .mockResolvedValueOnce(jsonResponse(fixtureText(CNN_MOBILE)));
    const sleep = vi.fn(noSleep);
    const result = await fetchPageSpeedInsights({
      url: "https://www.cnn.com/",
      strategy: "mobile",
      apiKey: API_KEY,
      fetchFn,
      sleep,
    });
    expect(result.status).toBe("ok");
    expect(result.attempts).toBe(2);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(2000);
  });

  it("caps an absurd Retry-After at 30 seconds", async () => {
    const perMinute = JSON.stringify({
      error: { code: 429, message: "Too many requests per minute" },
    });
    const fetchFn = mockFetch()
      .mockResolvedValueOnce(
        jsonResponse(perMinute, 429, { "retry-after": "86400" }),
      )
      .mockResolvedValueOnce(jsonResponse(fixtureText(CNN_MOBILE)));
    const sleep = vi.fn(noSleep);
    await fetchPageSpeedInsights({
      url: "https://www.cnn.com/",
      strategy: "mobile",
      apiKey: API_KEY,
      fetchFn,
      sleep,
    });
    expect(sleep).toHaveBeenCalledExactlyOnceWith(30_000);
  });

  it("retries a transient 5xx once (2 attempts by default), as a live CNN 500 recovered on retry", async () => {
    const fetchFn = mockFetch().mockImplementation(async () =>
      jsonResponse(
        JSON.stringify({
          error: { code: 500, message: "Internal error encountered." },
        }),
        500,
      ),
    );
    const sleep = vi.fn(noSleep);
    const result = await fetchPageSpeedInsights({
      url: "https://example.com/",
      strategy: "mobile",
      apiKey: API_KEY,
      fetchFn,
      sleep,
    });
    expect(result).toMatchObject({
      status: "unavailable",
      reason: "upstream_error",
      httpStatus: 500,
      attempts: 2,
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000]);
  });

  it("maps 403 to api_key_rejected and a plain 400 to invalid_request", async () => {
    const forbidden = mockFetch().mockResolvedValue(
      jsonResponse(
        JSON.stringify({
          error: { code: 403, message: "The caller does not have permission" },
        }),
        403,
      ),
    );
    expect(
      await fetchPageSpeedInsights({
        url: "https://example.com/",
        strategy: "mobile",
        apiKey: API_KEY,
        fetchFn: forbidden,
        sleep: noSleep,
      }),
    ).toMatchObject({ reason: "api_key_rejected", attempts: 1 });

    const badRequest = mockFetch().mockResolvedValue(
      jsonResponse(
        JSON.stringify({
          error: { code: 400, message: "Invalid value at 'url'" },
        }),
        400,
      ),
    );
    expect(
      await fetchPageSpeedInsights({
        url: "not a url",
        strategy: "mobile",
        apiKey: API_KEY,
        fetchFn: badRequest,
        sleep: noSleep,
      }),
    ).toMatchObject({ reason: "invalid_request", attempts: 1 });
  });

  it("reports timeout once and does not retry", async () => {
    const fetchFn = mockFetch().mockRejectedValue(
      new DOMException("The operation timed out.", "TimeoutError"),
    );
    const sleep = vi.fn(noSleep);
    const result = await fetchPageSpeedInsights({
      url: "https://slow.example.test/",
      strategy: "mobile",
      apiKey: API_KEY,
      timeoutMs: 1234,
      fetchFn,
      sleep,
    });
    expect(result).toMatchObject({
      status: "unavailable",
      reason: "timeout",
      attempts: 1,
    });
    expect(result.status === "unavailable" && result.message).toContain("1234");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("passes an abort signal so every attempt is bounded", async () => {
    const fetchFn = mockFetch().mockResolvedValue(
      jsonResponse(fixtureText(CNN_MOBILE)),
    );
    await fetchPageSpeedInsights({
      url: "https://www.cnn.com/",
      strategy: "mobile",
      apiKey: API_KEY,
      fetchFn,
    });
    const init = (fetchFn.mock.calls[0] as unknown[])[1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.method).toBe("GET");
  });

  it("retries network errors and never leaks the API key in the message", async () => {
    const fetchFn = mockFetch().mockRejectedValue(
      new TypeError(
        `fetch failed for https://www.googleapis.com/x?key=${API_KEY} token ${API_KEY}`,
      ),
    );
    const result = await fetchPageSpeedInsights({
      url: "https://example.com/",
      strategy: "mobile",
      apiKey: API_KEY,
      fetchFn,
      sleep: noSleep,
    });
    expect(result).toMatchObject({
      status: "unavailable",
      reason: "network_error",
      attempts: 2,
    });
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });

  it("redacts the key even when Google echoes it in an error body", async () => {
    const fetchFn = mockFetch().mockResolvedValue(
      jsonResponse(
        JSON.stringify({
          error: { code: 400, message: `API key not valid: ${API_KEY}` },
        }),
        400,
      ),
    );
    const result = await fetchPageSpeedInsights({
      url: "https://example.com/",
      strategy: "mobile",
      apiKey: API_KEY,
      fetchFn,
      sleep: noSleep,
    });
    expect(result).toMatchObject({ reason: "api_key_rejected" });
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });

  it("reports invalid_response for a 200 with a non-JSON body", async () => {
    const fetchFn = mockFetch().mockResolvedValue(
      new Response("<html>oops</html>", { status: 200 }),
    );
    expect(
      await fetchPageSpeedInsights({
        url: "https://example.com/",
        strategy: "mobile",
        apiKey: API_KEY,
        fetchFn,
        sleep: noSleep,
      }),
    ).toMatchObject({ reason: "invalid_response", attempts: 1 });
  });
});

describe("fetchPageSpeedInsights stage time budget", () => {
  it("does not call PSI at all when the budget is already spent", async () => {
    const fetchFn = mockFetch();
    const result = await fetchPageSpeedInsights({
      url: "https://example.com/",
      strategy: "mobile",
      apiKey: API_KEY,
      fetchFn,
      now: () => 1_000_000,
      deadlineAt: 1_000_000 + 9_999, // just under the 10 s minimum per attempt
    });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "unavailable",
      reason: "timeout",
      attempts: 0,
    });
    expect(result.status === "unavailable" && result.message).toContain(
      "time budget",
    );
  });

  it("shrinks the attempt timeout to the time left in the budget", async () => {
    const fetchFn = mockFetch().mockRejectedValue(
      new DOMException("The operation timed out.", "TimeoutError"),
    );
    const result = await fetchPageSpeedInsights({
      url: "https://example.com/",
      strategy: "mobile",
      apiKey: API_KEY,
      fetchFn,
      timeoutMs: 240_000,
      now: () => 1_000_000,
      deadlineAt: 1_030_000,
    });
    expect(result).toMatchObject({ reason: "timeout", attempts: 1 });
    expect(result.status === "unavailable" && result.message).toContain(
      "30000 ms",
    );
  });

  it("stops retrying when the budget runs out between attempts and keeps the real failure", async () => {
    let clock = 1_000_000;
    const fetchFn = mockFetch().mockImplementation(async () => {
      clock += 200_000; // the call itself used most of the budget
      return jsonResponse(
        JSON.stringify({ error: { code: 503, message: "Backend busy" } }),
        503,
      );
    });
    const result = await fetchPageSpeedInsights({
      url: "https://example.com/",
      strategy: "mobile",
      apiKey: API_KEY,
      fetchFn,
      sleep: noSleep,
      now: () => clock,
      deadlineAt: 1_205_000,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      reason: "upstream_error",
      httpStatus: 503,
      attempts: 1,
    });
  });
});

describe("runWithConcurrency", () => {
  it("preserves order and never exceeds the concurrency cap", async () => {
    let inFlight = 0;
    let peak = 0;
    const results = await runWithConcurrency(
      [1, 2, 3, 4, 5, 6],
      2,
      async (n) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolveTimer) => setTimeout(resolveTimer, 5));
        inFlight -= 1;
        return n * 10;
      },
    );
    expect(results).toEqual([10, 20, 30, 40, 50, 60]);
    expect(peak).toBe(2);
  });

  it("handles empty input and clamps nonsensical limits", async () => {
    expect(await runWithConcurrency([], 3, async (n: number) => n)).toEqual([]);
    expect(await runWithConcurrency([1, 2], 0, async (n) => n)).toEqual([1, 2]);
  });
});

describe("parsePsiResponse on recorded Lighthouse 13 responses", () => {
  it("extracts lab metrics and URL-level CrUX data from the recorded CNN mobile run", () => {
    const data = parsedFixture(CNN_MOBILE, "mobile");
    expect(data.lighthouseVersion).toBe("13.6.0");
    expect(data.lab).toEqual({
      performanceScore: 36,
      lcpMs: 21367.50368044048,
      cls: 0,
      tbtMs: 795.5,
      fcpMs: 8596.189042684844,
      speedIndexMs: 14722.123786499367,
      ttfbMs: 173,
    });
    expect(data.field).toMatchObject({
      available: true,
      scope: "url",
      overallCategory: "FAST",
      lcp: { p75: 1531, googleCategory: "FAST" },
      inp: { p75: 161, googleCategory: "FAST" },
    });
    // CrUX reports CLS x100 (bucket bounds 10 and 25): percentile 4 means 0.04.
    expect(data.field.available && data.field.cls?.p75).toBeCloseTo(0.04, 10);
  });

  it("reads Lighthouse 13 insight audits, citing real asset URLs and savings", () => {
    const data = parsedFixture(CNN_MOBILE, "mobile");
    const byId = new Map(data.audits.map((a) => [a.auditId, a]));
    expect([...byId.keys()]).toEqual([...PSI_MAPPED_AUDIT_IDS]);

    // Insight savings live in metricSavings (FCP 650) and the item table.
    expect(byId.get("render-blocking-insight")).toMatchObject({
      status: "opportunity",
      savingsMs: 650,
      savingsBytes: null,
    });
    expect(byId.get("render-blocking-insight")!.items[0]).toMatchObject({
      url: "https://cdn.optimizely.com/public/125375509/s/landingprod.js",
      wastedMs: 1954,
      totalBytes: 123360,
      inlineCode: false,
    });

    // Byte savings come from details.debugData.wastedBytes.
    const images = byId.get("image-delivery-insight")!;
    expect(images).toMatchObject({
      status: "opportunity",
      savingsBytes: 98991,
      savingsMs: 0,
    });
    expect(images.items[0]!.url).toMatch(
      /^https:\/\/media\.cnn\.com\/api\/v1\/images\/stellar\/prod\/cliff-jumping-thumb-w-gfx-1\.png/,
    );
    expect(images.items[0]!.wastedBytes).toBe(27909);

    expect(byId.get("unused-javascript")).toMatchObject({
      status: "opportunity",
      savingsMs: 4490,
      savingsBytes: 1977415,
    });
    // 22 cited scripts in the response; Mortem keeps the 10 largest.
    expect(byId.get("unused-javascript")!.items).toHaveLength(10);

    expect(byId.get("server-response-time")).toMatchObject({
      status: "passed",
      numericValue: 173,
    });
    expect(byId.get("server-response-time")!.items[0]).toMatchObject({
      url: "https://www.cnn.com/",
      durationMs: 173,
    });
  });

  it("does not treat an inline CSS snippet as an asset URL", () => {
    const data = parsedFixture(CNN_MOBILE, "mobile");
    const css = data.audits.find((a) => a.auditId === "unused-css-rules")!;
    expect(css).toMatchObject({ status: "opportunity", savingsBytes: 319158 });
    expect(css.items[0]).toMatchObject({
      url: null,
      inlineCode: true,
      wastedBytes: 293410,
    });
  });

  it("applies Mortem's DOM threshold when Lighthouse reports DOM size as informative", () => {
    // CNN: informative, 2,640 elements => opportunity.
    const cnn = parsedFixture(CNN_MOBILE, "mobile").audits.find(
      (a) => a.auditId === "dom-size-insight",
    )!;
    expect(cnn).toMatchObject({ status: "opportunity", numericValue: 2640 });
    // web.dev mobile: informative, 843 elements => passed.
    const webdevMobile = parsedFixture(WEBDEV_MOBILE, "mobile").audits.find(
      (a) => a.auditId === "dom-size-insight",
    )!;
    expect(webdevMobile).toMatchObject({ status: "passed", numericValue: 843 });
    // web.dev desktop: Lighthouse scored it (numeric, score 1) => passed as-is.
    const webdevDesktop = parsedFixture(WEBDEV_DESKTOP, "desktop").audits.find(
      (a) => a.auditId === "dom-size-insight",
    )!;
    expect(webdevDesktop).toMatchObject({
      status: "passed",
      numericValue: 843,
    });
  });

  it("keeps an errored server-response-time audit as null, never zero (recorded info.cern.ch mobile)", () => {
    const data = parsedFixture(CERN_MOBILE, "mobile");
    expect(data.lab.ttfbMs).toBeNull();
    expect(data.lab.performanceScore).toBe(100);
    expect(
      data.audits.find((a) => a.auditId === "server-response-time")!.status,
    ).toBe("error");
  });

  it("uses origin-level CrUX when PSI reports an origin fallback (recorded httpbin.org)", () => {
    const data = parsedFixture(HTTPBIN_ORIGIN_FALLBACK, "mobile");
    expect(data.field).toMatchObject({ available: true, scope: "origin" });
  });

  it("reports CrUX as unavailable with the exact user-facing message", () => {
    const data = parsedFixture(
      "synthetic-mobile-no-crux-errored-audit.json",
      "mobile",
    );
    expect(data.field).toEqual({
      available: false,
      message: "Not enough real-user traffic (CrUX unavailable)",
    });
    expect(data.field.available === false && data.field.message).toBe(
      CRUX_UNAVAILABLE_MESSAGE,
    );
  });

  it("never invents values for errored, missing or unscored audits", () => {
    const data = parsedFixture(
      "synthetic-mobile-no-crux-errored-audit.json",
      "mobile",
    );
    expect(data.lab).toEqual({
      performanceScore: null,
      lcpMs: null,
      cls: 0,
      tbtMs: null,
      fcpMs: 1700,
      speedIndexMs: null,
      ttfbMs: null,
    });
    const byId = new Map(data.audits.map((a) => [a.auditId, a.status]));
    expect(byId.get("server-response-time")).toBe("error");
    expect(byId.get("unused-javascript")).toBe("not_applicable");
    expect(byId.get("dom-size-insight")).toBe("missing");
  });

  it("surfaces a Lighthouse runtimeError in a 200 response as target_unreachable", () => {
    const result = parsePsiResponse(
      fixtureJson("synthetic-runtime-error-unreachable.json"),
      "mobile",
    );
    expect(result).toMatchObject({ ok: false, reason: "target_unreachable" });
    expect(!result.ok && result.message).toContain("FAILED_DOCUMENT_REQUEST");
  });

  it("maps other runtime errors to lighthouse_runtime_error", () => {
    const result = parsePsiResponse(
      {
        lighthouseResult: {
          runtimeError: { code: "NO_FCP", message: "No paint" },
          audits: {},
        },
      },
      "mobile",
    );
    expect(result).toMatchObject({
      ok: false,
      reason: "lighthouse_runtime_error",
    });
  });

  it("rejects malformed responses instead of guessing", () => {
    for (const bad of [
      null,
      "text",
      42,
      [],
      {},
      { lighthouseResult: {} },
      { lighthouseResult: "x" },
    ]) {
      expect(parsePsiResponse(bad, "mobile")).toMatchObject({
        ok: false,
        reason: "invalid_response",
      });
    }
  });

  it("ignores non-finite or string numbers rather than propagating them", () => {
    const result = parsePsiResponse(
      {
        lighthouseResult: {
          categories: { performance: { score: "0.9" } },
          audits: {
            "largest-contentful-paint": {
              scoreDisplayMode: "numeric",
              numericValue: Number.NaN,
            },
            "total-blocking-time": {
              scoreDisplayMode: "numeric",
              numericValue: "100",
            },
          },
        },
      },
      "mobile",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.lab.performanceScore).toBeNull();
    expect(result.data.lab.lcpMs).toBeNull();
    expect(result.data.lab.tbtMs).toBeNull();
  });
});

describe("documentation and schema stay in sync with the code", () => {
  const doc = readFileSync(
    resolve(__dirname, "../../../docs/rule-catalog/performance.md"),
    "utf8",
  );
  const migration = readFileSync(
    resolve(__dirname, "../migrations/0004_page_performance_results.sql"),
    "utf8",
  );

  it("documents every rule id and every mapped Lighthouse audit", () => {
    for (const id of PERFORMANCE_RULE_IDS) {
      expect(doc, `rule ${id} missing from the catalog`).toContain(`\`${id}\``);
    }
    for (const auditId of PSI_MAPPED_AUDIT_IDS) {
      expect(doc, `audit ${auditId} missing from the catalog`).toContain(
        `\`${auditId}\``,
      );
    }
  });

  it("documents the good and poor thresholds of every metric rule", () => {
    for (const rule of PERFORMANCE_METRIC_RULES) {
      const row = doc
        .split("\n")
        .find((line) => line.includes(`\`${rule.ruleId}\``));
      expect(row, rule.ruleId).toBeDefined();
      expect(row, rule.ruleId).toContain(String(rule.good));
      expect(row, rule.ruleId).toContain(String(rule.poor));
    }
  });

  it("documents every unavailable reason and keeps the SQL CHECK list identical to the code", () => {
    for (const reason of PSI_UNAVAILABLE_REASONS) {
      expect(doc, reason).toContain(`\`${reason}\``);
    }
    const checkBlock = /unavailable_reason IN \(([^)]*)\)/.exec(migration);
    expect(checkBlock).not.toBeNull();
    const sqlReasons = [...checkBlock![1]!.matchAll(/'([a-z_]+)'/g)].map(
      (match) => match[1]!,
    );
    expect([...sqlReasons].sort()).toEqual([...PSI_UNAVAILABLE_REASONS].sort());
  });

  it("documents the exact CrUX-unavailable message", () => {
    expect(doc).toContain(CRUX_UNAVAILABLE_MESSAGE);
  });
});

describe("rateMetric boundaries", () => {
  const lcp = { good: 2500, poor: 4000 };
  it("treats the good threshold as inclusive and the poor threshold as exclusive", () => {
    expect(rateMetric(lcp, 2500)).toBe("good");
    expect(rateMetric(lcp, 2500.0001)).toBe("needs_improvement");
    expect(rateMetric(lcp, 4000)).toBe("needs_improvement");
    expect(rateMetric(lcp, 4001)).toBe("poor");
    expect(rateMetric(lcp, 0)).toBe("good");
  });
});

describe("evaluatePerformanceRules on recorded responses", () => {
  function input(
    fixture: string,
    strategy: "mobile" | "desktop",
    pageId = "page_home",
    pageUrl = "https://www.cnn.com/",
  ): PerformanceRuleInput {
    return {
      pageId,
      pageUrl,
      strategy,
      evidenceArtifactId: `${pageId}_ev_psi_raw_${strategy}`,
      data: parsedFixture(fixture, strategy),
    };
  }

  function severities(inputs: PerformanceRuleInput[]): Record<string, string> {
    return Object.fromEntries(
      evaluatePerformanceRules(inputs).map((c) => [c.ruleId, c.severity]),
    );
  }

  it("CNN mobile: fires exactly the breached rules with the expected severities", () => {
    expect(severities([input(CNN_MOBILE, "mobile")])).toEqual({
      "perf.lab.lcp": "high", // 21.4 s > 4.0 s
      "perf.lab.tbt": "high", // 795.5 ms > 600 ms
      "perf.lab.fcp": "high", // 8.6 s > 3.0 s
      "perf.lab.speed-index": "high", // 14.7 s > 5.8 s
      "perf.audit.render-blocking": "medium", // 650 ms savings
      "perf.audit.image-delivery": "low", // 96.7 KiB, below the 100 KiB band
      "perf.audit.unused-javascript": "high", // 4,490 ms savings
      "perf.audit.unused-css-rules": "medium", // 311.7 KiB
      "perf.audit.dom-size": "medium", // 2,640 elements > 1,400
    });
  });

  it("CNN desktop: an LCP of 2500.79 ms sits just past the good line and rates medium", () => {
    const result = severities([input(CNN_DESKTOP, "desktop")]);
    expect(result).toEqual({
      "perf.lab.lcp": "medium",
      "perf.lab.tbt": "high", // 3.0 s
      "perf.lab.speed-index": "medium", // 4.3 s in (3.4, 5.8]
      "perf.audit.render-blocking": "medium", // 400 ms
      "perf.audit.image-delivery": "high", // 845.9 KiB
      "perf.audit.unused-javascript": "high", // 2.6 MiB
      "perf.audit.unused-css-rules": "medium",
      "perf.audit.dom-size": "medium", // 4,537 elements
    });
  });

  it("web.dev mobile: real-user field data (CrUX) rules fire independently of lab rules", () => {
    expect(severities([input(WEBDEV_MOBILE, "mobile")])).toEqual({
      "perf.lab.lcp": "medium",
      "perf.lab.cls": "medium",
      "perf.lab.tbt": "high",
      "perf.lab.fcp": "medium",
      "perf.lab.speed-index": "medium",
      "perf.field.lcp": "medium", // p75 3,047 ms
      "perf.field.inp": "medium", // p75 235 ms
      "perf.audit.render-blocking": "high", // 1,500 ms
      "perf.audit.image-delivery": "low",
      "perf.audit.unused-javascript": "high", // 1.04 MiB, Lighthouse estimates 0 ms
      "perf.audit.unused-css-rules": "medium",
    });
  });

  it("info.cern.ch: only the real-user INP on mobile fires; desktop is fully healthy", () => {
    expect(severities([input(CERN_MOBILE, "mobile")])).toEqual({
      "perf.field.inp": "medium", // p75 279 ms
    });
    expect(evaluatePerformanceRules([input(CERN_DESKTOP, "desktop")])).toEqual(
      [],
    );
  });

  it("records the measured value, threshold and evidence on every finding", () => {
    const candidates = evaluatePerformanceRules([
      input(CNN_MOBILE, "mobile"),
      input(CNN_DESKTOP, "desktop"),
    ]);
    const lcp = candidates.find((c) => c.ruleId === "perf.lab.lcp")!;
    expect(lcp.severity).toBe("high"); // worst occurrence wins
    expect(lcp.measured).toMatchObject({
      metric: "lab_lcp",
      value: 21367.50368044048,
      unit: "ms",
    });
    expect(lcp.threshold).toEqual({
      operator: "lte",
      target: 2500,
      unit: "ms",
    });
    expect(lcp.occurrences.map((o) => o.strategy).sort()).toEqual([
      "desktop",
      "mobile",
    ]);

    for (const candidate of candidates) {
      expect(candidate.occurrences.length).toBeGreaterThan(0);
      for (const occurrence of candidate.occurrences) {
        expect(occurrence.evidenceArtifactId).toMatch(
          /_ev_psi_raw_(mobile|desktop)$/,
        );
        expect(occurrence.excerpt.length).toBeLessThanOrEqual(500);
      }
      expect(candidate.priorityScore).toBeGreaterThanOrEqual(0);
      expect(candidate.priorityScore).toBeLessThanOrEqual(100);
    }
  });

  it("cites specific asset URLs, and labels inline code instead of quoting it as a URL", () => {
    const candidates = evaluatePerformanceRules([input(CNN_MOBILE, "mobile")]);
    const renderBlocking = candidates.find(
      (c) => c.ruleId === "perf.audit.render-blocking",
    )!;
    expect(renderBlocking.occurrences[0]!.excerpt).toContain(
      "https://cdn.optimizely.com/public/125375509/s/landingprod.js (2.0 s wasted)",
    );
    expect(renderBlocking.measured).toMatchObject({
      metric: "savings_ms",
      value: 650,
    });

    const css = candidates.find(
      (c) => c.ruleId === "perf.audit.unused-css-rules",
    )!;
    expect(css.occurrences[0]!.excerpt).toContain(
      "inline code on the page (286.5 KiB wasted)",
    );
    expect(css.occurrences[0]!.excerpt).not.toContain("@font-face");
  });

  it("produces nothing from unavailable metrics (no CrUX, errored audits)", () => {
    expect(
      evaluatePerformanceRules([
        input("synthetic-mobile-no-crux-errored-audit.json", "mobile"),
      ]),
    ).toEqual([]);
  });

  it("merges the same rule across pages into one finding with an occurrence per page", () => {
    const lcp = evaluatePerformanceRules([
      input(CNN_MOBILE, "mobile", "page_home"),
      input(
        CNN_MOBILE,
        "mobile",
        "page_pricing",
        "https://www.cnn.com/pricing",
      ),
    ]).find((c) => c.ruleId === "perf.lab.lcp")!;
    expect(lcp.occurrences.map((o) => o.pageId).sort()).toEqual([
      "page_home",
      "page_pricing",
    ]);
  });

  it("has a unique id for every catalog rule and one rule per mapped audit", () => {
    expect(new Set(PERFORMANCE_RULE_IDS).size).toBe(
      PERFORMANCE_RULE_IDS.length,
    );
    expect(PERFORMANCE_RULE_IDS.length).toBe(
      PERFORMANCE_METRIC_RULES.length + PERFORMANCE_AUDIT_RULES.length,
    );
    for (const id of PERFORMANCE_RULE_IDS) {
      expect(id).toMatch(/^perf\.(lab|field|audit)\.[a-z-]+$/);
    }
    expect(PERFORMANCE_AUDIT_RULES.map((r) => r.auditId).sort()).toEqual(
      [...PSI_MAPPED_AUDIT_IDS].sort(),
    );
  });
});
