import type { Metadata } from "next";
import { ExamineForm } from "./examine-form";

export const metadata: Metadata = {
  title: "Mortem — Forensic Website Diagnosis & Conversion Autopsy",
  description:
    "Mortem crawls your highest-intent pages in a real desktop and mobile browser, runs deterministic checks across seven clinical categories, and delivers an evidence-backed autopsy report with stack-aware fixes.",
  openGraph: {
    title: "Mortem — Forensic Website Diagnosis & Conversion Autopsy",
    description:
      "Enter a URL. Get a scored, evidence-backed autopsy of everything hurting your website's traffic, trust, and conversions — plus exact steps to fix it.",
    type: "website",
  },
  twitter: { card: "summary_large_image" },
};

const EXAMINATIONS = [
  {
    code: "EXAM-01",
    title: "Performance & Core Web Vitals",
    weight: "20% of score",
    signals: "CrUX field data · Lighthouse lab · Navigation timings",
    body: "Measures both real-visitor Chrome UX field metrics (LCP, INP, CLS, TTFB) and real-browser asset weights to pinpoint the exact scripts, fonts, and hero images slowing down your highest-intent pages.",
  },
  {
    code: "EXAM-02",
    title: "Conversion & Fold Clarity",
    weight: "20% of score",
    signals: "5-criterion clarity rubric · CTA geometry · Form friction",
    body: "Checks whether a first-time visitor can tell what you offer, who it is for, and what to do next within seconds — flagging buried mobile CTAs, weak contrast, high-friction forms, and missing trust signals with annotated screenshots.",
  },
  {
    code: "EXAM-03",
    title: "SEO & Search Discoverability",
    weight: "15% of score",
    signals: "Titles & meta · Canonical & indexing · JSON-LD schema",
    body: "Audits page titles, meta descriptions, heading hierarchy (H1–H6), canonical mismatches, accidental noindex rules, Open Graph cards, structured data, and XML sitemap integrity across every crawled template.",
  },
  {
    code: "EXAM-04",
    title: "Accessibility (WCAG 2.2 AA)",
    weight: "15% of score",
    signals: "Injected axe-core · Contrast ratios · Keyboard & ARIA",
    body: "Executes axe-core directly inside the rendered DOM and maps every barrier to WCAG 2.2 Level A & AA criteria, identifying which user groups are affected and which selectors need remediation.",
  },
  {
    code: "EXAM-05",
    title: "Mobile Viewport Usability",
    weight: "10% of score",
    signals: "390×844 touch capture · Tap targets · Horizontal overflow",
    body: "Loads every page in an isolated mobile touch viewport to catch horizontal scroll bleed, cramped tap targets (< 44×44px), undersized body copy (< 16px), and popups covering the hero.",
  },
  {
    code: "EXAM-06",
    title: "Security Posture",
    weight: "10% of score",
    signals: "HTTPS & TLS · HSTS / CSP / Frame headers · Cookie flags",
    body: "Passively inspects HTTP-to-HTTPS redirect hops, TLS certificate health, Content-Security-Policy, HSTS, X-Frame-Options, mixed-content requests, and insecure session cookies without invasive probing.",
  },
  {
    code: "EXAM-07",
    title: "Technical & Link Health",
    weight: "10% of score",
    signals: "4xx/5xx dead links · Redirect chains · Console errors",
    body: "Detects broken internal and outbound links, multi-hop redirect chains, failed image/script/stylesheet loads, and uncaught JavaScript runtime exceptions that quietly break user journeys.",
  },
];

const SPECIMEN_CATEGORIES = [
  { name: "Performance", weight: "20%", score: 54, status: "Impaired" },
  { name: "Conversion", weight: "20%", score: 48, status: "Critical" },
  { name: "SEO", weight: "15%", score: 76, status: "Fair" },
  { name: "Accessibility", weight: "15%", score: 68, status: "Guarded" },
  { name: "Mobile", weight: "10%", score: 52, status: "Impaired" },
  { name: "Security", weight: "10%", score: 71, status: "Guarded" },
  { name: "Technical", weight: "10%", score: 82, status: "Stable" },
];

const SPECIMEN_FINDINGS = [
  {
    id: "CONV-001",
    severity: "Critical",
    effort: "Quick Win",
    role: "Designer / Dev",
    page: "/pricing (Mobile 390×844)",
    title: "Primary CTA pushed 74px below the mobile viewport fold",
    evidence:
      'Selector a[data-cta="start-trial"] ("Start 14-day trial") renders at y = 918px on a 390×844 mobile viewport due to an uncollapsed announcement banner (88px) and excessive hero vertical padding.',
    impact:
      "Mobile visitors landing on /pricing see headline copy and a decorative graphic with zero visible call to action before scrolling.",
    fix: "In Next.js (src/components/pricing-hero.tsx), reduce mobile top padding from pt-24 to pt-10 and collapse the promo banner to a single line so the primary CTA sits above y = 680px.",
  },
  {
    id: "PERF-004",
    severity: "High",
    effort: "Quick Win",
    role: "Developer",
    page: "/ (Mobile & Desktop)",
    title: "Mobile Largest Contentful Paint reaches 4.6s (target <= 2.5s)",
    evidence:
      'Google CrUX 75th-percentile field LCP is 4,620ms. Browser capture recorded a 1.42 MB unoptimized PNG (hero-dashboard.png) loaded without fetchpriority="high" plus two render-blocking stylesheet requests.',
    impact:
      "Pages exceeding 4.0s mobile LCP experience steep bounce spikes before visitors ever read the value proposition.",
    fix: "Convert hero-dashboard.png to AVIF/WebP (< 180 KB) and pass the priority prop on the Next.js <Image> component above the fold.",
  },
];

const DIFFERENTIATORS = [
  {
    eyebrow: "Multi-page commercial crawl",
    title: "We don't stop at your homepage",
    body: "Most free scanners only test a single URL. Mortem reads your robots.txt, XML sitemaps, and internal links to prioritize the templates where revenue actually happens: homepage, pricing, product/service, contact, and signup.",
  },
  {
    eyebrow: "Deterministic math + AI guardrails",
    title: "Zero hallucinated metrics or invented URLs",
    body: "Every score and priority rank is computed by deterministic, versioned TypeScript rules over captured DOM, network, and CrUX evidence. AI is used strictly to write stack-aware fix instructions — and a verifier blocks any output that contradicts measured data.",
  },
  {
    eyebrow: "Built for handoff",
    title: "Ready to send to your developer or client",
    body: "Findings are ranked by ROI (Severity × Business Impact × Page Breadth ÷ Effort) and tagged by owner role (Developer, Designer, Marketer, Content). Share a password-protected link or export a print-ready A4 PDF in one click.",
  },
];

const STEPS = [
  {
    number: "01",
    title: "Submit your URL",
    body: "Paste any domain or page URL. Mortem normalizes the target, checks robots.txt and sitemaps, and selects your highest-value commercial pages.",
  },
  {
    number: "02",
    title: "Dual-viewport browser capture",
    body: "An isolated headless browser renders each page at desktop (1440×900) and mobile (390×844), recording DOM geometry, screenshots, headers, and network timings.",
  },
  {
    number: "03",
    title: "Seven clinical examinations",
    body: "Deterministic check engines audit performance, conversion clarity, SEO, WCAG 2.2 AA accessibility, mobile usability, security headers, and broken links.",
  },
  {
    number: "04",
    title: "Scored report & stack-aware fixes",
    body: "Receive a 0–100 health score, prioritized Fix First actions with visual proof, and step-by-step instructions tailored to Next.js, Shopify, WordPress, Webflow, or custom stacks.",
  },
];

const AGENCY_FEATURES = [
  {
    title: "White-label reports & PDFs",
    body: "Replace Mortem's header with your agency logo, brand palette, contact details, and custom executive note across web views, public share links, and A4 PDF exports.",
  },
  {
    title: "Client-ready remediation proposals",
    body: "Turn a completed autopsy into a scoped statement of work in seconds. Map ranked findings directly to your agency's service packages, effort tiers, and pricing.",
  },
  {
    title: "Client folders, roles & share links",
    body: "Organize sites and scan history by client folder, invite teammates with Owner/Admin/Member/Viewer permissions, and send expiring /s/[token] links without client logins.",
  },
];

const PLANS = [
  {
    name: "Free Preview",
    price: "$0",
    cadence: "no card required",
    highlight: false,
    description:
      "Run an immediate diagnostic preview to see your overall health score and top blockers.",
    features: [
      "Up to 5 key pages crawled per scan",
      "Overall 0–100 score & all 7 category scores",
      "Top 3 priority findings unlocked with evidence",
      "Desktop (1440×900) & mobile (390×844) capture",
    ],
  },
  {
    name: "Single Autopsy",
    price: "$15",
    cadence: "one-time report unlock",
    highlight: false,
    description:
      "Unlock one complete website autopsy with every finding, screenshot, and fix instruction.",
    features: [
      "Full report unlocked (up to 15 pages crawled)",
      "All findings, DOM proof & annotated screenshots",
      "Stack-specific fix steps by role & effort",
      "Revocable public share link & A4 PDF export",
    ],
  },
  {
    name: "Starter & Growth",
    price: "$29–$59",
    cadence: "per month",
    highlight: true,
    description:
      "For founders and in-house teams fixing issues and preventing regressions after deploys.",
    features: [
      "15 to 50 full scans/month (up to 25 pages/scan)",
      "Scheduled weekly or monthly re-scans",
      "Score history & New / Resolved finding diffs",
      "Email, Slack & webhook regression alerts",
    ],
  },
  {
    name: "Agency",
    price: "$99",
    cadence: "per month",
    highlight: false,
    description:
      "For agencies and consultants auditing prospects, pitching fixes, and managing client retainers.",
    features: [
      "200 full scans/month (up to 50 pages/scan)",
      "White-label web reports, share links & PDFs",
      "Client-ready improvement proposal generator",
      "Client folders, team seats & REST API access",
    ],
  },
];

export default function Home() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <header className="border-b border-border/60">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
          <div className="flex items-center gap-3">
            <span className="font-display text-xl font-bold tracking-tight">
              Mortem
            </span>
            <span className="hidden rounded border border-border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground sm:inline-block">
              Forensic Web Diagnostics
            </span>
          </div>
          <nav
            aria-label="Primary"
            className="hidden items-center gap-6 text-sm text-muted-foreground md:flex"
          >
            <a
              href="#specimen"
              className="transition-colors hover:text-foreground"
            >
              Sample Report
            </a>
            <a
              href="#examinations"
              className="transition-colors hover:text-foreground"
            >
              7 Examinations
            </a>
            <a href="#how" className="transition-colors hover:text-foreground">
              How It Works
            </a>
            <a
              href="#agencies"
              className="transition-colors hover:text-foreground"
            >
              For Agencies
            </a>
            <a
              href="#pricing"
              className="transition-colors hover:text-foreground"
            >
              Pricing
            </a>
          </nav>
          <a
            href="#examine"
            className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-destructive"
          >
            Run an autopsy
          </a>
        </div>
      </header>

      {/* Hero with immediate URL intake */}
      <section className="mx-auto max-w-6xl px-6 pt-16 pb-20 text-center sm:pt-24 sm:pb-24">
        <p className="text-xs font-semibold tracking-widest text-primary uppercase sm:text-sm">
          Multi-Page Website Autopsy · Desktop &amp; Mobile Browser Capture
        </p>
        <h1 className="mx-auto mt-4 max-w-4xl text-4xl font-extrabold tracking-tight sm:text-6xl">
          Find out what is quietly killing your website&apos;s traffic and
          conversions.
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-base text-muted-foreground sm:text-lg">
          Mortem crawls your highest-intent pages in a real desktop and mobile
          browser, runs deterministic checks across seven clinical categories,
          and hands you an evidence-backed autopsy report with stack-aware
          fixes. No vague advice. No hallucinated metrics.
        </p>

        <div className="mt-10">
          <ExamineForm id="hero-examine" buttonLabel="Examine website" />
        </div>

        <div className="mx-auto mt-6 flex max-w-2xl flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs text-muted-foreground">
          <span>✓ Crawls homepage, pricing, product &amp; signup pages</span>
          <span>✓ Real Desktop (1440×900) &amp; Mobile (390×844) capture</span>
          <span>✓ Every finding backed by DOM &amp; screenshot proof</span>
        </div>
      </section>

      {/* Sample Autopsy Report Specimen */}
      <section
        id="specimen"
        className="border-t border-border bg-muted/30"
        aria-labelledby="specimen-heading"
      >
        <div className="mx-auto max-w-6xl px-6 py-20 sm:py-24">
          <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
            <div>
              <p className="text-xs font-semibold tracking-widest text-primary uppercase">
                Clinical Specimen · Sample Output
              </p>
              <h2
                id="specimen-heading"
                className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl"
              >
                See what an autopsy report actually contains.
              </h2>
            </div>
            <p className="max-w-md text-sm text-muted-foreground">
              Every finding pairs a deterministic measurement with visual or DOM
              evidence, business impact, and exact remediation steps for your
              detected stack.
            </p>
          </div>

          <div className="mt-10 rounded-xl border border-border bg-card p-6 sm:p-8">
            {/* Specimen Header Bar */}
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border pb-6">
              <div>
                <div className="flex flex-wrap items-center gap-2.5">
                  <span className="rounded bg-primary/20 px-2.5 py-0.5 text-xs font-semibold text-foreground">
                    CASE #MRT-0419
                  </span>
                  <span className="text-sm font-semibold text-foreground">
                    https://acme-cloud.io
                  </span>
                  <span className="rounded border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                    Stack detected: Next.js
                  </span>
                </div>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  5 pages examined (/, /pricing, /features, /contact, /signup) ·
                  Desktop 1440×900 &amp; Mobile 390×844 · Scoring v1.0.0
                </p>
              </div>
              <div className="flex items-center gap-4">
                <div className="text-right">
                  <p className="text-xs tracking-wider text-muted-foreground uppercase">
                    Overall Health Score
                  </p>
                  <p className="font-display text-3xl font-extrabold text-foreground">
                    61{" "}
                    <span className="text-base font-normal text-muted-foreground">
                      / 100 · Guarded
                    </span>
                  </p>
                </div>
              </div>
            </div>

            {/* Specimen Body: Left = 7 Category Scores, Right = 2 Sample Findings */}
            <div className="mt-8 grid gap-8 lg:grid-cols-12">
              <div className="lg:col-span-5">
                <h3 className="text-sm font-semibold tracking-wider text-muted-foreground uppercase">
                  7 Weighted Category Scores
                </h3>
                <div className="mt-4 space-y-3.5">
                  {SPECIMEN_CATEGORIES.map((cat) => (
                    <div
                      key={cat.name}
                      className="rounded-lg border border-border bg-background/60 p-3.5"
                    >
                      <div className="flex items-center justify-between text-sm">
                        <span className="font-semibold text-foreground">
                          {cat.name}{" "}
                          <span className="text-xs font-normal text-muted-foreground">
                            ({cat.weight})
                          </span>
                        </span>
                        <span className="font-display font-bold text-foreground">
                          {cat.score}/100{" "}
                          <span className="ml-1 text-xs font-normal text-muted-foreground">
                            · {cat.status}
                          </span>
                        </span>
                      </div>
                      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-primary"
                          style={{ width: `${cat.score}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="lg:col-span-7">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold tracking-wider text-muted-foreground uppercase">
                    Fix First · Ranked by Severity × Impact ÷ Effort
                  </h3>
                  <span className="text-xs text-muted-foreground">
                    Showing 2 of 14 findings
                  </span>
                </div>
                <div className="mt-4 space-y-4">
                  {SPECIMEN_FINDINGS.map((finding) => (
                    <div
                      key={finding.id}
                      className="rounded-lg border border-border bg-background/60 p-5"
                    >
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="font-mono font-semibold text-foreground">
                          {finding.id}
                        </span>
                        <span className="rounded bg-primary px-2 py-0.5 font-semibold text-primary-foreground">
                          {finding.severity}
                        </span>
                        <span className="rounded border border-border bg-card px-2 py-0.5 text-muted-foreground">
                          {finding.effort}
                        </span>
                        <span className="rounded border border-border bg-card px-2 py-0.5 text-muted-foreground">
                          Owner: {finding.role}
                        </span>
                        <span className="ml-auto text-muted-foreground">
                          {finding.page}
                        </span>
                      </div>

                      <h4 className="mt-3 text-base font-semibold text-foreground">
                        {finding.title}
                      </h4>

                      <dl className="mt-3 space-y-2.5 text-xs leading-relaxed">
                        <div className="rounded border border-border/80 bg-muted/60 p-3">
                          <dt className="font-semibold text-foreground">
                            Measured Evidence
                          </dt>
                          <dd className="mt-1 text-muted-foreground">
                            {finding.evidence}
                          </dd>
                        </div>
                        <div>
                          <dt className="inline font-semibold text-foreground">
                            Why it matters:{" "}
                          </dt>
                          <dd className="inline text-muted-foreground">
                            {finding.impact}
                          </dd>
                        </div>
                        <div>
                          <dt className="inline font-semibold text-foreground">
                            Recommended fix:{" "}
                          </dt>
                          <dd className="inline text-muted-foreground">
                            {finding.fix}
                          </dd>
                        </div>
                      </dl>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Seven Examinations */}
      <section id="examinations" className="border-t border-border">
        <div className="mx-auto max-w-6xl px-6 py-24">
          <p className="text-xs font-semibold tracking-widest text-primary uppercase">
            Diagnostic Coverage
          </p>
          <h2 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">
            Seven examinations. Every cause of death accounted for.
          </h2>
          <p className="mt-4 max-w-2xl text-muted-foreground">
            Every autopsy scores the seven systems that decide whether a website
            earns traffic, builds trust, and converts visitors. Each check has a
            versioned rule ID and cites concrete evidence — never guessed, never
            invented.
          </p>
          <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {EXAMINATIONS.map((item) => (
              <div
                key={item.code}
                className="flex flex-col justify-between rounded-lg border border-border bg-card p-6"
              >
                <div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-mono font-semibold text-primary">
                      {item.code}
                    </span>
                    <span className="rounded border border-border bg-muted px-2 py-0.5 text-muted-foreground">
                      {item.weight}
                    </span>
                  </div>
                  <h3 className="mt-3 text-lg font-semibold">{item.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                    {item.body}
                  </p>
                </div>
                <p className="mt-4 border-t border-border/60 pt-3 text-xs text-muted-foreground">
                  {item.signals}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Why Mortem / Differentiation */}
      <section id="why-mortem" className="border-t border-border bg-muted/40">
        <div className="mx-auto max-w-6xl px-6 py-24">
          <p className="text-xs font-semibold tracking-widest text-primary uppercase">
            Why Mortem
          </p>
          <h2 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">
            Why a single-page Lighthouse score isn&apos;t enough.
          </h2>
          <p className="mt-4 max-w-2xl text-muted-foreground">
            A site can score 95 in Lighthouse and still bleed revenue because
            its pricing CTA sits below the mobile fold, its signup form has 11
            required fields, or its canonical tags block indexing.
          </p>
          <div className="mt-12 grid gap-8 md:grid-cols-3">
            {DIFFERENTIATORS.map((item) => (
              <div
                key={item.title}
                className="rounded-lg border border-border bg-card p-6"
              >
                <p className="text-xs font-semibold tracking-wider text-primary uppercase">
                  {item.eyebrow}
                </p>
                <h3 className="mt-2 text-xl font-semibold">{item.title}</h3>
                <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                  {item.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section id="how" className="border-t border-border">
        <div className="mx-auto max-w-6xl px-6 py-24">
          <p className="text-xs font-semibold tracking-widest text-primary uppercase">
            Examination Protocol
          </p>
          <h2 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">
            How an autopsy works
          </h2>
          <div className="mt-12 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((step) => (
              <div
                key={step.number}
                className="rounded-lg border border-border bg-card/50 p-6"
              >
                <span className="font-display text-3xl font-bold text-primary">
                  {step.number}
                </span>
                <h3 className="mt-4 text-lg font-semibold">{step.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {step.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Built for Agencies & Consultants */}
      <section id="agencies" className="border-t border-border bg-muted/40">
        <div className="mx-auto max-w-6xl px-6 py-24">
          <div className="max-w-2xl">
            <p className="text-xs font-semibold tracking-widest text-primary uppercase">
              Agency &amp; Consultant Workbench
            </p>
            <h2 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">
              Turn every website audit into a signed client engagement.
            </h2>
            <p className="mt-4 text-muted-foreground">
              Stop spending four hours screenshotting issues and pasting them
              into slide decks. Mortem packages the proof, applies your brand,
              and generates a scoped remediation proposal tied directly to the
              scan&apos;s findings.
            </p>
          </div>
          <div className="mt-12 grid gap-6 md:grid-cols-3">
            {AGENCY_FEATURES.map((feat) => (
              <div
                key={feat.title}
                className="rounded-lg border border-border bg-card p-6"
              >
                <h3 className="text-lg font-semibold">{feat.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {feat.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="border-t border-border">
        <div className="mx-auto max-w-6xl px-6 py-24">
          <div className="text-center">
            <p className="text-xs font-semibold tracking-widest text-primary uppercase">
              Transparent Pricing
            </p>
            <h2 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">
              Start with a free preview. Unlock one report or monitor every
              site.
            </h2>
            <p className="mx-auto mt-4 max-w-2xl text-muted-foreground">
              Pay once when you only need a single full diagnosis, or subscribe
              for scheduled re-scans, regression alerts, and agency
              white-labeling.
            </p>
          </div>

          <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {PLANS.map((plan) => (
              <div
                key={plan.name}
                className={`flex flex-col justify-between rounded-lg border p-6 text-left ${
                  plan.highlight
                    ? "border-primary bg-card ring-1 ring-primary"
                    : "border-border bg-card"
                }`}
              >
                <div>
                  <div className="flex items-center justify-between">
                    <h3 className="text-lg font-semibold">{plan.name}</h3>
                    {plan.highlight ? (
                      <span className="rounded bg-primary px-2 py-0.5 text-xs font-semibold text-primary-foreground">
                        Most popular
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-3 flex items-baseline gap-1.5">
                    <span className="font-display text-3xl font-bold">
                      {plan.price}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {plan.cadence}
                    </span>
                  </div>
                  <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                    {plan.description}
                  </p>
                  <ul className="mt-5 space-y-2.5 border-t border-border/60 pt-4 text-xs text-foreground">
                    {plan.features.map((feature) => (
                      <li key={feature} className="flex items-start gap-2">
                        <span className="text-primary">✓</span>
                        <span>{feature}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <a
                  href="#examine"
                  className={`mt-6 block rounded-md px-4 py-2.5 text-center text-xs font-semibold transition-colors ${
                    plan.highlight
                      ? "bg-primary text-primary-foreground hover:bg-destructive"
                      : "border border-border bg-background/60 text-foreground hover:bg-accent"
                  }`}
                >
                  Examine a site
                </a>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section id="examine" className="border-t border-border bg-muted/40">
        <div className="mx-auto max-w-6xl px-6 py-24 text-center">
          <p className="text-xs font-semibold tracking-widest text-primary uppercase">
            Begin Examination
          </p>
          <h2 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">
            Ready to see what&apos;s hurting your website?
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-muted-foreground">
            Enter your domain below to run a multi-page desktop and mobile
            autopsy. Every finding comes with verifiable proof and prioritized
            fix instructions.
          </p>
          <div className="mt-8">
            <ExamineForm id="footer-examine" buttonLabel="Run autopsy" />
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-6 py-8 text-sm text-muted-foreground sm:flex-row">
          <div className="flex items-center gap-3">
            <span className="font-display font-semibold text-foreground">
              Mortem
            </span>
            <span>·</span>
            <span>Every website has a cause of death. Find yours first.</span>
          </div>
          <div className="flex items-center gap-5 text-xs">
            <a href="#specimen" className="hover:text-foreground">
              Sample Report
            </a>
            <a href="#examinations" className="hover:text-foreground">
              Examinations
            </a>
            <a href="#agencies" className="hover:text-foreground">
              Agencies
            </a>
            <a href="#pricing" className="hover:text-foreground">
              Pricing
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
