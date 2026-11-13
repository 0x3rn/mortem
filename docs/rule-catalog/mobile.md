# Mobile usability rule catalog (`THE-184`)

Rule version: `1.0.0` (stored as `findings.check_version`). Every rule id below is emitted by `@mortem/core` (`MOBILE_RULES`); a test fails if a rule is added to the code without being documented here.

## Where the measurements come from

The mobile capture loads each page as a phone would: 390×844 viewport, scale 3, touch. After the screenshots, it runs one script in the page (`MOBILE_AUDIT_SCRIPT`). The script scrolls to the top and measures:

- the `<meta name="viewport">` tag;
- the page's width against the screen;
- every tap target;
- the font size of every visible text node;
- every `position: fixed` or `sticky` element on the first screen.

The script only reads the page. It never clicks, types or submits. The measurements are stored as a `mobile_raw` artifact. Up to 5 offending elements are cropped from a full-page screenshot and stored as `screenshot_element` with `source: "mobile"`, the check, the selector and the box. Bot-challenge screens are not audited.

## How findings are produced

- **One finding per rule per scan.** Element rules have one occurrence per offending element, capped at 10 per rule per page. Each occurrence stores the CSS selector and the element's box in document coordinates.
- **Evidence:** each element occurrence cites the element's crop, the mobile screenshot if no crop was taken, or the `mobile_raw` audit if there is no screenshot. Page rules (viewport, text summary) cite `mobile_raw`.
- **Severity and priority:** severity is the worst across occurrences. Provisional `priority_score`: high `70`, medium `45`, low `20`; final ranking belongs to `THE-191`.
- **Skipped pages:** pages with no stored audit, or where it failed, are listed with a reason. They are never treated as passing.
- **Missing viewport tag:** without one, the phone lays the page out about 980 px wide and shrinks it. Only `mobile.viewport.missing` (and any intrusive overlay) is reported then, because sizes measured on that layout would only repeat the same problem.

## Rules

| Rule id                            | Fires when                                                                                                                                                                                                                                                                | Severity | Fix role  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------- |
| `mobile.viewport.missing`          | No `<meta name="viewport">`.                                                                                                                                                                                                                                              | high     | developer |
| `mobile.viewport.not-device-width` | The viewport tag has no `width=device-width`.                                                                                                                                                                                                                             | medium   | developer |
| `mobile.viewport.zoom-disabled`    | `user-scalable=no` (or `0`), or `maximum-scale` below 2. WCAG 1.4.4 requires zooming to 200 %.                                                                                                                                                                            | medium   | developer |
| `mobile.overflow.horizontal`       | The page is more than 1 px wider than the screen, so it scrolls sideways. Each outermost element that sticks out is listed. Elements inside a container that clips or scrolls are ignored, and so are `position: fixed` elements, because neither widens the page.        | high     | developer |
| `mobile.tap-target.too-small`      | A link, button, form control or `role=button`/`link`/`checkbox`/`tab`/`menuitem` is smaller than 24×24 px and fails WCAG 2.5.8's spacing exception (a 24 px circle on it reaches another target). Exempt: links inside a sentence, and checkboxes or radios with a label. | medium   | designer  |
| `mobile.tap-target.crowded`        | A target smaller than 44×44 px sits less than 8 px from another target (common mobile guidance). Targets already reported as too small are not repeated.                                                                                                                  | low      | designer  |
| `mobile.text.too-small`            | More than 40 % of the visible text is under 12 px. This is Lighthouse's legibility threshold, which needs at least 60 % of text at 12 px or more. The share is weighted by characters, and the elements with the most small text are listed.                              | medium   | designer  |
| `mobile.overlay.intrusive`         | A `fixed` or `sticky` element at least half the screen wide covers more than 30 % of the screen height on the first screen, for example a cookie wall or a pop-up. An element holding most of the page's text counts as the page's own layout, not an overlay.            | medium   | designer  |
