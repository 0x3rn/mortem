# SEO rule catalog (`THE-181`)

Rule version: `1.0.0` (stored as `findings.check_version`). Rules run over each captured page's **rendered** HTML snapshot (what Browser Run saw after JavaScript) and its main-document response headers, both read back from R2 evidence.

Every rule id below is emitted by `@mortem/core` (`SEO_RULE_IDS`); a test fails if a rule is added to the code without being documented here.

## How findings are produced

- One finding per rule per scan, with one `finding_occurrences` row per affected page. Each occurrence cites the stored `html` artifact, or the `headers` artifact when the problem comes from a response header (`X-Robots-Tag`).
- `measured_value_json` holds the number of affected pages and every affected URL; duplicate rules also store each group's exact text and URLs.
- Severity is the worst across occurrences. Provisional `priority_score`: high `70`, medium `45`, low `20` (final ranking belongs to `THE-191`).
- Pages whose HTML snapshot is missing are skipped with a stated reason in the `checking` stage metadata, never treated as passing or failing.
- If a snapshot was truncated at the per-page byte budget, `seo.h1.missing` is not claimed (the H1 may have been cut off). Other rules still run.

## Per-page rules

| Rule id                                       | Fires when                                                                                                                                                                                                              | Severity     | Fix role  |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | --------- |
| `seo.title.missing`                           | No `<title>`, or it is empty.                                                                                                                                                                                           | high         | content   |
| `seo.title.length`                            | Title is shorter than 20 or longer than 60 characters (character count; pixel width is not estimated).                                                                                                                  | low          | content   |
| `seo.title.boilerplate`                       | Title is a generic placeholder such as "Home", "Untitled", "Document", "React App", "Vite + React" (case-insensitive exact match).                                                                                      | medium       | content   |
| `seo.meta-description.missing`                | No `<meta name="description">`, or it is empty.                                                                                                                                                                         | medium       | content   |
| `seo.meta-description.length`                 | Description is shorter than 70 or longer than 160 characters.                                                                                                                                                           | low          | content   |
| `seo.h1.missing`                              | No `<h1>` with text (an `<h1>` containing only an image with alt text counts).                                                                                                                                          | medium       | content   |
| `seo.h1.multiple`                             | More than one `<h1>`.                                                                                                                                                                                                   | low          | developer |
| `seo.headings.skipped-level`                  | A heading jumps more than one level down (for example `h2` → `h4`).                                                                                                                                                     | low          | developer |
| `seo.canonical.missing`                       | No `<link rel="canonical">`.                                                                                                                                                                                            | medium       | developer |
| `seo.canonical.invalid`                       | A canonical is not an absolute `http(s)` URL, or several canonical tags disagree. Identical duplicates are accepted.                                                                                                    | medium       | developer |
| `seo.canonical.cross-page`                    | The canonical points to a different URL than the page itself (fragments and a trailing slash are ignored).                                                                                                              | medium       | developer |
| `seo.indexability.noindex`                    | `noindex` (or `none`) in `<meta name="robots">`, `<meta name="googlebot">` or the `X-Robots-Tag` header. Header directives for other named crawlers are ignored.                                                        | high         | developer |
| `seo.indexability.nofollow`                   | `nofollow` (or `none`) from the same sources.                                                                                                                                                                           | medium       | developer |
| `seo.indexability.sitemap-conflict`           | The page is `noindex` but site discovery found it in the XML sitemap.                                                                                                                                                   | high         | developer |
| `seo.lang.missing`                            | `<html>` has no `lang`.                                                                                                                                                                                                 | low          | developer |
| `seo.lang.invalid`                            | `<html lang>` is not a language tag (for example `lang="english language"`).                                                                                                                                            | low          | developer |
| `seo.hreflang.invalid`                        | An `hreflang` value is not `x-default` or a language code with optional script and region (for example `en`, `pt-BR`, `es-419`), or its `href` is not absolute.                                                         | medium       | developer |
| `seo.open-graph.missing`                      | Any of `og:title`, `og:description`, `og:image`, `og:url` is missing. Medium when `og:title` or `og:image` is missing (shared links render as bare URLs), low otherwise.                                                | medium / low | marketer  |
| `seo.open-graph.invalid-image`                | `og:image` is not an absolute `http(s)` URL.                                                                                                                                                                            | low          | developer |
| `seo.twitter-card.missing`                    | No `twitter:card` meta tag.                                                                                                                                                                                             | low          | marketer  |
| `seo.structured-data.invalid-json`            | A `<script type="application/ld+json">` block is not valid JSON.                                                                                                                                                        | medium       | developer |
| `seo.structured-data.missing-context-or-type` | A JSON-LD block has no schema.org `@context`, or an item (top level or in `@graph`) has no `@type`. Pages without JSON-LD are not flagged.                                                                              | medium       | developer |
| `seo.images.missing-alt`                      | A meaningful `<img>` has no `alt` attribute. Not flagged: `alt=""` (deliberately decorative), `role="presentation"`/`"none"`, `aria-hidden="true"`, and 1×1 tracking pixels. Medium at 5 or more images, low otherwise. | low / medium | content   |

## Cross-page rules

These compare the pages captured in one scan, so they can only see what the scan captured.

| Rule id                          | Fires when                                                                                                                                   | Severity | Fix role  |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------- |
| `seo.title.duplicate`            | Two or more pages share a title (compared case-insensitively; each page's exact text is quoted).                                             | medium   | content   |
| `seo.meta-description.duplicate` | Two or more pages share a meta description.                                                                                                  | low      | content   |
| `seo.canonical.loop`             | Canonicals among scanned pages form a cycle (A → B → A). Every page in the cycle gets an occurrence.                                         | high     | developer |
| `seo.hreflang.missing-return`    | Page A lists page B as an `hreflang` alternate, B was scanned, and B does not list A back. Alternates that were not scanned are not claimed. | medium   | developer |

## Sitemap membership

`seo.indexability.sitemap-conflict` relies on `pages.discovery_sources_json` (migration `0005`), which records how site discovery found each page (`entry`, `sitemap`, `internal_link`, `canonical`). Pages discovered before that migration have `[]` and are never claimed to be in the sitemap.
