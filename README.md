# Mortem

**Mortem** is an AI-powered website diagnosis and conversion intelligence SaaS. Submit a website URL and Mortem crawls its highest-intent commercial pages (`home`, `pricing`, `product`, `contact`, `signup`), renders them at both desktop (`1440×900`) and mobile (`390×844`) viewports in an isolated headless browser, runs deterministic checks across seven clinical categories, calculates versioned `0–100` scores, and produces an evidence-backed autopsy report with stack-aware remediation steps.

---

## Core Product Loop

1. **URL Intake & SSRF Guard:** Normalize the target URL, verify DNS and resolved IPs via DNS-over-HTTPS (`1.1.1.1`) against private/reserved IP ranges on every hop, check workspace entitlements, and enqueue a scan job onto `SCAN_QUEUE`.
2. **Site Discovery:** Respect `robots.txt` (`MortemBot` and `*`), parse XML sitemaps, and extract internal links from the rendered homepage to select up to `scan.max_pages` high-value templates.
3. **Dual-Viewport Browser Capture:** Render each page at desktop (`1440×900`) and mobile (`390×844`) viewports using Cloudflare Browser Run (`@cloudflare/playwright`) inside a fresh, isolated `BrowserContext`.
4. **Immutable Evidence Storage:** Persist rendered HTML, full-page and above-the-fold screenshots, response headers, console errors, network request/response logs, and redirect chains in private Cloudflare R2 (`EVIDENCE`) and metadata with SHA-256 checksums in Cloudflare D1 (`DB`).
5. **Seven Clinical Examinations:**
   - **Performance (`20%`):** Google PageSpeed Insights v5 API (Lighthouse lab metrics + CrUX real-user field Core Web Vitals: `LCP`, `INP`, `CLS`, `FCP`, `TTFB`) paired with Browser Run navigation timings.
   - **Conversion (`20%`):** Deterministic DOM & computed-style inspection of CTAs, forms, contact paths, and trust signals, a 5-criterion above-the-fold clarity rubric, and annotated screenshot blockers.
   - **SEO (`15%`):** Server-side Cheerio rules covering `<title>`, meta descriptions, heading hierarchy (`H1–H6`), canonical tags, `noindex` directives, Open Graph/Twitter cards, JSON-LD schema, and sitemap health.
   - **Accessibility (`15%`):** Bundled `axe-core` injected into Browser Run pages and mapped to WCAG 2.2 Level A & AA criteria and affected user groups.
   - **Mobile Usability (`10%`):** `390×844` touch viewport inspection for horizontal overflow, tap target size/spacing (`< 44×44px`), body font legibility (`< 16px`), and intrusive mobile overlays.
   - **Security (`10%`):** Passive inspection of HTTPS redirects, TLS metadata, `Strict-Transport-Security`, `Content-Security-Policy`, `X-Frame-Options` / `frame-ancestors`, `Referrer-Policy`, `Permissions-Policy`, mixed content, and cookie flags.
   - **Technical Health (`10%`):** Internal and external broken links (`4xx`/`5xx`), multi-hop redirect chains, missing subresources, and uncaught runtime errors.
6. **Deterministic Scoring & Anti-Hallucination AI Guardrails:** Normalize all findings through a single Zod schema, compute deterministic category and overall scores (`0–100`), rank fixes by ROI (`(severity × impact × breadth) / effort`), and generate stack-aware fix steps validated by a deterministic guardrail verifier that rejects unmeasured URLs, fabricated metrics, or invalid finding references.
7. **Reports, Exports, Agency Workbench & Monitoring:** Interactive report viewer, HMAC-signed R2 evidence streaming, revocable/password-protected share links (`/s/[token]`), Browser Run A4 PDF exports, agency white-label branding and remediation proposals, scheduled Cron re-scans, and email/Slack/webhook regression alerts.

---

## Architecture & Tech Stack

- **Web Application (`apps/web` / `mortem-web`):** Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS 4, deployed to Cloudflare Workers via OpenNext (`@opennextjs/cloudflare`).
- **Scan Engine (`workers/scan` / `mortem-scan`):** Dedicated Cloudflare Worker consuming `SCAN_QUEUE` (`queue()` handler with dead-letter queue `SCAN_DLQ`) and running recurring re-scans via Cloudflare Cron Triggers (`scheduled()` handler).
- **Shared Core (`packages/core`):** Shared TypeScript package housing Drizzle ORM D1 schemas, Zod contracts, SSRF/URL validators, normalized finding schemas, deterministic scoring functions, and AI guardrail verifiers.
- **Database (`DB`):** Cloudflare D1 (SQLite at the edge), managed with Drizzle ORM and versioned Wrangler SQL migrations (`--local` verification first, then `--remote`).
- **Object Storage (`EVIDENCE`):** Private Cloudflare R2 bucket for immutable scan artifacts, generated PDFs, and workspace branding assets.
- **Authentication:** Better Auth backed by Cloudflare D1 with automatic workspace and `owner` membership provisioning.
- **Rendered Capture (`BROWSER`):** Cloudflare Browser Run (`@cloudflare/playwright`).
- **Payments & Entitlements:** Stripe running in the Next.js Worker (`Stripe.createFetchHttpClient()` + WebCrypto `constructEventAsync`) for single-report unlocks (`$5–$20`) and monthly plans (`$29–$99/mo`).

---

## Local Development

Install dependencies:

```powershell
npm install
```

Start the Next.js development server:

```powershell
npm run dev
```

Run TypeScript type-checking and ESLint:

```powershell
npx tsc --noEmit
npm run lint
```
