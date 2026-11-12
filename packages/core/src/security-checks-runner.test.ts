import { describe, expect, it, vi } from "vitest";
import { persistPageCaptureEvidenceToR2AndD1 } from "./evidence-storage";
import type { DocumentSecurityEvidence } from "./security-checks";
import {
  runSecurityChecks,
  type HttpsRedirectProbeFn,
} from "./security-checks-runner";
import {
  buildCaptureResult,
  createInMemoryR2,
  createSqliteD1,
  seedScanWithPages,
} from "./test-support";

/*
 * Evidence is written with the production writer, so these tests also pin the
 * storage contract between capture and the security checks.
 */

const NOW = Date.UTC(2026, 10, 12);
const SCAN = "scan_sec";

const GOOD_HEADERS = {
  "content-type": "text/html",
  "strict-transport-security": "max-age=31536000",
  "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=()",
};

const SECURE_EVIDENCE: DocumentSecurityEvidence = {
  tls: {
    protocol: "TLS 1.3",
    issuer: "R11",
    subjectName: "acme.test",
    validFrom: NOW / 1000 - 30 * 86_400,
    validTo: NOW / 1000 + 90 * 86_400,
  },
  tlsUnavailableReason: null,
  setCookies: [],
  cookiesUnavailableReason: null,
  insecureRequests: [],
};

interface TestPage {
  id: string;
  url: string;
  template?: string;
  headers?: Record<string, string>;
  security?: DocumentSecurityEvidence;
  consoleTexts?: string[];
  storeEvidence?: boolean;
}

async function setup(pages: TestPage[]) {
  const d1 = createSqliteD1();
  const r2 = createInMemoryR2();
  await seedScanWithPages(d1, {
    scanId: SCAN,
    origin: "https://acme.test",
    pages: pages.map((p) => ({
      id: p.id,
      url: p.url,
      templateType: p.template ?? "other",
    })),
  });
  for (const p of pages) {
    if (p.storeEvidence === false) continue;
    await persistPageCaptureEvidenceToR2AndD1({
      d1,
      r2,
      scanId: SCAN,
      pageId: p.id,
      capture: buildCaptureResult({
        url: p.url,
        html: "<!doctype html><title>x</title>",
        headers: p.headers ?? GOOD_HEADERS,
        security: p.security,
        consoleTexts: p.consoleTexts,
      }),
      nowMs: 1,
    });
  }
  return { d1, r2 };
}

const redirectsOnce: HttpsRedirectProbeFn = async (url) => ({
  finalUrl: url.replace("http://", "https://"),
  redirectChain: [
    {
      fromUrl: url,
      toUrl: url.replace("http://", "https://"),
      statusCode: 301,
    },
  ],
  statusCode: 200,
});

async function findings(d1: ReturnType<typeof createSqliteD1>) {
  return d1.sqlite
    .prepare(
      `SELECT f.check_id, f.category, f.severity, o.page_id, o.evidence_artifact_id, e.kind, e.page_id AS evidence_page
       FROM findings f
       JOIN finding_occurrences o ON o.finding_id = f.id
       JOIN evidence_artifacts e ON e.id = o.evidence_artifact_id
       WHERE f.scan_id = ? ORDER BY f.check_id, o.page_id`,
    )
    .all(SCAN) as Array<{
    check_id: string;
    category: string;
    severity: string;
    page_id: string;
    evidence_artifact_id: string;
    kind: string;
    evidence_page: string | null;
  }>;
}

describe("runSecurityChecks", () => {
  it("checks every captured page from stored evidence and cites the right artifact", async () => {
    const { d1, r2 } = await setup([
      {
        id: "p_home",
        url: "https://acme.test/",
        template: "home",
        headers: {
          ...GOOD_HEADERS,
          "x-content-type-options": "",
          server: "nginx/1.18.0",
        },
        security: {
          ...SECURE_EVIDENCE,
          setCookies: [
            {
              name: "session_id",
              secure: false,
              httpOnly: false,
              sameSite: "Lax",
              domain: null,
              path: "/",
            },
          ],
        },
        consoleTexts: [
          "Mixed Content: The page at 'https://acme.test/' was loaded over HTTPS, but requested an insecure script 'http://cdn.acme.test/app.js'. This request has been blocked; the content must be served over HTTPS.",
        ],
      },
      {
        id: "p_pricing",
        url: "https://acme.test/pricing",
        security: SECURE_EVIDENCE,
      },
    ]);
    const probe = vi.fn(redirectsOnce);

    const summary = await runSecurityChecks({
      d1,
      r2,
      scanId: SCAN,
      nowMs: NOW,
      probe,
    });

    expect(probe).toHaveBeenCalledWith("http://acme.test/");
    expect(summary).toMatchObject({
      pagesConsidered: 2,
      pagesChecked: 2,
      pagesSkipped: [],
      pagesWithoutSecurityEvidence: 0,
      probe: {
        status: "redirects_to_https",
        probedUrl: "http://acme.test/",
        finalUrl: "https://acme.test/",
        hops: 1,
        reason: null,
      },
    });
    const rows = await findings(d1);
    expect(rows.map((r) => [r.check_id, r.page_id, r.kind])).toEqual([
      ["sec.cookie.httponly-missing", "p_home", "headers"],
      ["sec.cookie.secure-missing", "p_home", "headers"],
      ["sec.header.nosniff.missing", "p_home", "headers"],
      ["sec.header.version-disclosure", "p_home", "headers"],
      ["sec.mixed-content.active", "p_home", "console_log"],
    ]);
    expect(rows.every((r) => r.category === "security")).toBe(true);

    // The probe is stored as scan-level evidence, even when it passes.
    const probeRow = d1.sqlite
      .prepare(
        `SELECT page_id, r2_key FROM evidence_artifacts WHERE scan_id = ? AND kind = 'headers' AND page_id IS NULL`,
      )
      .get(SCAN) as { page_id: null; r2_key: string };
    expect(probeRow.r2_key).toBe(
      `scans/${SCAN}/reports/headers_http_probe.json`,
    );
    const stored = JSON.parse(
      new TextDecoder().decode(r2.objects.get(probeRow.r2_key)!.bytes),
    );
    expect(stored).toMatchObject({
      check: "http_to_https_redirect",
      status: "redirects_to_https",
      hops: 1,
    });
  });

  it("reports an http:// address that does not redirect, citing the probe artifact", async () => {
    const { d1, r2 } = await setup([
      {
        id: "p_home",
        url: "https://acme.test/",
        template: "home",
        security: SECURE_EVIDENCE,
      },
    ]);
    await runSecurityChecks({
      d1,
      r2,
      scanId: SCAN,
      nowMs: NOW,
      probe: async (url) => ({
        finalUrl: url,
        redirectChain: [],
        statusCode: 200,
      }),
    });
    const rows = await findings(d1);
    expect(
      rows.map((r) => [r.check_id, r.page_id, r.kind, r.evidence_page]),
    ).toEqual([["sec.https.no-redirect", "p_home", "headers", null]]);
  });

  it("makes no redirect finding when the probe cannot complete, and keeps the reason", async () => {
    const { d1, r2 } = await setup([
      {
        id: "p_home",
        url: "https://acme.test/",
        template: "home",
        security: SECURE_EVIDENCE,
      },
    ]);
    const summary = await runSecurityChecks({
      d1,
      r2,
      scanId: SCAN,
      nowMs: NOW,
      probe: async () => {
        throw new Error(
          "Target website 'acme.test' is unreachable (connection refused).",
        );
      },
    });
    expect(summary.probe).toMatchObject({
      status: "unavailable",
      reason: "Target website 'acme.test' is unreachable (connection refused).",
    });
    expect(await findings(d1)).toEqual([]);
    const key = `scans/${SCAN}/reports/headers_http_probe.json`;
    expect(
      JSON.parse(new TextDecoder().decode(r2.objects.get(key)!.bytes)),
    ).toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining("connection refused"),
    });
  });

  it("does not probe when disabled or when the homepage is plain HTTP", async () => {
    const disabled = await setup([
      {
        id: "p_home",
        url: "https://acme.test/",
        template: "home",
        security: SECURE_EVIDENCE,
      },
    ]);
    const s1 = await runSecurityChecks({
      ...disabled,
      scanId: SCAN,
      nowMs: NOW,
      probe: null,
    });
    expect(s1.probe.status).toBe("not_run");
    expect(
      disabled.r2.objects.has(`scans/${SCAN}/reports/headers_http_probe.json`),
    ).toBe(false);

    const http = await setup([
      {
        id: "p_home",
        url: "http://acme.test/",
        template: "home",
        headers: { "content-type": "text/html" },
      },
    ]);
    const probe = vi.fn(redirectsOnce);
    const s2 = await runSecurityChecks({
      ...http,
      scanId: SCAN,
      nowMs: NOW,
      probe,
    });
    expect(probe).not.toHaveBeenCalled();
    expect(s2.probe.reason).toContain("not served over HTTPS");
    expect((await findings(http.d1)).map((r) => r.check_id)).toEqual([
      "sec.https.not-used",
    ]);
  });

  it("skips pages without stored headers and counts captures that predate security evidence", async () => {
    const { d1, r2 } = await setup([
      { id: "p_home", url: "https://acme.test/", template: "home" }, // no security evidence (older capture)
      { id: "p_lost", url: "https://acme.test/lost", storeEvidence: false },
    ]);
    const summary = await runSecurityChecks({
      d1,
      r2,
      scanId: SCAN,
      nowMs: NOW,
      probe: null,
    });
    expect(summary.pagesChecked).toBe(1);
    expect(summary.pagesSkipped).toEqual([
      {
        pageId: "p_lost",
        pageUrl: "https://acme.test/lost",
        reason: "No response headers were stored for this page.",
      },
    ]);
    expect(summary.pagesWithoutSecurityEvidence).toBe(1);
    expect(await findings(d1)).toEqual([]);
  });

  it("is idempotent when the checking stage runs again", async () => {
    const { d1, r2 } = await setup([
      {
        id: "p_home",
        url: "https://acme.test/",
        template: "home",
        headers: { "content-type": "text/html" },
        security: SECURE_EVIDENCE,
      },
    ]);
    const first = await runSecurityChecks({
      d1,
      r2,
      scanId: SCAN,
      nowMs: NOW,
      probe: redirectsOnce,
    });
    const second = await runSecurityChecks({
      d1,
      r2,
      scanId: SCAN,
      nowMs: NOW,
      probe: redirectsOnce,
    });
    expect(second.findingsWritten).toBe(first.findingsWritten);
    const count = (sql: string) =>
      (d1.sqlite.prepare(sql).get(SCAN) as { n: number }).n;
    expect(count(`SELECT COUNT(*) AS n FROM findings WHERE scan_id = ?`)).toBe(
      first.findingsWritten,
    );
    expect(
      count(
        `SELECT COUNT(*) AS n FROM evidence_artifacts WHERE scan_id = ? AND page_id IS NULL`,
      ),
    ).toBe(1);
  });

  it("probes the homepage's host even when another page was captured first, and reads headers case-insensitively", async () => {
    const { d1, r2 } = await setup([
      {
        id: "p_blog",
        url: "https://blog.acme.test/",
        // Mixed-case names as some stores keep them.
        headers: {
          "Content-Type": "text/html",
          "Strict-Transport-Security": "max-age=31536000",
          "Content-Security-Policy":
            "default-src 'self'; frame-ancestors 'none'",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
          "Permissions-Policy": "camera=()",
        },
        security: SECURE_EVIDENCE,
      },
      {
        id: "p_home",
        url: "https://acme.test/",
        template: "home",
        security: SECURE_EVIDENCE,
      },
    ]);
    const probe = vi.fn(redirectsOnce);
    await runSecurityChecks({ d1, r2, scanId: SCAN, nowMs: NOW, probe });
    expect(probe).toHaveBeenCalledWith("http://acme.test/");
    expect(await findings(d1)).toEqual([]);
  });
});
