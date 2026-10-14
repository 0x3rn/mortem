import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import type {
  D1BoundStatementLike,
  D1DatabaseLike,
  D1ExecResultLike,
} from "./cloudflare";
import {
  ScanIntakeError,
  isBlockedHostname,
  isBlockedIpAddress,
  normalizeUrlInput,
  preflightAndValidateTargetUrl,
  provisionPersonalWorkspace,
  resolveAndValidateHostDns,
  submitScanIntake,
  validateAndNormalizeIntakeUrl,
  type DohResolverFn,
} from "./index";

const MIGRATION_0001_SQL = readFileSync(
  join(__dirname, "../migrations/0001_auth_and_workspaces.sql"),
  "utf8",
);
const MIGRATION_0002_SQL = readFileSync(
  join(__dirname, "../migrations/0002_scans_evidence_findings_reports.sql"),
  "utf8",
);
const MIGRATION_0003_SQL = readFileSync(
  join(__dirname, "../migrations/0003_intake_rate_limits.sql"),
  "utf8",
);

function createTestD1(): D1DatabaseLike {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  sqlite.exec(MIGRATION_0001_SQL);
  sqlite.exec(MIGRATION_0002_SQL);
  sqlite.exec(MIGRATION_0003_SQL);

  function createBound(query: string, params: unknown[]): D1BoundStatementLike {
    const normalized = params.map((v) => {
      if (v === undefined) return null;
      if (typeof v === "boolean") return v ? 1 : 0;
      if (v instanceof Date) return v.getTime();
      return v as SQLInputValue;
    });
    return {
      async run(): Promise<D1ExecResultLike> {
        sqlite.prepare(query).run(...normalized);
        return { success: true, results: [] };
      },
      async first<T = Record<string, unknown>>(): Promise<T | null> {
        const row = sqlite.prepare(query).get(...normalized) as
          Record<string, unknown> | undefined;
        return (row as T) ?? null;
      },
      async all<T = Record<string, unknown>>(): Promise<D1ExecResultLike<T>> {
        const rows = sqlite.prepare(query).all(...normalized) as T[];
        return { success: true, results: rows };
      },
    };
  }

  return {
    prepare(query: string) {
      return {
        bind(...values: unknown[]) {
          return createBound(query, values);
        },
      };
    },
    async batch(statements: D1BoundStatementLike[]) {
      const out: D1ExecResultLike[] = [];
      for (const s of statements) {
        out.push(await s.run());
      }
      return out;
    },
  };
}

const publicDohResolver: DohResolverFn = async (hostname, type) => ({
  Status: 0,
  Answer:
    type === "A"
      ? [{ name: hostname, type: 1, data: "93.184.216.34" }]
      : [
          {
            name: hostname,
            type: 28,
            data: "2606:2800:220:1:248:1893:25c8:1946",
          },
        ],
});

describe("URL intake normalization, SSRF & DoH guards, and rate limits (THE-173)", () => {
  it("normalizes schemes, lowercases & Punycode-converts hosts, strips fragments & tracking params, and canonicalizes root slash", () => {
    expect(
      normalizeUrlInput(
        "  STRIPE.COM/pricing?utm_source=twitter&utm_medium=cpc&gclid=abc123&fbclid=xyz987&plan=pro#faq ",
      ),
    ).toBe("https://stripe.com/pricing?plan=pro");

    // Internationalized domain name (IDN) -> Punycode ASCII
    expect(normalizeUrlInput("münchen.de/rathaus?utm_campaign=spring")).toBe(
      "https://xn--mnchen-3ya.de/rathaus",
    );

    // Default port stripping
    expect(normalizeUrlInput("https://acme-cloud.io:443")).toBe(
      "https://acme-cloud.io/",
    );
    expect(normalizeUrlInput("http://acme-cloud.io:80/docs")).toBe(
      "http://acme-cloud.io/docs",
    );
  });

  it("blocks localhost, IPv4/IPv6 private/loopback/metadata/CGNAT literals, internal suffixes, and non-80/443 ports", () => {
    const blockedLiteralsAndHosts = [
      "localhost",
      "http://localhost/admin",
      "https://sub.localhost/api",
      "127.0.0.1",
      "http://127.0.0.1:80/",
      "http://127.127.127.127/",
      "http://10.0.0.1/",
      "http://10.255.255.254/internal",
      "http://172.16.0.1/",
      "http://172.31.255.255/",
      "http://192.168.0.1/",
      "http://192.168.1.254/",
      "http://169.254.169.254/latest/meta-data/",
      "http://100.64.0.1/",
      "http://100.127.255.254/",
      "http://[::1]/",
      "http://[fe80::1]/",
      "http://[fc00::1]/",
      "http://[fd12:3456:789a::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[::ffff:169.254.169.254]/",
      "https://printer.local/",
      "https://vault.internal/",
      "https://acme-cloud.io:8080/",
      "https://acme-cloud.io:3000/",
    ];

    for (const candidate of blockedLiteralsAndHosts) {
      expect(normalizeUrlInput(candidate)).toBeNull();
      expect(() => validateAndNormalizeIntakeUrl(candidate)).toThrowError(
        ScanIntakeError,
      );
      try {
        validateAndNormalizeIntakeUrl(candidate);
      } catch (err) {
        expect((err as ScanIntakeError).code).toBe("ssrf_blocked");
      }
    }

    // Verify public IPs pass isBlockedIpAddress while private/reserved IPs fail
    expect(isBlockedIpAddress("93.184.216.34")).toBe(false);
    expect(isBlockedIpAddress("172.15.255.255")).toBe(false);
    expect(isBlockedIpAddress("172.32.0.1")).toBe(false);
    expect(isBlockedIpAddress("2606:2800:220:1:248:1893:25c8:1946")).toBe(
      false,
    );
    expect(isBlockedIpAddress("127.0.0.1")).toBe(true);
    expect(isBlockedIpAddress("10.1.2.3")).toBe(true);
    expect(isBlockedIpAddress("172.16.5.4")).toBe(true);
    expect(isBlockedIpAddress("192.168.1.1")).toBe(true);
    expect(isBlockedIpAddress("169.254.169.254")).toBe(true);
    expect(isBlockedIpAddress("::1")).toBe(true);
    expect(isBlockedHostname("db.internal")).toBe(true);
  });

  it("rejects domains that resolve via DoH to loopback, RFC1918, metadata, or IPv6 internal addresses", async () => {
    const maliciousIps = [
      "127.0.0.1",
      "10.0.0.42",
      "172.16.10.5",
      "192.168.100.1",
      "169.254.169.254",
      "100.64.1.1",
      "::1",
      "fe80::1",
      "fc00::dead:beef",
      "::ffff:127.0.0.1",
    ];

    for (const badIp of maliciousIps) {
      const isV6 = badIp.includes(":");
      await expect(
        resolveAndValidateHostDns(
          "rebind.attacker.example",
          async (_h, type) => ({
            Status: 0,
            Answer:
              (type === "A" && !isV6) || (type === "AAAA" && isV6)
                ? [{ type: isV6 ? 28 : 1, data: badIp }]
                : [],
          }),
        ),
      ).rejects.toMatchObject({
        code: "ssrf_blocked",
      });
    }

    // Also rejects CNAME aliasing to internal hostnames
    await expect(
      resolveAndValidateHostDns("cname-trap.example", async () => ({
        Status: 0,
        Answer: [{ type: 5, data: "metadata.internal." }],
      })),
    ).rejects.toMatchObject({
      code: "ssrf_blocked",
    });

    // Rejects NXDOMAIN / empty answers with dns_failed
    await expect(
      resolveAndValidateHostDns("nxdomain.example", async () => ({
        Status: 3,
        Answer: [],
      })),
    ).rejects.toMatchObject({
      code: "dns_failed",
    });
  });

  it("re-validates every redirect hop (redirect: manual, max 5 hops) and blocks redirects to internal hosts or IPs", async () => {
    // Public domain redirecting on hop 2 to AWS metadata IP 169.254.169.254
    await expect(
      preflightAndValidateTargetUrl("https://public-entry.com/start", {
        dohResolver: publicDohResolver,
        fetchFn: async (input) => {
          const url = String(input);
          if (url === "https://public-entry.com/start") {
            return new Response(null, {
              status: 302,
              headers: { location: "https://hop-two.com/next" },
            });
          }
          return new Response(null, {
            status: 301,
            headers: { location: "http://169.254.169.254/latest/meta-data/" },
          });
        },
      }),
    ).rejects.toMatchObject({
      code: "ssrf_blocked",
    });

    // Public domain redirecting to another domain whose DNS resolves to 10.0.0.1
    await expect(
      preflightAndValidateTargetUrl("https://public-entry.com/", {
        dohResolver: async (host, type) => {
          if (host === "internal-alias.com" && type === "A") {
            return { Status: 0, Answer: [{ type: 1, data: "10.0.0.1" }] };
          }
          return publicDohResolver(host, type);
        },
        fetchFn: async () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://internal-alias.com/secret" },
          }),
      }),
    ).rejects.toMatchObject({
      code: "ssrf_blocked",
    });

    // Exceeding max 5 redirects fails with unreachable
    await expect(
      preflightAndValidateTargetUrl("https://loop.example.com/0", {
        dohResolver: publicDohResolver,
        fetchFn: async (input) => {
          const current = new URL(String(input));
          const step = Number(current.pathname.slice(1) || "0") + 1;
          return new Response(null, {
            status: 302,
            headers: { location: `https://loop.example.com/${step}` },
          });
        },
      }),
    ).rejects.toMatchObject({
      code: "unreachable",
    });
  });

  it("classifies reachability pre-check errors into tls_error, bot_blocked, and unreachable", async () => {
    await expect(
      preflightAndValidateTargetUrl("https://expired-cert.example.com/", {
        dohResolver: publicDohResolver,
        fetchFn: async () => {
          throw new Error("TLS handshake failed: certificate has expired");
        },
      }),
    ).rejects.toMatchObject({
      code: "tls_error",
    });

    await expect(
      preflightAndValidateTargetUrl("https://protected.example.com/", {
        dohResolver: publicDohResolver,
        fetchFn: async () =>
          new Response("Challenge", {
            status: 403,
            headers: {
              "cf-mitigated": "challenge",
              server: "cloudflare",
            },
          }),
      }),
    ).rejects.toMatchObject({
      code: "bot_blocked",
    });

    await expect(
      preflightAndValidateTargetUrl("https://down.example.com/", {
        dohResolver: publicDohResolver,
        fetchFn: async () => new Response("Bad Gateway", { status: 502 }),
      }),
    ).rejects.toMatchObject({
      code: "unreachable",
    });
  });

  it("creates a queued scan in D1, publishes to SCAN_QUEUE, detects duplicate in-flight scans, and enforces rate limits & Turnstile", async () => {
    const d1 = createTestD1();
    const now = Date.now();
    await d1
      .prepare(
        `INSERT INTO users (id, name, email, email_verified, created_at, updated_at)
         VALUES ('usr_intake', 'Ada', 'ada@mortem.dev', 1, ?, ?)`,
      )
      .bind(now, now)
      .run();
    const ws = await provisionPersonalWorkspace(d1, {
      id: "usr_intake",
      name: "Ada",
      email: "ada@mortem.dev",
    });

    const queueMessages: unknown[] = [];
    const scanQueue = {
      send: vi.fn(async (msg: unknown) => {
        queueMessages.push(msg);
      }),
    };

    // 1. Valid URL intake creates a queued scan in D1 and publishes to SCAN_QUEUE
    const created = await submitScanIntake({
      d1,
      scanQueue,
      workspaceId: ws.workspaceId,
      rawUrl: "acme-cloud.io/pricing?utm_source=ads#top",
      clientIp: "203.0.114.9",
      dohResolver: publicDohResolver,
      fetchFn: async () => new Response(null, { status: 200 }),
    });

    expect(created.status).toBe("queued");
    expect(created.normalizedUrl).toBe("https://acme-cloud.io/pricing");
    expect(scanQueue.send).toHaveBeenCalledOnce();
    expect(queueMessages[0]).toMatchObject({
      kind: "website_scan",
      scanId: created.scanId,
      workspaceId: ws.workspaceId,
      siteId: created.siteId,
      targetUrl: "https://acme-cloud.io/pricing",
      stage: "queued",
    });

    // 2. Submitting the same URL while still queued triggers duplicate_in_flight (409)
    await expect(
      submitScanIntake({
        d1,
        scanQueue,
        workspaceId: ws.workspaceId,
        rawUrl: "https://acme-cloud.io/pricing",
        clientIp: "203.0.114.9",
        dohResolver: publicDohResolver,
        fetchFn: async () => new Response(null, { status: 200 }),
      }),
    ).rejects.toMatchObject({
      code: "duplicate_in_flight",
      status: 409,
    });

    // 3. Per-target-host rate limit triggers when maxPerTargetHost is reached
    await expect(
      submitScanIntake({
        d1,
        scanQueue,
        workspaceId: ws.workspaceId,
        rawUrl: "https://acme-cloud.io/about",
        clientIp: "203.0.114.9",
        dohResolver: publicDohResolver,
        fetchFn: async () => new Response(null, { status: 200 }),
        rateLimitConfig: { maxPerTargetHost: 1 },
      }),
    ).rejects.toMatchObject({
      code: "rate_limited",
      status: 429,
    });

    // 4. Anonymous preview requires valid Turnstile token when turnstileSecretKey is configured
    await expect(
      submitScanIntake({
        d1,
        scanQueue,
        workspaceId: ws.workspaceId,
        rawUrl: "https://linear.app/",
        isAnonymousPreview: true,
        turnstileSecretKey: "secret_turnstile_key",
        dohResolver: publicDohResolver,
        fetchFn: async () => new Response(null, { status: 200 }),
      }),
    ).rejects.toMatchObject({
      code: "turnstile_failed",
      status: 403,
    });
  });
});
