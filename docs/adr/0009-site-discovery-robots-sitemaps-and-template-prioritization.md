# ADR-0009: Site Discovery via `robots.txt`, XML Sitemaps, and Template-Prioritized Internal Links

- **Status:** Accepted
- **Date:** 2026-10-14
- **Issue:** `THE-177`

## Context

A real website autopsy cannot stop at the homepage: conversion leaks, missing pricing tables, broken contact forms, and SEO issues frequently live on secondary templates (`/pricing`, `/contact`, `/product`, `/about`, `/sign-up`, `/blog`, `/legal`). At the same time, Mortem must respect `robots.txt` policies for `MortemBot` and `*`, keep all discovery strictly same-origin with SSRF and byte-size guards, and select a representative set of high-value templates within the workspace's page budget rather than blindly taking the first $N$ links in DOM or sitemap order.

## Decision

### 1. `robots.txt` Policy & Precedence (`parseRobotsTxt`, `evaluateRobotsTxtPath`)

- Fetch `<origin>/robots.txt` via `fetchSameOriginBoundedBytes` (capped at `512 KB` and `5` same-origin redirect hops, validated by `validateAndNormalizeIntakeUrl`).
- Group `Allow:` and `Disallow:` rules by `User-agent:` blocks:
  - If an explicit `User-agent: MortemBot` group is present, its rules take precedence over `User-agent: *` rules.
  - Otherwise, `User-agent: *` rules are applied.
  - Wildcard (`*`) and end-of-path (`$`) patterns are supported, with longest-match rule resolution (and `Allow` winning ties of equal length per RFC 9309).
- All `Sitemap:` directives across the file are extracted and normalized to same-origin URLs.
- Disallowed candidate URLs are skipped and recorded in `skippedDisallowedUrls` inside the `discovering` stage's `scan_events.metadata_json`.

### 2. Bounded XML Sitemap & `.xml.gz` Parsing (`parseSitemapXml`, `decompressGzipBytes`)

- Supports both `<urlset>` sitemaps and `<sitemapindex>` documents (expanding up to `MAX_CHILD_SITEMAPS = 5` child sitemaps).
- Supports gzip-compressed sitemaps (`.xml.gz` or `0x1f 0x8b` magic bytes) using the Web `DecompressionStream("gzip")` API with a `2 MB` decompressed output cap (`MAX_SITEMAP_BYTES`).
- Enforces a total inspected URL cap (`DEFAULT_MAX_INSPECTED_URLS = 500`).
- If `robots.txt` does not list any `Sitemap:` directives, `<origin>/sitemap.xml` is probed automatically.
- Unreachable sitemaps, malformed XML, cross-origin `<loc>` URLs, and redirect loops are recorded as non-fatal diagnostics (`SitemapFetchDiagnostic`) without failing the scan.

### 3. Cheerio Internal Link & Canonical Extraction (`extractInternalLinksFromHtml`)

- Uses Cheerio (`cheerio.load`) on the homepage HTML to extract `<link rel="canonical" href="...">` and `<a href="...">` links (capturing anchor text, `aria-label`, or `title` to enrich template classification).
- Filters strictly to same-origin HTTP(S) HTML page candidates, stripping `#hash` fragments and marketing query parameters (`utm_*`, `gclid`, `fbclid`, etc.), normalizing trailing slashes, and excluding binary/asset extensions (`.pdf`, `.png`, `.jpg`, `.css`, `.js`, `.zip`, etc.).

### 4. Heuristic Template Classification & Diversity-First Selection (`classifyDiscoveryTemplate`, `selectPrioritizedDiscoveryPages`)

- Candidate URLs are classified by pathname and anchor-text heuristics into ordered priority tiers:
  1. `home`
  2. `pricing`
  3. `contact`
  4. `product`
  5. `about`
  6. `auth` (signup / login / checkout)
  7. `blog`
  8. `docs`
  9. `legal`
  10. `other`
- Selection up to `maxPages` (`preview`/`free`: `5`, `single`: `10`, `starter`: `25`, `growth`: `50`, `agency`: `100`) runs in two passes:
  - **Pass 1 (Template Diversity):** Selects the highest-priority representative of each available high-value category (`home`, `pricing`, `contact`, `product`, `about`, `auth`, `blog`, `docs`, `legal`) so a large `/blog/*` or `/products/*` section never crowds out `/pricing` or `/contact`.
  - **Pass 2 (Capacity Fill):** Fills any remaining budget slots in priority-rank and shortest-path-depth order.
- Selected pages are idempotently persisted into the D1 `pages` table (`capture_status = 'pending'`) via `persistDiscoveredPagesInD1` and subsequently captured across desktop and mobile viewports during the `capturing` stage.
