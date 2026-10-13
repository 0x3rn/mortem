import type { Metadata } from "next";
import { ExamineForm } from "./examine-form";

export const metadata: Metadata = {
  title: "Mortem — A full autopsy of your website",
  description:
    "Mortem examines your website the way a pathologist examines a body: performance, SEO, accessibility, security, and conversion — scored, evidenced, and explained in plain language.",
  openGraph: {
    title: "Mortem — A full autopsy of your website",
    description:
      "Enter a URL. Get a scored report on everything that's killing your website — and exactly how to fix it.",
    type: "website",
  },
  twitter: { card: "summary_large_image" },
};

const EXAMINATIONS = [
  {
    title: "Performance",
    body: "Load speed, Core Web Vitals, render-blocking assets. We measure what your visitors actually feel, not what a lab score says.",
  },
  {
    title: "SEO",
    body: "Metadata, headings, indexability, structured data. The reasons Google can't find you — or won't rank you.",
  },
  {
    title: "Accessibility",
    body: "Contrast, keyboard navigation, screen-reader support. The visitors you're turning away without knowing it.",
  },
  {
    title: "Security",
    body: "Headers, HTTPS, exposed surfaces. The quiet risks sitting in your site's configuration right now.",
  },
  {
    title: "Mobile",
    body: "Rendering, tap targets, viewport behavior. How your site holds up on the device most of your traffic uses.",
  },
  {
    title: "Conversion",
    body: "Calls to action, forms, trust signals, friction. Why visitors arrive and leave without doing anything.",
  },
];

const STEPS = [
  {
    number: "01",
    title: "Enter your URL",
    body: "No signup, no install. Paste your website address and Mortem begins the examination.",
  },
  {
    number: "02",
    title: "We open it up",
    body: "A real browser loads your site and runs dozens of checks — speed, search, accessibility, security, mobile, conversion.",
  },
  {
    number: "03",
    title: "You get the report",
    body: "A scored, shareable report in plain language: what's wrong, how much it matters, and the exact steps to fix it.",
  },
];

export default function Home() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <span className="font-display text-xl font-bold tracking-tight">Mortem</span>
        <a
          href="#examine"
          className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-destructive"
        >
          Examine your site
        </a>
      </header>

      {/* Hero */}
      <section className="mx-auto max-w-6xl px-6 pt-20 pb-24 text-center">
        <p className="text-sm font-semibold tracking-widest text-primary uppercase">
          Website autopsy
        </p>
        <h1 className="mx-auto mt-4 max-w-3xl text-4xl font-extrabold tracking-tight sm:text-6xl">
          Your website is underperforming. We&apos;ll show you exactly where.
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg text-muted-foreground">
          Mortem performs a full autopsy on your website — performance, SEO,
          accessibility, security, mobile, and conversion — then hands you a
          scored report with plain-language fixes. No jargon. No guesswork.
        </p>
        <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
          <a
            href="#examine"
            className="rounded-md bg-primary px-6 py-3 text-base font-semibold text-primary-foreground transition-colors hover:bg-destructive"
          >
            Examine your site
          </a>
          <a
            href="#how"
            className="rounded-md border border-border px-6 py-3 text-base font-semibold text-foreground transition-colors hover:bg-accent"
          >
            How it works
          </a>
        </div>
      </section>

      {/* What we examine */}
      <section className="border-t border-border bg-muted/40">
        <div className="mx-auto max-w-6xl px-6 py-24">
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
            Six examinations. One cause of death.
          </h2>
          <p className="mt-4 max-w-2xl text-muted-foreground">
            Every autopsy covers the six systems that decide whether a website
            lives or dies. Each finding is verified by a real test — never
            guessed, never invented.
          </p>
          <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {EXAMINATIONS.map((item) => (
              <div
                key={item.title}
                className="rounded-lg border border-border bg-card p-6"
              >
                <h3 className="text-lg font-semibold">{item.title}</h3>
                <p className="mt-2 text-sm text-muted-foreground">{item.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section id="how" className="border-t border-border">
        <div className="mx-auto max-w-6xl px-6 py-24">
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
            How it works
          </h2>
          <div className="mt-12 grid gap-10 md:grid-cols-3">
            {STEPS.map((step) => (
              <div key={step.number}>
                <span className="font-display text-4xl font-bold text-primary">
                  {step.number}
                </span>
                <h3 className="mt-4 text-xl font-semibold">{step.title}</h3>
                <p className="mt-2 text-sm text-muted-foreground">{step.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing teaser */}
      <section className="border-t border-border bg-muted/40">
        <div className="mx-auto max-w-6xl px-6 py-24 text-center">
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
            One report. Or watch it over time.
          </h2>
          <p className="mx-auto mt-4 max-w-2xl text-muted-foreground">
            A single autopsy costs less than a coffee meeting. Agencies and
            teams can monitor every client site on a monthly plan.
          </p>
          <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:mx-auto lg:max-w-3xl">
            <div className="rounded-lg border border-border bg-card p-8 text-left">
              <h3 className="text-lg font-semibold">Single autopsy</h3>
              <p className="mt-1 font-display text-3xl font-bold">$5–$20</p>
              <p className="mt-3 text-sm text-muted-foreground">
                One full examination of one website. Scored report, evidence,
                and fix steps — shareable with your team or developer.
              </p>
            </div>
            <div className="rounded-lg border border-primary bg-card p-8 text-left">
              <h3 className="text-lg font-semibold">Ongoing &amp; agency</h3>
              <p className="mt-1 font-display text-3xl font-bold">$29–$99/mo</p>
              <p className="mt-3 text-sm text-muted-foreground">
                Recurring examinations, trend tracking, and client-ready
                proposals for agencies managing multiple sites.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section id="examine" className="border-t border-border">
        <div className="mx-auto max-w-6xl px-6 py-24 text-center">
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
            Ready to find out what&apos;s wrong?
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-muted-foreground">
            The examination takes a few minutes. The fixes take less than you
            think.
          </p>
          <ExamineForm />
          <p className="mt-3 text-xs text-muted-foreground">
            Scanning is coming soon — the engine is being built.
          </p>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-6 py-8 text-sm text-muted-foreground sm:flex-row">
          <span className="font-display font-semibold text-foreground">Mortem</span>
          <span>Every website has a cause of death. Find yours first.</span>
        </div>
      </footer>
    </div>
  );
}
