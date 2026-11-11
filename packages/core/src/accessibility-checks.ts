/**
 * Accessibility findings from axe-core results (THE-182).
 *
 * Pure functions: parse the `axe_raw` artifacts captured per page and viewport,
 * map each axe rule to WCAG 2.2 success criteria and the people it affects,
 * and merge the same rule across pages and viewports into one finding.
 *
 * This is an automated review, not a conformance claim: see
 * ACCESSIBILITY_COVERAGE_NOTE, which reports must show.
 */

export const ACCESSIBILITY_MAPPING_VERSION = "1.0.0";

/** Copy every accessibility report must show next to these findings. */
export const ACCESSIBILITY_COVERAGE_NOTE =
  "This is an automated accessibility review using axe-core. Automated checks find roughly 30–50% of WCAG issues: they cannot judge keyboard navigation and focus order, how a screen reader announces content, whether alternative text is meaningful, or how understandable the page is. Passing these checks does not mean the site conforms to WCAG or meets legal requirements — manual keyboard and screen-reader testing is still required.";

export type WcagLevel = "A" | "AA" | "AAA";

/** WCAG 2.2 success criteria (number → name and level). 4.1.1 is obsolete in 2.2. */
export const WCAG_SUCCESS_CRITERIA: Readonly<
  Record<string, { name: string; level: WcagLevel | "obsolete" }>
> = {
  "1.1.1": { name: "Non-text Content", level: "A" },
  "1.2.1": { name: "Audio-only and Video-only (Prerecorded)", level: "A" },
  "1.2.2": { name: "Captions (Prerecorded)", level: "A" },
  "1.2.3": {
    name: "Audio Description or Media Alternative (Prerecorded)",
    level: "A",
  },
  "1.2.4": { name: "Captions (Live)", level: "AA" },
  "1.2.5": { name: "Audio Description (Prerecorded)", level: "AA" },
  "1.2.6": { name: "Sign Language (Prerecorded)", level: "AAA" },
  "1.2.7": { name: "Extended Audio Description (Prerecorded)", level: "AAA" },
  "1.2.8": { name: "Media Alternative (Prerecorded)", level: "AAA" },
  "1.2.9": { name: "Audio-only (Live)", level: "AAA" },
  "1.3.1": { name: "Info and Relationships", level: "A" },
  "1.3.2": { name: "Meaningful Sequence", level: "A" },
  "1.3.3": { name: "Sensory Characteristics", level: "A" },
  "1.3.4": { name: "Orientation", level: "AA" },
  "1.3.5": { name: "Identify Input Purpose", level: "AA" },
  "1.3.6": { name: "Identify Purpose", level: "AAA" },
  "1.4.1": { name: "Use of Color", level: "A" },
  "1.4.2": { name: "Audio Control", level: "A" },
  "1.4.3": { name: "Contrast (Minimum)", level: "AA" },
  "1.4.4": { name: "Resize Text", level: "AA" },
  "1.4.5": { name: "Images of Text", level: "AA" },
  "1.4.6": { name: "Contrast (Enhanced)", level: "AAA" },
  "1.4.7": { name: "Low or No Background Audio", level: "AAA" },
  "1.4.8": { name: "Visual Presentation", level: "AAA" },
  "1.4.9": { name: "Images of Text (No Exception)", level: "AAA" },
  "1.4.10": { name: "Reflow", level: "AA" },
  "1.4.11": { name: "Non-text Contrast", level: "AA" },
  "1.4.12": { name: "Text Spacing", level: "AA" },
  "1.4.13": { name: "Content on Hover or Focus", level: "AA" },
  "2.1.1": { name: "Keyboard", level: "A" },
  "2.1.2": { name: "No Keyboard Trap", level: "A" },
  "2.1.3": { name: "Keyboard (No Exception)", level: "AAA" },
  "2.1.4": { name: "Character Key Shortcuts", level: "A" },
  "2.2.1": { name: "Timing Adjustable", level: "A" },
  "2.2.2": { name: "Pause, Stop, Hide", level: "A" },
  "2.2.3": { name: "No Timing", level: "AAA" },
  "2.2.4": { name: "Interruptions", level: "AAA" },
  "2.2.5": { name: "Re-authenticating", level: "AAA" },
  "2.2.6": { name: "Timeouts", level: "AAA" },
  "2.3.1": { name: "Three Flashes or Below Threshold", level: "A" },
  "2.3.2": { name: "Three Flashes", level: "AAA" },
  "2.3.3": { name: "Animation from Interactions", level: "AAA" },
  "2.4.1": { name: "Bypass Blocks", level: "A" },
  "2.4.2": { name: "Page Titled", level: "A" },
  "2.4.3": { name: "Focus Order", level: "A" },
  "2.4.4": { name: "Link Purpose (In Context)", level: "A" },
  "2.4.5": { name: "Multiple Ways", level: "AA" },
  "2.4.6": { name: "Headings and Labels", level: "AA" },
  "2.4.7": { name: "Focus Visible", level: "AA" },
  "2.4.8": { name: "Location", level: "AAA" },
  "2.4.9": { name: "Link Purpose (Link Only)", level: "AAA" },
  "2.4.10": { name: "Section Headings", level: "AAA" },
  "2.4.11": { name: "Focus Not Obscured (Minimum)", level: "AA" },
  "2.4.12": { name: "Focus Not Obscured (Enhanced)", level: "AAA" },
  "2.4.13": { name: "Focus Appearance", level: "AAA" },
  "2.5.1": { name: "Pointer Gestures", level: "A" },
  "2.5.2": { name: "Pointer Cancellation", level: "A" },
  "2.5.3": { name: "Label in Name", level: "A" },
  "2.5.4": { name: "Motion Actuation", level: "A" },
  "2.5.5": { name: "Target Size (Enhanced)", level: "AAA" },
  "2.5.6": { name: "Concurrent Input Mechanisms", level: "AAA" },
  "2.5.7": { name: "Dragging Movements", level: "AA" },
  "2.5.8": { name: "Target Size (Minimum)", level: "AA" },
  "3.1.1": { name: "Language of Page", level: "A" },
  "3.1.2": { name: "Language of Parts", level: "AA" },
  "3.1.3": { name: "Unusual Words", level: "AAA" },
  "3.1.4": { name: "Abbreviations", level: "AAA" },
  "3.1.5": { name: "Reading Level", level: "AAA" },
  "3.1.6": { name: "Pronunciation", level: "AAA" },
  "3.2.1": { name: "On Focus", level: "A" },
  "3.2.2": { name: "On Input", level: "A" },
  "3.2.3": { name: "Consistent Navigation", level: "AA" },
  "3.2.4": { name: "Consistent Identification", level: "AA" },
  "3.2.5": { name: "Change on Request", level: "AAA" },
  "3.2.6": { name: "Consistent Help", level: "A" },
  "3.3.1": { name: "Error Identification", level: "A" },
  "3.3.2": { name: "Labels or Instructions", level: "A" },
  "3.3.3": { name: "Error Suggestion", level: "AA" },
  "3.3.4": { name: "Error Prevention (Legal, Financial, Data)", level: "AA" },
  "3.3.5": { name: "Help", level: "AAA" },
  "3.3.6": { name: "Error Prevention (All)", level: "AAA" },
  "3.3.7": { name: "Redundant Entry", level: "A" },
  "3.3.8": { name: "Accessible Authentication (Minimum)", level: "AA" },
  "3.3.9": { name: "Accessible Authentication (Enhanced)", level: "AAA" },
  "4.1.1": { name: "Parsing (obsolete in WCAG 2.2)", level: "obsolete" },
  "4.1.2": { name: "Name, Role, Value", level: "A" },
  "4.1.3": { name: "Status Messages", level: "AA" },
};

export interface WcagCriterion {
  sc: string;
  name: string | null;
  level: WcagLevel | "obsolete" | null;
}

/** axe tags such as `wcag143` or `wcag1410` → WCAG success criteria. */
export function wcagCriteriaFromTags(tags: readonly string[]): WcagCriterion[] {
  const out: WcagCriterion[] = [];
  for (const tag of tags) {
    const match = /^wcag(\d)(\d)(\d{1,2})$/.exec(tag);
    if (!match) continue;
    const sc = `${match[1]}.${match[2]}.${Number(match[3])}`;
    if (out.some((c) => c.sc === sc)) continue;
    const known = WCAG_SUCCESS_CRITERIA[sc];
    out.push({ sc, name: known?.name ?? null, level: known?.level ?? null });
  }
  return out;
}

/** Who a barrier affects, from axe's `cat.*` tags. */
export const AXE_CATEGORY_GROUPS: Readonly<Record<string, string>> = {
  "cat.color": "People with low vision or colour-vision deficiency",
  "cat.keyboard":
    "Keyboard-only users, including many people with motor disabilities",
  "cat.aria": "Screen reader and voice-control users",
  "cat.name-role-value": "Screen reader and voice-control users",
  "cat.text-alternatives": "Blind and low-vision people using screen readers",
  "cat.forms":
    "Screen reader users and people with cognitive disabilities completing forms",
  "cat.language":
    "Screen reader users (pronunciation) and people using translation tools",
  "cat.structure":
    "Screen reader users navigating by headings, landmarks and lists",
  "cat.semantics":
    "Screen reader users navigating by headings, landmarks and lists",
  "cat.sensory-and-visual-cues": "People with low vision",
  "cat.tables": "Screen reader users reading data tables",
  "cat.time-and-media":
    "Deaf, hard-of-hearing and blind people using audio or video",
  "cat.parsing": "Assistive technology users",
};

export function affectedGroupsFromTags(tags: readonly string[]): string[] {
  const groups = tags
    .map((tag) => AXE_CATEGORY_GROUPS[tag])
    .filter((group): group is string => group !== undefined);
  return groups.length > 0
    ? [...new Set(groups)]
    : ["Assistive technology users"];
}

// ---------------------------------------------------------------------------
// Parsing the stored axe_raw artifact
// ---------------------------------------------------------------------------

export interface AxeNodeSummary {
  /** CSS selector; iframe / shadow DOM paths are joined with " >>> ". */
  target: string | null;
  html: string;
  failureSummary: string | null;
  impact: string | null;
}

export interface AxeViolationSummary {
  id: string;
  impact: string | null;
  help: string;
  helpUrl: string | null;
  tags: string[];
  nodes: AxeNodeSummary[];
}

export interface ParsedAxeArtifact {
  viewport: "desktop" | "mobile";
  pageUrl: string | null;
  axeVersion: string | null;
  violations: AxeViolationSummary[];
  /** Rules axe could not decide automatically ("needs review"). */
  incompleteRuleCount: number;
  boundingBoxes: Array<{
    ruleId: string;
    target: string;
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
}

export type AxeArtifactParseResult =
  | { ok: true; data: ParsedAxeArtifact }
  | {
      ok: false;
      status: "error" | "timeout" | "skipped" | "invalid";
      message: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function targetToString(target: unknown): string | null {
  if (!Array.isArray(target) || target.length === 0) return null;
  const parts = target.map((part) =>
    typeof part === "string"
      ? part
      : Array.isArray(part)
        ? part.filter((p) => typeof p === "string").join(" >>> ")
        : "",
  );
  return parts.every((p) => p.length > 0) ? parts.join(" >>> ") : null;
}

export function parseAxeArtifact(raw: unknown): AxeArtifactParseResult {
  if (!isRecord(raw)) {
    return {
      ok: false,
      status: "invalid",
      message: "axe artifact is not a JSON object.",
    };
  }
  const status = raw.status;
  if (status === "error" || status === "timeout" || status === "skipped") {
    return {
      ok: false,
      status,
      message: str(raw.message) ?? `axe-core ${status} on this page.`,
    };
  }
  const viewport = raw.viewport;
  const results = raw.axeResults;
  if (
    status !== "ok" ||
    (viewport !== "desktop" && viewport !== "mobile") ||
    !isRecord(results) ||
    !Array.isArray(results.violations)
  ) {
    return {
      ok: false,
      status: "invalid",
      message: "axe artifact is missing results.",
    };
  }

  const violations: AxeViolationSummary[] = [];
  for (const v of results.violations) {
    if (!isRecord(v) || typeof v.id !== "string" || !Array.isArray(v.nodes))
      continue;
    const tags = Array.isArray(v.tags)
      ? v.tags.filter((t): t is string => typeof t === "string")
      : [];
    violations.push({
      id: v.id,
      impact: str(v.impact),
      help: str(v.help) ?? v.id,
      helpUrl: str(v.helpUrl),
      tags,
      nodes: v.nodes.filter(isRecord).map((n) => ({
        target: targetToString(n.target),
        html: typeof n.html === "string" ? n.html : "",
        failureSummary: str(n.failureSummary),
        impact: str(n.impact),
      })),
    });
  }

  const engine = isRecord(results.testEngine) ? results.testEngine : null;
  const boxes = Array.isArray(raw.boundingBoxes) ? raw.boundingBoxes : [];
  return {
    ok: true,
    data: {
      viewport,
      pageUrl: str(raw.pageUrl),
      axeVersion: engine ? str(engine.version) : null,
      violations,
      incompleteRuleCount: Array.isArray(results.incomplete)
        ? results.incomplete.length
        : 0,
      boundingBoxes: boxes.filter(
        (b): b is ParsedAxeArtifact["boundingBoxes"][number] =>
          isRecord(b) &&
          typeof b.ruleId === "string" &&
          typeof b.target === "string" &&
          ["x", "y", "width", "height"].every(
            (k) => typeof b[k] === "number" && Number.isFinite(b[k]),
          ),
      ),
    },
  };
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

export type AccessibilitySeverity = "critical" | "high" | "medium" | "low";

const IMPACT_TO_SEVERITY: Readonly<Record<string, AccessibilitySeverity>> = {
  critical: "critical",
  serious: "high",
  moderate: "medium",
  minor: "low",
};

const SEVERITY_RANK: Readonly<Record<AccessibilitySeverity, number>> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

export const ACCESSIBILITY_PROVISIONAL_PRIORITY: Readonly<
  Record<AccessibilitySeverity, number>
> = { critical: 90, high: 70, medium: 45, low: 20 };

/** Occurrences listed per rule, per page and viewport; the full count stays in measured. */
export const MAX_NODES_PER_RULE_PER_VIEWPORT = 10;

const MAX_EXCERPT = 500;

export interface AccessibilityPageInput {
  pageId: string;
  pageUrl: string;
  viewport: "desktop" | "mobile";
  /** `evidence_artifacts.id` of this page+viewport's `axe_raw`. */
  axeArtifactId: string;
  /** Element crops stored for this page+viewport. */
  crops: ReadonlyArray<{ ruleId: string; target: string; artifactId: string }>;
  data: ParsedAxeArtifact;
}

export interface AccessibilityOccurrence {
  pageId: string;
  pageUrl: string;
  viewport: "desktop" | "mobile";
  evidenceArtifactId: string;
  selector: string | null;
  excerpt: string;
  bbox: {
    x: number;
    y: number;
    width: number;
    height: number;
    viewport: "desktop" | "mobile";
  } | null;
  occurrenceKey: string;
}

export interface AccessibilityFindingCandidate {
  ruleId: string;
  ruleVersion: string;
  category: "accessibility";
  severity: AccessibilitySeverity;
  effort: "low" | "medium" | "high";
  impact: "low" | "medium" | "high" | "critical";
  priorityScore: number;
  title: string;
  measured: {
    metric: "a11y_violation_elements";
    value: number;
    unit: "elements";
    rawContext: {
      axeRuleId: string;
      helpUrl: string | null;
      wcag: WcagCriterion[];
      bestPracticeOnly: boolean;
      affectedGroups: string[];
      affectedUrls: string[];
      viewports: Array<"desktop" | "mobile">;
      axeVersions: string[];
      elementsNotListed: number;
      coverageNote: string;
    };
  };
  threshold: { operator: "eq"; target: 0; unit: "elements" };
  fixRole: "developer" | "designer" | "content";
  occurrences: AccessibilityOccurrence[];
}

function severityOf(impact: string | null): AccessibilitySeverity {
  return IMPACT_TO_SEVERITY[impact ?? ""] ?? "medium";
}

function ruleIdFor(axeId: string): string {
  return `a11y.${axeId.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;
}

function fixRoleFor(
  tags: readonly string[],
): AccessibilityFindingCandidate["fixRole"] {
  if (tags.includes("cat.color")) return "designer";
  if (tags.includes("cat.text-alternatives")) return "content";
  return "developer";
}

function effortFor(axeId: string): AccessibilityFindingCandidate["effort"] {
  // Contrast and landmark structure usually touch shared styles or layouts.
  return [
    "color-contrast",
    "region",
    "landmark-one-main",
    "page-has-heading-one",
  ].includes(axeId)
    ? "medium"
    : "low";
}

function firstLine(text: string | null): string {
  if (!text) return "";
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  // axe summaries start with "Fix any/all of the following:" — the next line is the reason.
  return lines.length > 1 && /^fix (any|all)/i.test(lines[0]!)
    ? lines[1]!
    : (lines[0] ?? "");
}

function truncate(text: string): string {
  return text.length > MAX_EXCERPT
    ? `${text.slice(0, MAX_EXCERPT - 1)}…`
    : text;
}

/** One finding per axe rule across all pages and viewports. */
export function evaluateAccessibility(
  inputs: readonly AccessibilityPageInput[],
): AccessibilityFindingCandidate[] {
  const byRule = new Map<
    string,
    {
      violation: AxeViolationSummary;
      entries: Array<{
        input: AccessibilityPageInput;
        violation: AxeViolationSummary;
      }>;
    }
  >();
  for (const input of inputs) {
    for (const violation of input.data.violations) {
      const group = byRule.get(violation.id) ?? { violation, entries: [] };
      group.entries.push({ input, violation });
      byRule.set(violation.id, group);
    }
  }

  const candidates: AccessibilityFindingCandidate[] = [];
  for (const [axeId, group] of [...byRule.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const occurrences: AccessibilityOccurrence[] = [];
    let severity: AccessibilitySeverity = "low";
    let totalNodes = 0;
    const tags = [...new Set(group.entries.flatMap((e) => e.violation.tags))];

    for (const { input, violation } of group.entries) {
      totalNodes += violation.nodes.length;
      violation.nodes.forEach((node, index) => {
        const nodeSeverity = severityOf(node.impact ?? violation.impact);
        if (SEVERITY_RANK[nodeSeverity] > SEVERITY_RANK[severity])
          severity = nodeSeverity;
        if (index >= MAX_NODES_PER_RULE_PER_VIEWPORT) return;

        const box = node.target
          ? input.data.boundingBoxes.find(
              (b) => b.ruleId === axeId && b.target === node.target,
            )
          : undefined;
        const crop = node.target
          ? input.crops.find(
              (c) => c.ruleId === axeId && c.target === node.target,
            )
          : undefined;
        const reason = firstLine(node.failureSummary);
        occurrences.push({
          pageId: input.pageId,
          pageUrl: input.pageUrl,
          viewport: input.viewport,
          // A crop of the element is the most direct proof; otherwise the raw axe results.
          evidenceArtifactId: crop?.artifactId ?? input.axeArtifactId,
          selector: node.target,
          excerpt: truncate(
            `${input.viewport}: ${reason ? `${reason} — ` : ""}${node.html || "(no HTML snippet)"}`,
          ),
          bbox: box
            ? {
                x: box.x,
                y: box.y,
                width: box.width,
                height: box.height,
                viewport: input.viewport,
              }
            : null,
          occurrenceKey: `${input.viewport}_${index}`,
        });
      });
    }

    const wcag = wcagCriteriaFromTags(tags);
    candidates.push({
      ruleId: ruleIdFor(axeId),
      ruleVersion: ACCESSIBILITY_MAPPING_VERSION,
      category: "accessibility",
      severity,
      effort: effortFor(axeId),
      impact: severity,
      priorityScore: ACCESSIBILITY_PROVISIONAL_PRIORITY[severity],
      title: group.violation.help,
      measured: {
        metric: "a11y_violation_elements",
        value: totalNodes,
        unit: "elements",
        rawContext: {
          axeRuleId: axeId,
          helpUrl: group.violation.helpUrl,
          wcag,
          bestPracticeOnly: wcag.length === 0,
          affectedGroups: affectedGroupsFromTags(tags),
          affectedUrls: [...new Set(group.entries.map((e) => e.input.pageUrl))],
          viewports: [...new Set(group.entries.map((e) => e.input.viewport))],
          axeVersions: [
            ...new Set(
              group.entries
                .map((e) => e.input.data.axeVersion)
                .filter((v): v is string => v !== null),
            ),
          ],
          elementsNotListed: totalNodes - occurrences.length,
          coverageNote: ACCESSIBILITY_COVERAGE_NOTE,
        },
      },
      threshold: { operator: "eq", target: 0, unit: "elements" },
      fixRole: fixRoleFor(tags),
      occurrences,
    });
  }
  return candidates;
}
