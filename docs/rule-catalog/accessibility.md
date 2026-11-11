# Accessibility rule catalog (`THE-182`)

Mapping version: `1.0.0` (stored as `findings.check_version`). Engine: axe-core `4.14.0` (pinned in `workers/scan/package.json`), injected into every captured page on both the desktop (`1440×900`) and mobile (`390×844`) viewports.

## What this is — and is not

Reports must show this note (exported as `ACCESSIBILITY_COVERAGE_NOTE`) next to accessibility findings:

> This is an automated accessibility review using axe-core. Automated checks find roughly 30–50% of WCAG issues: they cannot judge keyboard navigation and focus order, how a screen reader announces content, whether alternative text is meaningful, or how understandable the page is. Passing these checks does not mean the site conforms to WCAG or meets legal requirements — manual keyboard and screen-reader testing is still required.

Rules axe could not decide automatically ("needs review") are counted in the `checking` stage metadata (`needsReviewRuleCount`) and never turned into findings.

## How axe runs

- axe runs with tags `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa` and `best-practice`, after the screenshots are taken, so it cannot affect them.
- The source is injected with `page.evaluate(source)`, not a `<script>` tag, so pages with a strict Content-Security-Policy are still audited (tested with `script-src 'none'`). axe only reads the DOM.
- A bot-challenge screen is not audited. A slow page has 20 s per viewport; a timeout or error is stored as the result, with the reason, and never fails the capture.
- The full axe result (violations, with `passes`/`incomplete` summarised) and each flagged element's bounding box are stored in R2 as `axe_raw` per viewport (`scans/{scanId}/pages/{pageId}/axe_raw_{viewport}.json`).
- Up to 5 elements per page and viewport, most severe first, are cropped from the page as `screenshot_element` artifacts (skipping empty, off-page and page-sized boxes).

## How findings are produced

- **One finding per axe rule** across the scan, with `check_id = a11y.<axe rule id>` (for example `a11y.color-contrast`). Each affected element on each page and viewport is an occurrence, up to 10 per rule per page per viewport; the full count is in `measured_value_json.value`, and `elementsNotListed` says how many were not listed.
- Each occurrence stores the element's **CSS selector**, its **HTML snippet** with axe's reason (for example "insufficient color contrast of 2.16 … Expected contrast ratio of 4.5:1"), its **bounding box** (`bbox_json`, document CSS pixels plus viewport), and cites the element crop when one exists, otherwise the `axe_raw` artifact.
- `measured_value_json.rawContext` records the WCAG criteria, who is affected, affected URLs and viewports, the axe version, the help URL and the coverage note.

### Severity

| axe impact | Finding severity | Provisional priority |
| ---------- | ---------------- | -------------------- |
| `critical` | critical         | 90                   |
| `serious`  | high             | 70                   |
| `moderate` | medium           | 45                   |
| `minor`    | low              | 20                   |

The finding's severity is the worst across its elements. Final ranking belongs to `THE-191`.

### WCAG mapping

axe tags such as `wcag143` and `wcag1410` are mapped to WCAG 2.2 success criteria with their name and level, from a table of all 87 criteria (`WCAG_SUCCESS_CRITERIA`; `4.1.1 Parsing` is marked obsolete). An unknown criterion is reported by number only, never given an invented name. A rule with no WCAG tag (for example `region`, `landmark-one-main`) is marked `bestPracticeOnly: true` and is not presented as a WCAG failure.

### Who is affected

From axe's category tags:

| axe category                      | Affected people                                                             |
| --------------------------------- | --------------------------------------------------------------------------- |
| `cat.color`                       | People with low vision or colour-vision deficiency                          |
| `cat.keyboard`                    | Keyboard-only users, including many people with motor disabilities          |
| `cat.aria`, `cat.name-role-value` | Screen reader and voice-control users                                       |
| `cat.text-alternatives`           | Blind and low-vision people using screen readers                            |
| `cat.forms`                       | Screen reader users and people with cognitive disabilities completing forms |
| `cat.language`                    | Screen reader users (pronunciation) and people using translation tools      |
| `cat.structure`, `cat.semantics`  | Screen reader users navigating by headings, landmarks and lists             |
| `cat.sensory-and-visual-cues`     | People with low vision                                                      |
| `cat.tables`                      | Screen reader users reading data tables                                     |
| `cat.time-and-media`              | Deaf, hard-of-hearing and blind people using audio or video                 |
| `cat.parsing`                     | Assistive technology users                                                  |
| (none of the above)               | Assistive technology users                                                  |

### Fix role and effort

Colour rules go to a designer, text-alternative rules to content, everything else to a developer. Contrast and landmark structure rules are `medium` effort (they usually touch shared styles or layouts); others are `low`.

## When a page has no results

The `checking` stage metadata lists every page and viewport without results and why: `timeout`, `error`, `skipped` (no axe source), `not_captured` (captured before THE-182), `missing` (recorded in D1 but gone from R2) or `invalid`.
