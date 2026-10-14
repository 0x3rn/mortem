import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type {
  D1BoundStatementLike,
  D1DatabaseLike,
  D1ExecResultLike,
} from "./cloudflare";
import {
  classifyDiscoveryTemplate,
  decompressGzipBytes,
  discoverSitePages,
  evaluateRobotsTxtPath,
  extractInternalLinksFromHtml,
  parseRobotsTxt,
  parseSitemapXml,
  persistDiscoveredPagesInD1,
  resolvePlanPageCap,
} from "./index";

const MIGRATION_0001_SQL = readFileSync(
  join(__dirname, "../migrations/0001_auth_and_workspaces.sql"),
  "utf8",
);
const MIGRATION_0002_SQL = readFileSync(
  join(__dirname, "../migrations/0002_scans_evidence_findings_reports.sql"),
  "utf8",
);

function createSqliteD1(): D1DatabaseLike {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  sqlite.exec(MIGRATION_0001_SQL);
  sqlite.exec(MIGRATION_0002_SQL);

  function createBound(
    query: string,
    params: unknown[],
  ): D1BoundStatementLike & { raw?: () => Promise<unknown[][]> } {
    const normalized = params.map((v) => {
      if (v === undefined) return null;
      if (typeof v === "boolean") return v ? 1 : 0;
      if (v instanceof Date) return v.getTime();
      return v as SQLInputValue;
    });
    return {
      async run(): Promise<D1ExecResultLike> {
        const stmt = sqlite.prepare(query);
        const isReader = /^\s*(SELECT|PRAGMA|WITH|EXPLAIN)\b/i.test(query);
        if (isReader) {
          const rows = stmt.all(...normalized) as Record<string, unknown>[];
          return { success: true, results: rows };
        }
        stmt.run(...normalized);
        return { success: true, results: [] };
      },
      async first<T = Record<string, unknown>>(
        col?: string,
      ): Promise<T | null> {
        const row = sqlite.prepare(query).get(...normalized) as
          Record<string, unknown> | undefined;
        if (!row) return null;
        if (col) return (row[col] as T) ?? null;
        return row as T;
      },
      async all<T = Record<string, unknown>>(): Promise<D1ExecResultLike<T>> {
        const stmt = sqlite.prepare(query);
        const rows = stmt.all(...normalized) as T[];
        return { success: true, results: rows };
      },
    };
  }

  return {
    prepare(query: string) {
      const def = createBound(query, []);
      return {
        ...def,
        bind(...values: unknown[]) {
          return createBound(query, values);
        },
      };
    },
  };
}

async function compressGzipString(text: string): Promise<Uint8Array> {
  const input = new TextEncoder().encode(text);
  const stream = new Blob([input])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

describe("Site discovery via robots.txt, XML sitemaps, and Cheerio internal links (THE-177)", () => {
  it("parses robots.txt with MortemBot precedence, wildcard/end-anchor patterns, and Sitemap directives", () => {
    const rawRobots = `
      # Global rules
      User-agent: *
      Disallow: /
      Sitemap: https://acme.io/sitemap-index.xml

      # Specific rules for MortemBot
      User-agent: MortemBot
      Disallow: /admin
      Disallow: /internal/*
      Allow: /internal/public-status
      Disallow: /*.pdf$
      Sitemap: /sitemap-pages.xml
    `;

    const parsed = parseRobotsTxt(rawRobots, "https://acme.io");
    expect(parsed.matchedUserAgent).toBe("mortembot");
    expect(parsed.sitemapUrls).toEqual([
      "https://acme.io/sitemap-index.xml",
      "https://acme.io/sitemap-pages.xml",
    ]);

    // MortemBot group overrides wildcard Disallow: /
    expect(evaluateRobotsTxtPath("/pricing", parsed).allowed).toBe(true);
    expect(evaluateRobotsTxtPath("/admin/settings", parsed).allowed).toBe(
      false,
    );
    expect(evaluateRobotsTxtPath("/internal/secret", parsed).allowed).toBe(
      false,
    );
    // Longest matching rule Allow: /internal/public-status overrides Disallow: /internal/*
    expect(
      evaluateRobotsTxtPath("/internal/public-status", parsed).allowed,
    ).toBe(true);
    expect(evaluateRobotsTxtPath("/docs/whitepaper.pdf", parsed).allowed).toBe(
      false,
    );
  });

  it("parses XML sitemaps, sitemap indexes, and gzip-compressed (.xml.gz) sitemaps", async () => {
    const indexXml = `<?xml version="1.0" encoding="UTF-8"?>
      <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <sitemap>
          <loc>https://acme.io/sitemap-core.xml.gz</loc>
        </sitemap>
      </sitemapindex>`;

    const parsedIndex = parseSitemapXml(indexXml);
    expect(parsedIndex.kind).toBe("sitemapindex");
    expect(parsedIndex.childSitemaps).toEqual([
      "https://acme.io/sitemap-core.xml.gz",
    ]);

    const urlsetXml = `<?xml version="1.0" encoding="UTF-8"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>https://acme.io/</loc></url>
        <url><loc><![CDATA[https://acme.io/pricing?utm_source=sitemap]]></loc></url>
        <url><loc>https://acme.io/contact</loc></url>
      </urlset>`;

    const gzippedBytes = await compressGzipString(urlsetXml);
    expect(gzippedBytes[0]).toBe(0x1f);
    expect(gzippedBytes[1]).toBe(0x8b);

    const decompressed = await decompressGzipBytes(gzippedBytes);
    const parsedUrlset = parseSitemapXml(decompressed);
    expect(parsedUrlset.kind).toBe("urlset");
    expect(parsedUrlset.urls).toEqual([
      "https://acme.io/",
      "https://acme.io/pricing?utm_source=sitemap",
      "https://acme.io/contact",
    ]);
  });

  it("discovers key pages from internal links with Cheerio when sitemaps are missing or unreachable", async () => {
    const homepageHtml = `
      <!doctype html>
      <html>
        <head>
          <link rel="canonical" href="https://nositemap.example.com/" />
        </head>
        <body>
          <nav>
            <a href="/pricing/?utm_medium=nav#tiers">Plans &amp; Pricing</a>
            <a href="/features">Platform Features</a>
            <a href="/about-us">Our Story</a>
            <a href="/contact">Talk to Sales</a>
            <a href="/sign-up">Start Free Trial</a>
            <a href="/blog/launch-post">Read our blog</a>
            <a href="/privacy-policy">Privacy Policy</a>
            <a href="https://external.example.org/pricing">External Link</a>
            <a href="/assets/brochure.pdf">Download PDF</a>
            <a href="mailto:sales@nositemap.example.com">Email Us</a>
          </nav>
        </body>
      </html>
    `;

    const extracted = extractInternalLinksFromHtml(
      homepageHtml,
      "https://nositemap.example.com/",
    );
    // Excludes external links, .pdf assets, and mailto: links; normalizes trailing slash and strips utm_medium & #tiers
    expect(extracted.map((l) => l.href)).toEqual([
      "https://nositemap.example.com/",
      "https://nositemap.example.com/pricing",
      "https://nositemap.example.com/features",
      "https://nositemap.example.com/about-us",
      "https://nositemap.example.com/contact",
      "https://nositemap.example.com/sign-up",
      "https://nositemap.example.com/blog/launch-post",
      "https://nositemap.example.com/privacy-policy",
    ]);

    // Simulate a site with 404 robots.txt and 404 sitemap.xml
    const discovery = await discoverSitePages({
      targetUrl: "https://nositemap.example.com/",
      homepageHtml,
      plan: "preview", // 5 page cap
      fetchFn: async () => new Response("Not Found", { status: 404 }),
    });

    expect(discovery.maxPages).toBe(5);
    expect(discovery.sitemaps[0]?.status).toBe("unreachable");
    // Prioritizes home, pricing, contact, product, about over blog/legal when capped at 5 pages
    expect(discovery.selectedPages.map((p) => p.category)).toEqual([
      "home",
      "pricing",
      "contact",
      "product",
      "about",
    ]);
    expect(discovery.selectedPages.map((p) => p.normalizedUrl)).toEqual([
      "https://nositemap.example.com/",
      "https://nositemap.example.com/pricing",
      "https://nositemap.example.com/contact",
      "https://nositemap.example.com/features",
      "https://nositemap.example.com/about-us",
    ]);
  });

  it("skips paths disallowed by robots.txt, records them in metadata, tolerates malformed/redirect-loop sitemaps, and persists to D1", async () => {
    const robotsTxt = `
      User-agent: *
      Disallow: /secret-roadmap
      Disallow: /internal-pricing
      Sitemap: https:// enterprise-saas.io/sitemap-index.xml
      Sitemap: https://enterprise-saas.io/sitemap-index.xml
    `;

    const sitemapIndexXml = `
      <sitemapindex>
        <sitemap><loc>https://enterprise-saas.io/sitemap-valid.xml.gz</loc></sitemap>
        <sitemap><loc>https://enterprise-saas.io/sitemap-malformed.xml</loc></sitemap>
        <sitemap><loc>https://enterprise-saas.io/sitemap-loop-a.xml</loc></sitemap>
      </sitemapindex>
    `;

    const validSitemapXml = `
      <urlset>
        <url><loc>https://enterprise-saas.io/blog/post-1</loc></url>
        <url><loc>https://enterprise-saas.io/blog/post-2</loc></url>
        <url><loc>https://enterprise-saas.io/secret-roadmap</loc></url>
        <url><loc>https://enterprise-saas.io/pricing</loc></url>
        <url><loc>https://enterprise-saas.io/products/cloud</loc></url>
      </urlset>
    `;
    const validSitemapGz = await compressGzipString(validSitemapXml);

    const homepageHtml = `
      <html>
        <body>
          <a href="/contact">Contact Sales</a>
          <a href="/internal-pricing">Internal Pricing</a>
          <a href="/about">About Company</a>
          <a href="/signup">Create Account</a>
        </body>
      </html>
    `;

    const mockFetch: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "https://enterprise-saas.io/robots.txt") {
        return new Response(robotsTxt, { status: 200 });
      }
      if (url === "https://enterprise-saas.io/sitemap-index.xml") {
        return new Response(sitemapIndexXml, { status: 200 });
      }
      if (url === "https://enterprise-saas.io/sitemap-valid.xml.gz") {
        return new Response(validSitemapGz as unknown as BodyInit, {
          status: 200,
          headers: { "content-type": "application/x-gzip" },
        });
      }
      if (url === "https://enterprise-saas.io/sitemap-malformed.xml") {
        return new Response("<html><body>Not XML at all</body></html>", {
          status: 200,
        });
      }
      if (url === "https://enterprise-saas.io/sitemap-loop-a.xml") {
        return new Response(null, {
          status: 302,
          headers: {
            location: "https://enterprise-saas.io/sitemap-loop-b.xml",
          },
        });
      }
      if (url === "https://enterprise-saas.io/sitemap-loop-b.xml") {
        return new Response(null, {
          status: 302,
          headers: {
            location: "https://enterprise-saas.io/sitemap-loop-a.xml",
          },
        });
      }
      if (url === "https://enterprise-saas.io/") {
        return new Response(homepageHtml, { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    };

    const discovery = await discoverSitePages({
      targetUrl: "https://enterprise-saas.io/",
      plan: "single", // 10 page cap
      fetchFn: mockFetch,
    });

    // Verify disallowed paths were skipped and listed in metadata
    expect(discovery.skippedDisallowedUrls.map((s) => s.normalizedUrl)).toEqual(
      [
        "https://enterprise-saas.io/secret-roadmap",
        "https://enterprise-saas.io/internal-pricing",
      ],
    );

    // Verify malformed and redirect-loop child sitemaps were handled gracefully without throwing
    expect(
      discovery.sitemaps.map((s) => ({ url: s.sitemapUrl, status: s.status })),
    ).toEqual([
      {
        url: "https://enterprise-saas.io/sitemap-index.xml",
        status: "ok",
      },
      {
        url: "https://enterprise-saas.io/sitemap-valid.xml.gz",
        status: "ok",
      },
      {
        url: "https://enterprise-saas.io/sitemap-malformed.xml",
        status: "malformed",
      },
      {
        url: "https://enterprise-saas.io/sitemap-loop-a.xml",
        status: "redirect_loop",
      },
    ]);

    // Verify high-value templates are selected before filling remaining blog posts
    expect(discovery.selectedPages.map((p) => p.normalizedUrl)).toEqual([
      "https://enterprise-saas.io/",
      "https://enterprise-saas.io/pricing",
      "https://enterprise-saas.io/contact",
      "https://enterprise-saas.io/products/cloud",
      "https://enterprise-saas.io/about",
      "https://enterprise-saas.io/signup",
      "https://enterprise-saas.io/blog/post-1",
      "https://enterprise-saas.io/blog/post-2",
    ]);

    // Persist discovered pages into D1 and verify SQLite schema constraints
    const d1 = createSqliteD1();
    const now = 1_760_000_000_000;
    await d1
      .prepare(
        `INSERT INTO users (id, name, email, email_verified, created_at, updated_at)
         VALUES ('usr_1', 'Tester', 'tester@mortem.dev', 1, ?, ?)`,
      )
      .bind(now, now)
      .run();
    await d1
      .prepare(
        `INSERT INTO workspaces (id, name, slug, owner_user_id, plan, created_at, updated_at)
         VALUES ('ws_1', 'Test WS', 'test-ws', 'usr_1', 'single', ?, ?)`,
      )
      .bind(now, now)
      .run();
    await d1
      .prepare(
        `INSERT INTO sites (id, workspace_id, origin, display_name, schedule_enabled, created_at, updated_at)
         VALUES ('site_1', 'ws_1', 'https://enterprise-saas.io', 'enterprise-saas.io', 0, ?, ?)`,
      )
      .bind(now, now)
      .run();
    await d1
      .prepare(
        `INSERT INTO scans (id, workspace_id, site_id, target_url, normalized_url, status, created_at, updated_at)
         VALUES ('scan_disc_1', 'ws_1', 'site_1', 'https://enterprise-saas.io/', 'https://enterprise-saas.io/', 'discovering', ?, ?)`,
      )
      .bind(now, now)
      .run();

    const persisted = await persistDiscoveredPagesInD1({
      d1,
      scanId: "scan_disc_1",
      discovery,
      nowMs: now,
    });
    expect(persisted).toHaveLength(8);

    const rows = await d1
      .prepare(
        `SELECT normalized_url, template_type, capture_status FROM pages WHERE scan_id = 'scan_disc_1'`,
      )
      .bind().all!<{
      normalized_url: string;
      template_type: string;
      capture_status: string;
    }>();

    expect(rows.results).toHaveLength(8);
    expect(rows.results?.every((r) => r.capture_status === "pending")).toBe(
      true,
    );
  });

  it("classifies candidate URLs and enforces plan page caps", () => {
    expect(classifyDiscoveryTemplate("https://acme.io/")).toBe("home");
    expect(classifyDiscoveryTemplate("https://acme.io/pricing")).toBe(
      "pricing",
    );
    expect(classifyDiscoveryTemplate("https://acme.io/contact-us")).toBe(
      "contact",
    );
    expect(classifyDiscoveryTemplate("https://acme.io/solutions/cloud")).toBe(
      "product",
    );
    expect(classifyDiscoveryTemplate("https://acme.io/about")).toBe("about");
    expect(classifyDiscoveryTemplate("https://acme.io/checkout")).toBe("auth");
    expect(classifyDiscoveryTemplate("https://acme.io/blog/2026")).toBe("blog");
    expect(classifyDiscoveryTemplate("https://acme.io/docs/api")).toBe("docs");
    expect(classifyDiscoveryTemplate("https://acme.io/terms-of-service")).toBe(
      "legal",
    );

    expect(resolvePlanPageCap("preview")).toBe(5);
    expect(resolvePlanPageCap("single")).toBe(10);
    expect(resolvePlanPageCap("starter")).toBe(25);
    expect(resolvePlanPageCap("growth")).toBe(50);
    expect(resolvePlanPageCap("agency")).toBe(100);
    expect(resolvePlanPageCap("single", 7)).toBe(7);
  });
});
