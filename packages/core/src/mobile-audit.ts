import type { PlaywrightPageLike } from "./browser-capture";

/**
 * In-browser mobile layout audit (THE-184). Runs inside the 390×844 mobile
 * capture, after the screenshots, and measures what a phone user sees: the
 * viewport meta tag, horizontal overflow, tap targets, small text and
 * fixed/sticky overlays on first load. The checking stage turns these
 * measurements into `mobile.*` findings; this module only measures.
 */

export const MOBILE_AUDIT_FORMAT = "mortem-mobile/1";
export const MOBILE_AUDIT_DEFAULT_TIMEOUT_MS = 10_000;
export const MOBILE_AUDIT_DEFAULT_MAX_CROPS = 5;
/** Measured lists are capped so a huge page cannot produce a huge artifact. */
export const MOBILE_AUDIT_MAX_ITEMS = 20;

/** Thresholds used while measuring (the rules re-check them). */
export const MOBILE_TAP_TARGET_MIN_PX = 24;
export const MOBILE_TAP_TARGET_COMFORT_PX = 44;
export const MOBILE_TAP_TARGET_MIN_GAP_PX = 8;
export const MOBILE_SMALL_TEXT_PX = 12;

/** Document coordinates in CSS pixels. */
export interface MobileElementBox {
  selector: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MobileAuditMeasurements {
  viewport: { width: number; height: number };
  viewportMeta: { count: number; content: string | null };
  documentWidth: number;
  overflowingElements: MobileElementBox[];
  tapTargets: {
    checked: number;
    /** `hitWidth`/`hitHeight`: the area that receives a tap (may exceed the box). */
    tooSmall: Array<
      MobileElementBox & {
        label: string;
        hitWidth?: number;
        hitHeight?: number;
      }
    >;
    crowded: Array<
      MobileElementBox & {
        label: string;
        gapPx: number;
        hitWidth?: number;
        hitHeight?: number;
      }
    >;
  };
  text: {
    totalChars: number;
    smallChars: number;
    smallElements: Array<
      MobileElementBox & { fontSizePx: number; chars: number; sample: string }
    >;
  };
  overlays: Array<
    MobileElementBox & { position: string; coverage: number; sample: string }
  >;
}

export type MobileCheckKind =
  | "overflow"
  | "tap-target-small"
  | "tap-target-crowded"
  | "small-text"
  | "overlay";

export interface MobileElementCrop {
  check: MobileCheckKind;
  selector: string;
  box: MobileElementBox;
  png: Uint8Array;
}

export type MobileAuditResult =
  | {
      status: "ok";
      durationMs: number;
      measurements: MobileAuditMeasurements;
      /** JSON stored verbatim in R2 as `mobile_raw`. */
      artifactJson: string;
      elementCrops: MobileElementCrop[];
      cropFailures: number;
    }
  | {
      status: "error" | "timeout";
      durationMs: number;
      message: string;
      /** Stored as `mobile_raw` so the reason is evidence too. */
      artifactJson: string;
    };

/**
 * Plain browser JavaScript, evaluated in the page. Returns a JSON string so the
 * transfer is one value. Kept free of TypeScript so it runs as written.
 */
export const MOBILE_AUDIT_SCRIPT = `(() => {
  const MAX = ${MOBILE_AUDIT_MAX_ITEMS};
  const MIN = ${MOBILE_TAP_TARGET_MIN_PX};
  const COMFORT = ${MOBILE_TAP_TARGET_COMFORT_PX};
  const GAP = ${MOBILE_TAP_TARGET_MIN_GAP_PX};
  const SMALL_TEXT = ${MOBILE_SMALL_TEXT_PX};
  window.scrollTo(0, 0);
  // The screen is the layout viewport (clientWidth), not innerWidth: on a phone
  // that allows zoom, innerWidth grows to the widest content, which would hide
  // exactly the overflow being measured.
  const vw = document.documentElement.clientWidth || window.innerWidth;
  const vh = document.documentElement.clientHeight || window.innerHeight;
  const sx = window.scrollX || 0;
  const sy = window.scrollY || 0;
  const styleCache = new Map();
  const style = (el) => {
    let cs = styleCache.get(el);
    if (!cs) { cs = getComputedStyle(el); styleCache.set(el, cs); }
    return cs;
  };
  const isVisible = (el, r) => {
    if (r.width < 1 || r.height < 1) return false;
    const cs = style(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0;
  };
  const simpleId = (id) => /^[A-Za-z][\\w-]*$/.test(id);
  const selectorOf = (el) => {
    if (el.id && simpleId(el.id)) return "#" + el.id;
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement && parts.length < 5) {
      if (cur !== el && cur.id && simpleId(cur.id)) { parts.unshift("#" + cur.id); break; }
      let part = cur.tagName.toLowerCase();
      const parent = cur.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
        if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(cur) + 1) + ")";
      }
      parts.unshift(part);
      cur = parent;
    }
    return parts.join(" > ");
  };
  const box = (el, r) => ({
    selector: selectorOf(el),
    x: Math.round(r.left + sx),
    y: Math.round(r.top + sy),
    width: Math.round(r.width),
    height: Math.round(r.height),
  });
  const snippet = (el) => (el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 80);
  const all = Array.from(document.body ? document.body.querySelectorAll("*") : []).slice(0, 6000);

  // Viewport meta tag
  const metas = Array.from(document.querySelectorAll("meta[name]")).filter(
    (m) => (m.getAttribute("name") || "").toLowerCase() === "viewport",
  );
  const viewportMeta = {
    count: metas.length,
    content: metas.length ? metas[metas.length - 1].getAttribute("content") : null,
  };

  // Horizontal overflow: only when the page itself scrolls sideways.
  // The page's own scroll width: overflow-x:hidden on <html> clips it, while on
  // <body> alone it does not stop a phone page from being wider.
  const documentWidth = document.documentElement.scrollWidth;
  const overflowing = [];
  if (documentWidth > vw + 1) {
    const flagged = new Set();
    for (const el of all) {
      const r = el.getBoundingClientRect();
      if (r.right <= vw + 1 || !isVisible(el, r)) continue;
      const cs = style(el);
      if (cs.position === "fixed") continue; // fixed boxes never widen the page
      let clipped = false;
      for (let a = el.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
        const ox = style(a).overflowX;
        if (ox === "hidden" || ox === "clip" || ox === "auto" || ox === "scroll") { clipped = true; break; }
      }
      if (clipped) continue;
      flagged.add(el);
      if (el.parentElement && flagged.has(el.parentElement)) continue; // outermost only
      overflowing.push(box(el, r));
    }
  }

  // Tap targets
  const targetSelector = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="tab"], [role="menuitem"]';
  const targets = [];
  for (const el of Array.from(document.querySelectorAll(targetSelector)).slice(0, 400)) {
    if (el.disabled) continue;
    if (el.parentElement && el.parentElement.closest(targetSelector)) continue; // nested
    const r = el.getBoundingClientRect();
    if (!isVisible(el, r)) continue;
    const tag = el.tagName.toLowerCase();
    // WCAG 2.5.8 inline exception: a link inside a sentence.
    if (tag === "a" && style(el).display === "inline") {
      const parentText = (el.parentElement ? el.parentElement.textContent : "") || "";
      if (parentText.trim().length > (el.textContent || "").trim().length + 5) continue;
    }
    // A checkbox or radio with a label is tapped through its label.
    if (tag === "input" && /^(checkbox|radio)$/i.test(el.type) && el.labels && el.labels.length) continue;
    const label = (el.getAttribute("aria-label") || el.textContent || el.getAttribute("title") || el.getAttribute("name") || tag).replace(/\\s+/g, " ").trim().slice(0, 60);
    targets.push({ el, r, label });
  }
  const gapBetween = (a, b) => {
    const dx = Math.max(0, b.left - a.right, a.left - b.right);
    const dy = Math.max(0, b.top - a.bottom, a.top - b.bottom);
    return Math.sqrt(dx * dx + dy * dy);
  };
  const center = (r) => ({ x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 });
  const distToRect = (p, r) => {
    const dx = Math.max(r.left - p.x, 0, p.x - r.right);
    const dy = Math.max(r.top - p.y, 0, p.y - r.bottom);
    return Math.sqrt(dx * dx + dy * dy);
  };
  // The area that really receives a tap: probe outward from the centre with
  // elementFromPoint, so ::before/::after hit areas, padding tricks and stretched
  // card links count (a box alone said GitHub's 6 px dots were 6 px; their
  // ::before makes them ~28x33). If the centre itself is not tappable (covered),
  // the element's own box is used.
  const owns = (el, x, y) => {
    if (x < 0 || y < 0 || x >= vw || y >= vh) return false;
    const hit = document.elementFromPoint(x, y);
    return Boolean(hit) && (hit === el || el.contains(hit));
  };
  const hitArea = (el) => {
    el.scrollIntoView({ block: "center", inline: "center" });
    const r = el.getBoundingClientRect();
    const cx = (r.left + r.right) / 2;
    const cy = (r.top + r.bottom) / 2;
    if (!owns(el, cx, cy)) return null;
    const reach = (dx, dy) => {
      let d = 0;
      while (d < COMFORT && owns(el, cx + dx * (d + 1), cy + dy * (d + 1))) d++;
      return d;
    };
    return { width: reach(-1, 0) + reach(1, 0) + 1, height: reach(0, -1) + reach(0, 1) + 1 };
  };
  let probed = 0;
  for (const t of targets) {
    t.hitW = t.r.width;
    t.hitH = t.r.height;
    if ((t.r.width < COMFORT || t.r.height < COMFORT) && probed < 150) {
      probed++;
      const hit = hitArea(t.el);
      if (hit) {
        t.hitW = Math.max(t.r.width, hit.width);
        t.hitH = Math.max(t.r.height, hit.height);
      }
    }
  }
  window.scrollTo(0, 0);
  const hitSize = (t) => ({ hitWidth: Math.round(t.hitW), hitHeight: Math.round(t.hitH) });
  const isSmall = (t) => t.hitW < MIN || t.hitH < MIN;
  const tooSmall = [];
  const crowded = [];
  for (const t of targets) {
    if (isSmall(t)) {
      // WCAG 2.5.8 spacing exception: a 24px circle on the target must not
      // reach another target (or another small target's circle).
      const c = center(t.r);
      const spaced = targets.every((o) =>
        o === t || (isSmall(o)
          ? Math.hypot(c.x - center(o.r).x, c.y - center(o.r).y) >= MIN
          : distToRect(c, o.r) >= MIN / 2));
      if (!spaced && tooSmall.length < MAX) tooSmall.push({ ...box(t.el, t.r), ...hitSize(t), label: t.label });
      if (!spaced) continue;
    }
    if (t.hitW < COMFORT || t.hitH < COMFORT) {
      let nearest = Infinity;
      for (const o of targets) if (o !== t) nearest = Math.min(nearest, gapBetween(t.r, o.r));
      if (nearest < GAP && crowded.length < MAX) {
        crowded.push({ ...box(t.el, t.r), ...hitSize(t), label: t.label, gapPx: Math.round(nearest * 10) / 10 });
      }
    }
  }

  // Text size
  let totalChars = 0;
  let smallChars = 0;
  const smallByElement = new Map();
  if (document.body) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = (n.textContent || "").trim();
      const el = n.parentElement;
      if (!text || !el || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(el.tagName)) continue;
      const r = el.getBoundingClientRect();
      if (!isVisible(el, r) || r.width <= 1 || r.height <= 1) continue;
      const chars = text.length;
      totalChars += chars;
      const fontSize = parseFloat(style(el).fontSize) || 16;
      if (fontSize < SMALL_TEXT) {
        smallChars += chars;
        const prev = smallByElement.get(el);
        if (prev) prev.chars += chars;
        else smallByElement.set(el, { el, r, fontSize, chars });
      }
    }
  }
  const smallElements = Array.from(smallByElement.values())
    .sort((a, b) => b.chars - a.chars)
    .slice(0, MAX)
    .map((s) => ({ ...box(s.el, s.r), fontSizePx: Math.round(s.fontSize * 10) / 10, chars: s.chars, sample: snippet(s.el) }));

  // Fixed / sticky overlays covering the first screen.
  const bodyTextLength = ((document.body && document.body.textContent) || "").length || 1;
  const overlayEls = [];
  for (const el of all) {
    const cs = style(el);
    if (cs.position !== "fixed" && cs.position !== "sticky") continue;
    const r = el.getBoundingClientRect();
    if (!isVisible(el, r)) continue;
    const coveredH = Math.min(r.bottom, vh) - Math.max(r.top, 0);
    const coveredW = Math.min(r.right, vw) - Math.max(r.left, 0);
    if (coveredH <= 0 || coveredW < vw * 0.5) continue;
    const coverage = coveredH / vh;
    if (coverage <= 0.3) continue;
    // The page's own layout shell (holding most of the content) is not an overlay.
    if (((el.textContent || "").length / bodyTextLength) > 0.6) continue;
    if (overlayEls.some((o) => o.contains(el))) continue;
    overlayEls.push(el);
  }
  const overlays = overlayEls.slice(0, MAX).map((el) => {
    const r = el.getBoundingClientRect();
    const coveredH = Math.min(r.bottom, vh) - Math.max(r.top, 0);
    return { ...box(el, r), position: style(el).position, coverage: Math.round((coveredH / vh) * 1000) / 1000, sample: snippet(el) };
  });

  return JSON.stringify({
    viewport: { width: vw, height: vh },
    viewportMeta,
    documentWidth,
    overflowingElements: overflowing.slice(0, MAX),
    tapTargets: { checked: targets.length, tooSmall, crowded },
    text: { totalChars, smallChars, smallElements },
    overlays,
  });
})()`;

function toBytes(input: Uint8Array | ArrayBuffer): Uint8Array {
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Elements worth a crop, most important problem first; one crop per selector. */
export function selectMobileCropTargets(
  m: MobileAuditMeasurements,
  max: number,
): Array<{ check: MobileCheckKind; box: MobileElementBox }> {
  const ordered: Array<{ check: MobileCheckKind; box: MobileElementBox }> = [
    ...m.overlays.map((box) => ({ check: "overlay" as const, box })),
    ...m.overflowingElements.map((box) => ({
      check: "overflow" as const,
      box,
    })),
    ...m.tapTargets.tooSmall.map((box) => ({
      check: "tap-target-small" as const,
      box,
    })),
    ...m.text.smallElements.map((box) => ({
      check: "small-text" as const,
      box,
    })),
    ...m.tapTargets.crowded.map((box) => ({
      check: "tap-target-crowded" as const,
      box,
    })),
  ];
  const seen = new Set<string>();
  return ordered
    .filter(
      ({ box }) =>
        box.width >= 1 &&
        box.height >= 1 &&
        box.x >= 0 &&
        box.y >= 0 &&
        box.width * box.height <= 1_200_000,
    )
    .filter(({ box }) => {
      if (seen.has(box.selector)) return false;
      seen.add(box.selector);
      return true;
    })
    .slice(0, Math.max(0, max));
}

function isMeasurements(value: unknown): value is MobileAuditMeasurements {
  const v = value as Partial<MobileAuditMeasurements> | null;
  return Boolean(
    v &&
    v.viewport &&
    v.viewportMeta &&
    typeof v.documentWidth === "number" &&
    Array.isArray(v.overflowingElements) &&
    v.tapTargets &&
    v.text &&
    Array.isArray(v.overlays),
  );
}

/** Never throws: errors and timeouts are returned with their reason. */
export async function runMobileAuditInPage(params: {
  page: PlaywrightPageLike;
  pageUrl: string;
  now: () => number;
  timeoutMs?: number;
  maxCrops?: number;
}): Promise<MobileAuditResult> {
  const started = params.now();
  const meta = { format: MOBILE_AUDIT_FORMAT, pageUrl: params.pageUrl };
  const failed = (
    status: "error" | "timeout",
    message: string,
  ): MobileAuditResult => {
    const durationMs = Math.max(0, params.now() - started);
    return {
      status,
      durationMs,
      message,
      artifactJson: JSON.stringify({ ...meta, status, message, durationMs }),
    };
  };

  const timeoutMs = params.timeoutMs ?? MOBILE_AUDIT_DEFAULT_TIMEOUT_MS;
  let measurements: MobileAuditMeasurements;
  try {
    const outcome = await withTimeout(
      params.page.evaluate<string>(MOBILE_AUDIT_SCRIPT),
      timeoutMs,
    );
    if (outcome === "timeout") {
      return failed(
        "timeout",
        `The mobile layout audit did not finish within ${timeoutMs} ms.`,
      );
    }
    const parsed = JSON.parse(outcome) as unknown;
    if (!isMeasurements(parsed)) {
      return failed(
        "error",
        "The mobile layout audit returned an unexpected shape.",
      );
    }
    measurements = parsed;
  } catch (err) {
    return failed(
      "error",
      `The mobile layout audit could not run on this page: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const elementCrops: MobileElementCrop[] = [];
  let cropFailures = 0;
  for (const { check, box } of selectMobileCropTargets(
    measurements,
    params.maxCrops ?? MOBILE_AUDIT_DEFAULT_MAX_CROPS,
  )) {
    try {
      const png = await params.page.screenshot({
        type: "png",
        fullPage: true,
        clip: {
          x: Math.floor(box.x),
          y: Math.floor(box.y),
          width: Math.max(1, Math.ceil(box.width)),
          height: Math.max(1, Math.ceil(box.height)),
        },
      });
      elementCrops.push({
        check,
        selector: box.selector,
        box,
        png: toBytes(png),
      });
    } catch {
      cropFailures += 1; // the selector and box remain as evidence
    }
  }

  const durationMs = Math.max(0, params.now() - started);
  return {
    status: "ok",
    durationMs,
    measurements,
    artifactJson: JSON.stringify({
      ...meta,
      status: "ok",
      durationMs,
      measurements,
    }),
    elementCrops,
    cropFailures,
  };
}
