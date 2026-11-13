import {
  MOBILE_SMALL_TEXT_PX,
  MOBILE_TAP_TARGET_COMFORT_PX,
  MOBILE_TAP_TARGET_MIN_GAP_PX,
  MOBILE_TAP_TARGET_MIN_PX,
  type MobileAuditMeasurements,
  type MobileCheckKind,
  type MobileElementBox,
} from "./mobile-audit";

/**
 * Mobile usability rules (THE-184) over the measurements the mobile capture
 * stored (`mobile_raw`). Element findings cite a crop of the element when one
 * was taken, otherwise the mobile screenshot, with the selector and box.
 */

export const MOBILE_RULE_VERSION = "1.0.0";

/** WCAG 1.4.4: users must be able to zoom to 200 %. */
export const MOBILE_MIN_ALLOWED_MAX_SCALE = 2;
/** Lighthouse's legibility audit fails when less than 60 % of text is ≥ 12 px. */
export const MOBILE_MAX_SMALL_TEXT_SHARE = 0.4;
/** Overlays covering more than this share of the first screen's height. */
export const MOBILE_OVERLAY_MAX_COVERAGE = 0.3;
/** Occurrences listed per rule per page (the full count is kept). */
export const MOBILE_MAX_OCCURRENCES_PER_PAGE = 10;

export type MobileSeverity = "high" | "medium" | "low";

export interface MobileRule {
  ruleId: string;
  title: string;
  severity: MobileSeverity;
  effort: "low" | "medium" | "high";
  impact: "low" | "medium" | "high" | "critical";
  fixRole: "developer" | "designer";
  expectation: {
    operator: "lt" | "lte" | "gt" | "gte" | "eq" | "neq" | "exists";
    target: number | string | boolean;
    unit?: string;
  };
}

export const MOBILE_RULES: readonly MobileRule[] = [
  {
    ruleId: "mobile.viewport.missing",
    title:
      "Page has no mobile viewport tag, so phones show a shrunken desktop page",
    severity: "high",
    effort: "low",
    impact: "high",
    fixRole: "developer",
    expectation: { operator: "exists", target: true },
  },
  {
    ruleId: "mobile.viewport.not-device-width",
    title: "Viewport tag does not use width=device-width",
    severity: "medium",
    effort: "low",
    impact: "medium",
    fixRole: "developer",
    expectation: { operator: "eq", target: "width=device-width" },
  },
  {
    ruleId: "mobile.viewport.zoom-disabled",
    title: "Viewport tag stops people from zooming in",
    severity: "medium",
    effort: "low",
    impact: "medium",
    fixRole: "developer",
    expectation: {
      operator: "gte",
      target: MOBILE_MIN_ALLOWED_MAX_SCALE,
      unit: "maximum-scale",
    },
  },
  {
    ruleId: "mobile.overflow.horizontal",
    title: "Page scrolls sideways on a phone",
    severity: "high",
    effort: "medium",
    impact: "high",
    fixRole: "developer",
    expectation: {
      operator: "lte",
      target: 0,
      unit: "px wider than the screen",
    },
  },
  {
    ruleId: "mobile.tap-target.too-small",
    title: "Buttons or links are too small to tap",
    severity: "medium",
    effort: "low",
    impact: "medium",
    fixRole: "designer",
    expectation: {
      operator: "gte",
      target: MOBILE_TAP_TARGET_MIN_PX,
      unit: "px",
    },
  },
  {
    ruleId: "mobile.tap-target.crowded",
    title: "Buttons or links are packed too close together",
    severity: "low",
    effort: "low",
    impact: "low",
    fixRole: "designer",
    expectation: {
      operator: "gte",
      target: MOBILE_TAP_TARGET_MIN_GAP_PX,
      unit: "px gap",
    },
  },
  {
    ruleId: "mobile.text.too-small",
    title: "Too much text is too small to read on a phone",
    severity: "medium",
    effort: "low",
    impact: "medium",
    fixRole: "designer",
    expectation: {
      operator: "lte",
      target: MOBILE_MAX_SMALL_TEXT_SHARE,
      unit: `share of text under ${MOBILE_SMALL_TEXT_PX}px`,
    },
  },
  {
    ruleId: "mobile.overlay.intrusive",
    title: "A banner or pop-up covers a large part of the screen on load",
    severity: "medium",
    effort: "low",
    impact: "high",
    fixRole: "designer",
    expectation: {
      operator: "lte",
      target: MOBILE_OVERLAY_MAX_COVERAGE,
      unit: "share of screen height",
    },
  },
];

export interface MobileCropRef {
  check: MobileCheckKind;
  selector: string;
  artifactId: string;
}

export interface MobilePageFacts {
  pageId: string;
  pageUrl: string;
  measurements: MobileAuditMeasurements;
  evidence: {
    raw: string;
    screenshot: string | null;
    crops: readonly MobileCropRef[];
  };
}

export interface MobileViolation {
  ruleId: string;
  pageId: string;
  pageUrl: string;
  severity: MobileSeverity;
  evidenceArtifactId: string;
  excerpt: string;
  occurrenceKey?: string;
  selector?: string;
  bbox?: { x: number; y: number; width: number; height: number };
  context?: Record<string, unknown>;
}

export interface ParsedViewportMeta {
  width: string | null;
  userScalable: string | null;
  maximumScale: number | null;
}

/** Parses `width=device-width, initial-scale=1, maximum-scale=1` (comma or semicolon separated). */
export function parseViewportContent(content: string): ParsedViewportMeta {
  const result: ParsedViewportMeta = {
    width: null,
    userScalable: null,
    maximumScale: null,
  };
  for (const part of content.split(/[,;]/)) {
    const [rawKey, ...rest] = part.split("=");
    const key = (rawKey ?? "").trim().toLowerCase();
    const value = rest.join("=").trim().toLowerCase();
    if (key === "width") result.width = value || null;
    else if (key === "user-scalable") result.userScalable = value || null;
    else if (key === "maximum-scale") {
      const n = Number(value);
      result.maximumScale = Number.isFinite(n) ? n : null;
    }
  }
  return result;
}

export function isZoomDisabled(meta: ParsedViewportMeta): boolean {
  return (
    meta.userScalable === "no" ||
    meta.userScalable === "0" ||
    (meta.maximumScale !== null &&
      meta.maximumScale < MOBILE_MIN_ALLOWED_MAX_SCALE)
  );
}

function elementEvidence(
  facts: MobilePageFacts,
  check: MobileCheckKind,
  selector: string,
): string {
  return (
    facts.evidence.crops.find(
      (c) => c.check === check && c.selector === selector,
    )?.artifactId ??
    facts.evidence.screenshot ??
    facts.evidence.raw
  );
}

function elementViolations(
  facts: MobilePageFacts,
  ruleId: string,
  severity: MobileSeverity,
  check: MobileCheckKind,
  boxes: readonly MobileElementBox[],
  describe: (box: MobileElementBox) => string,
): MobileViolation[] {
  return boxes.slice(0, MOBILE_MAX_OCCURRENCES_PER_PAGE).map((box) => ({
    ruleId,
    pageId: facts.pageId,
    pageUrl: facts.pageUrl,
    severity,
    evidenceArtifactId: elementEvidence(facts, check, box.selector),
    excerpt: describe(box),
    occurrenceKey: box.selector,
    selector: box.selector,
    bbox: { x: box.x, y: box.y, width: box.width, height: box.height },
  }));
}

/** The size that receives a tap when the audit measured it, else the box. */
function tapSize(b: MobileElementBox): string {
  const t = b as MobileElementBox & { hitWidth?: number; hitHeight?: number };
  return `${t.hitWidth ?? b.width}×${t.hitHeight ?? b.height}`;
}

export function evaluateMobilePageRules(
  facts: MobilePageFacts,
): MobileViolation[] {
  const m = facts.measurements;
  const page = {
    pageId: facts.pageId,
    pageUrl: facts.pageUrl,
    evidenceArtifactId: facts.evidence.raw,
  };
  const out: MobileViolation[] = [];

  if (m.viewportMeta.count === 0 || !m.viewportMeta.content) {
    // Without a viewport tag the phone lays the page out ~980 px wide and
    // shrinks it; sizes measured on that layout would only repeat this problem.
    out.push({
      ...page,
      ruleId: "mobile.viewport.missing",
      severity: "high",
      excerpt: `No <meta name="viewport">; the phone rendered the page ${m.viewport.width} px wide and scaled it down.`,
      context: { layoutWidth: m.viewport.width },
    });
    if (m.overlays.length > 0) out.push(...overlayViolations(facts));
    return out;
  }

  const meta = parseViewportContent(m.viewportMeta.content);
  if (meta.width !== "device-width") {
    out.push({
      ...page,
      ruleId: "mobile.viewport.not-device-width",
      severity: "medium",
      excerpt: `<meta name="viewport" content="${m.viewportMeta.content}">`,
      context: { content: m.viewportMeta.content },
    });
  }
  if (isZoomDisabled(meta)) {
    out.push({
      ...page,
      ruleId: "mobile.viewport.zoom-disabled",
      severity: "medium",
      excerpt: `<meta name="viewport" content="${m.viewportMeta.content}">`,
      context: {
        content: m.viewportMeta.content,
        userScalable: meta.userScalable,
        maximumScale: meta.maximumScale,
      },
    });
  }

  const extraWidth = m.documentWidth - m.viewport.width;
  if (extraWidth > 1) {
    const elements = elementViolations(
      facts,
      "mobile.overflow.horizontal",
      "high",
      "overflow",
      m.overflowingElements,
      (b) =>
        `${b.selector} is ${b.width} px wide and reaches ${b.x + b.width} px on a ${m.viewport.width} px screen.`,
    );
    out.push(
      ...(elements.length > 0
        ? elements
        : [
            {
              ...page,
              ruleId: "mobile.overflow.horizontal",
              severity: "high" as const,
              excerpt: `The page is ${m.documentWidth} px wide on a ${m.viewport.width} px screen.`,
            },
          ]),
    );
  }

  out.push(
    ...elementViolations(
      facts,
      "mobile.tap-target.too-small",
      "medium",
      "tap-target-small",
      m.tapTargets.tooSmall,
      (b) =>
        `"${(b as MobileElementBox & { label?: string }).label ?? b.selector}" is ${tapSize(b)} px to tap (minimum ${MOBILE_TAP_TARGET_MIN_PX}×${MOBILE_TAP_TARGET_MIN_PX}, or enough space around it).`,
    ),
    ...elementViolations(
      facts,
      "mobile.tap-target.crowded",
      "low",
      "tap-target-crowded",
      m.tapTargets.crowded,
      (b) => {
        const t = b as MobileElementBox & { label?: string; gapPx?: number };
        return `"${t.label ?? b.selector}" is ${tapSize(b)} px to tap with only ${t.gapPx ?? 0} px to the next target (aim for ${MOBILE_TAP_TARGET_COMFORT_PX}×${MOBILE_TAP_TARGET_COMFORT_PX} px or ${MOBILE_TAP_TARGET_MIN_GAP_PX} px apart).`;
      },
    ),
  );

  const smallShare =
    m.text.totalChars > 0 ? m.text.smallChars / m.text.totalChars : 0;
  if (smallShare > MOBILE_MAX_SMALL_TEXT_SHARE) {
    const elements = elementViolations(
      facts,
      "mobile.text.too-small",
      "medium",
      "small-text",
      m.text.smallElements,
      (b) => {
        const t = b as MobileElementBox & {
          fontSizePx?: number;
          sample?: string;
        };
        return `${t.fontSizePx ?? "?"} px text: "${t.sample ?? ""}"`;
      },
    );
    const summary = {
      smallChars: m.text.smallChars,
      totalChars: m.text.totalChars,
      smallShare: Math.round(smallShare * 1000) / 1000,
    };
    out.push(
      ...(elements.length > 0
        ? elements.map((e, i) => (i === 0 ? { ...e, context: summary } : e))
        : [
            {
              ...page,
              ruleId: "mobile.text.too-small",
              severity: "medium" as const,
              excerpt: `${Math.round(smallShare * 100)} % of the text is under ${MOBILE_SMALL_TEXT_PX} px.`,
              context: summary,
            },
          ]),
    );
  }

  out.push(...overlayViolations(facts));
  return out;
}

function overlayViolations(facts: MobilePageFacts): MobileViolation[] {
  const overlays = facts.measurements.overlays.filter(
    (o) => o.coverage > MOBILE_OVERLAY_MAX_COVERAGE,
  );
  return elementViolations(
    facts,
    "mobile.overlay.intrusive",
    "medium",
    "overlay",
    overlays,
    (b) => {
      const o = b as MobileElementBox & {
        coverage?: number;
        position?: string;
        sample?: string;
      };
      return `${o.position ?? "fixed"} element covers ${Math.round((o.coverage ?? 0) * 100)} % of the screen height on load: "${o.sample ?? ""}"`;
    },
  );
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

export const MOBILE_PROVISIONAL_PRIORITY: Readonly<
  Record<MobileSeverity, number>
> = {
  high: 70,
  medium: 45,
  low: 20,
};

const SEVERITY_RANK: Readonly<Record<MobileSeverity, number>> = {
  low: 0,
  medium: 1,
  high: 2,
};

export interface MobileFindingCandidate {
  ruleId: string;
  ruleVersion: string;
  category: "mobile";
  severity: MobileSeverity;
  effort: MobileRule["effort"];
  impact: MobileRule["impact"];
  priorityScore: number;
  title: string;
  measured: {
    metric: string;
    value: number;
    unit: string;
    rawContext: Record<string, unknown>;
  };
  threshold: MobileRule["expectation"];
  fixRole: MobileRule["fixRole"];
  occurrences: MobileViolation[];
}

export function buildMobileFindingCandidates(
  violations: readonly MobileViolation[],
): MobileFindingCandidate[] {
  const candidates: MobileFindingCandidate[] = [];
  for (const rule of MOBILE_RULES) {
    const occurrences = violations.filter((v) => v.ruleId === rule.ruleId);
    if (occurrences.length === 0) continue;
    const severity = occurrences.reduce<MobileSeverity>(
      (worst, v) =>
        SEVERITY_RANK[v.severity] > SEVERITY_RANK[worst] ? v.severity : worst,
      "low",
    );
    candidates.push({
      ruleId: rule.ruleId,
      ruleVersion: MOBILE_RULE_VERSION,
      category: "mobile",
      severity,
      effort: rule.effort,
      impact: rule.impact,
      priorityScore: MOBILE_PROVISIONAL_PRIORITY[severity],
      title: rule.title,
      measured: {
        metric: rule.ruleId,
        value: new Set(occurrences.map((v) => v.pageId)).size,
        unit: "pages",
        rawContext: {
          affectedUrls: [...new Set(occurrences.map((v) => v.pageUrl))],
          elements: occurrences.filter((v) => v.selector).length,
          details: occurrences
            .map((v) => v.context)
            .filter((c): c is Record<string, unknown> => c !== undefined),
        },
      },
      threshold: rule.expectation,
      fixRole: rule.fixRole,
      occurrences,
    });
  }
  return candidates;
}

export function evaluateMobileRules(
  pages: readonly MobilePageFacts[],
): MobileFindingCandidate[] {
  return buildMobileFindingCandidates(pages.flatMap(evaluateMobilePageRules));
}
