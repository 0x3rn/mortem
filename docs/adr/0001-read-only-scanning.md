# ADR-0001: Read-Only Passive and Browser Diagnostic Policy

- **Status:** Accepted
- **Date:** 2026-10-13
- **Issue:** `THE-170`

## Context

Mortem diagnoses third-party websites submitted by founders, marketers, developers, and agencies without requiring any snippet, SDK, or credential installation on the target domain.

Because any public URL can be submitted to Mortem, an unconstrained crawler or headless browser could accidentally trigger side effects on a third-party site (submitting contact/lead forms, mutating state via `POST`/`PUT`/`DELETE` endpoints, following destructive links, or overwhelming an origin server) or be weaponized for SSRF/abuse against internal infrastructure.

## Decision

Mortem enforces a strict **Read-Only Scanning Policy** across both HTTP discovery/fetchers and headless browser captures (`READ_ONLY_SCAN_POLICY` in `@mortem/core`):

1. **Allowed HTTP methods:** Discovery and link/security probes only issue `GET` and `HEAD` requests (`isAllowedScanMethod`). Any mutating HTTP method (`POST`, `PUT`, `PATCH`, `DELETE`) is blocked by policy.
2. **Zero form submission or authentication:** Browser capture sessions inspect `<form>`, `<input>`, and `<button>` DOM geometry and attributes passively; Mortem never fills inputs, clicks submit buttons, logs in, or executes checkout flows.
3. **Polite crawler identity & `robots.txt` compliance:** Every request identifies itself with the `MortemBot/1.0 (+https://mortem.dev/bot; read-only diagnostic crawler)` User-Agent, honors `robots.txt` directives, and enforces per-host concurrency and rate limits.
4. **SSRF & network boundary protection:** Target URLs and every redirect hop are validated to allow only public `http:` and `https:` origins, rejecting private IPv4/IPv6 ranges, loopback addresses, link-local metadata endpoints (`169.254.169.254`), and embedded credentials.

## Consequences

- **Positive:** Third-party site owners never receive fake form leads, mutated state, or invasive security probes from Mortem scans.
- **Positive:** Conversion and form-friction checks remain 100% deterministic because they measure rendered DOM structure, label pairings, and bounding boxes rather than attempting synthetic form submissions.
- **Trade-off:** Flows behind authenticated login walls or multi-step post-submit screens are outside the scope of unauthenticated read-only scans.
