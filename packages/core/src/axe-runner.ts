import type { PlaywrightPageLike } from "./browser-capture";

/**
 * Runs axe-core inside a captured Browser Run page (THE-182).
 *
 * axe's source is injected with `page.evaluate(source)`, not a `<script>` tag:
 * DevTools evaluation is not subject to the page's Content-Security-Policy, so
 * strict-CSP sites can still be audited (verified in Chromium with
 * `script-src 'none'`). Running axe only reads the DOM; it never submits forms,
 * clicks, or changes the site.
 *
 * This never throws: an axe failure must not fail the page capture. Problems
 * come back as `status: "error" | "timeout" | "skipped"` with a message.
 */

export const AXE_RUN_TAGS = [
  "wcag2a",
  "wcag2aa",
  "wcag21a",
  "wcag21aa",
  "wcag22aa",
  "best-practice",
] as const;

export const AXE_ARTIFACT_FORMAT = "mortem-axe/1";
export const AXE_DEFAULT_TIMEOUT_MS = 20_000;
/** Element crops per page per viewport, most severe first. */
export const AXE_DEFAULT_MAX_CROPS = 5;
/** Boxes larger than this (CSS px²) are page sections, not crop-worthy elements. */
const MAX_CROP_AREA = 1_200_000;

export type AxeViewport = "desktop" | "mobile";

export interface AxeBoundingBox {
  ruleId: string;
  /** axe's CSS selector for the element. */
  target: string;
  impact: string | null;
  /** Document coordinates in CSS pixels. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AxeElementCrop {
  ruleId: string;
  target: string;
  box: AxeBoundingBox;
  png: Uint8Array;
}

export type AxeCaptureResult =
  | {
      status: "ok";
      durationMs: number;
      axeVersion: string | null;
      violationCount: number;
      /** JSON stored verbatim in R2 as `axe_raw`. */
      artifactJson: string;
      elementCrops: AxeElementCrop[];
      cropFailures: number;
    }
  | {
      status: "error" | "timeout" | "skipped";
      durationMs: number;
      message: string;
      /** JSON stored in R2 as `axe_raw` so the reason is evidence too. */
      artifactJson: string;
    };

/** Runs in the page: axe.run + document-coordinate boxes for each flagged element. */
function buildRunScript(): string {
  const tags = JSON.stringify(AXE_RUN_TAGS);
  return `(async () => {
  const results = await window.axe.run(document, {
    runOnly: { type: "tag", values: ${tags} },
    resultTypes: ["violations"],
  });
  const boundingBoxes = [];
  for (const violation of results.violations) {
    for (const node of violation.nodes) {
      const target = node.target && node.target.length === 1 ? node.target[0] : null;
      if (typeof target !== "string") continue; // iframe or shadow DOM path
      let el = null;
      try { el = document.querySelector(target); } catch (e) { el = null; }
      if (!el) continue;
      const r = el.getBoundingClientRect();
      boundingBoxes.push({
        ruleId: violation.id,
        target,
        impact: node.impact || violation.impact || null,
        x: r.left + window.scrollX,
        y: r.top + window.scrollY,
        width: r.width,
        height: r.height,
      });
    }
  }
  return JSON.stringify({ axeResults: results, boundingBoxes });
})()`;
}

const IMPACT_RANK: Readonly<Record<string, number>> = {
  critical: 3,
  serious: 2,
  moderate: 1,
  minor: 0,
};

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | "timeout"> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve("timeout"), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function toBytes(input: Uint8Array | ArrayBuffer): Uint8Array {
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

function isBox(value: unknown): value is AxeBoundingBox {
  if (typeof value !== "object" || value === null) return false;
  const box = value as Record<string, unknown>;
  return (
    typeof box.ruleId === "string" &&
    typeof box.target === "string" &&
    ["x", "y", "width", "height"].every(
      (key) => typeof box[key] === "number" && Number.isFinite(box[key]),
    )
  );
}

/** The most severe, crop-worthy boxes: real size, not page-sized, one per element. */
export function selectCropBoxes(
  boxes: readonly AxeBoundingBox[],
  max: number,
): AxeBoundingBox[] {
  const seen = new Set<string>();
  return [...boxes]
    .filter(
      (b) =>
        b.width >= 1 &&
        b.height >= 1 &&
        b.x >= 0 &&
        b.y >= 0 &&
        b.width * b.height <= MAX_CROP_AREA,
    )
    .sort(
      (a, b) =>
        (IMPACT_RANK[b.impact ?? ""] ?? -1) -
        (IMPACT_RANK[a.impact ?? ""] ?? -1),
    )
    .filter((b) => {
      const key = `${b.ruleId}|${b.target}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, Math.max(0, max));
}

export async function runAxeInPage(params: {
  page: PlaywrightPageLike;
  axeSource: string | null | undefined;
  viewport: AxeViewport;
  pageUrl: string;
  now: () => number;
  timeoutMs?: number;
  maxCrops?: number;
}): Promise<AxeCaptureResult> {
  const started = params.now();
  const meta = {
    format: AXE_ARTIFACT_FORMAT,
    viewport: params.viewport,
    pageUrl: params.pageUrl,
    runTags: AXE_RUN_TAGS,
  };
  const failed = (
    status: "error" | "timeout" | "skipped",
    message: string,
  ): AxeCaptureResult => {
    const durationMs = Math.max(0, params.now() - started);
    return {
      status,
      durationMs,
      message,
      artifactJson: JSON.stringify({ ...meta, status, message, durationMs }),
    };
  };

  if (!params.axeSource) {
    return failed(
      "skipped",
      "axe-core source was not provided to the capture stage.",
    );
  }

  let payload: { axeResults: unknown; boundingBoxes: unknown };
  try {
    const outcome = await withTimeout(
      (async () => {
        await params.page.evaluate(params.axeSource!);
        return params.page.evaluate<string>(buildRunScript());
      })(),
      params.timeoutMs ?? AXE_DEFAULT_TIMEOUT_MS,
    );
    if (outcome === "timeout") {
      return failed(
        "timeout",
        `axe-core did not finish within ${params.timeoutMs ?? AXE_DEFAULT_TIMEOUT_MS} ms.`,
      );
    }
    payload = JSON.parse(outcome) as typeof payload;
  } catch (err) {
    return failed(
      "error",
      `axe-core could not run on this page: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const axeResults = payload.axeResults as {
    violations?: unknown;
    testEngine?: { version?: unknown };
  } | null;
  if (!axeResults || !Array.isArray(axeResults.violations)) {
    return failed("error", "axe-core returned results in an unexpected shape.");
  }
  const boxes = Array.isArray(payload.boundingBoxes)
    ? payload.boundingBoxes.filter(isBox)
    : [];

  const elementCrops: AxeElementCrop[] = [];
  let cropFailures = 0;
  for (const box of selectCropBoxes(
    boxes,
    params.maxCrops ?? AXE_DEFAULT_MAX_CROPS,
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
        ruleId: box.ruleId,
        target: box.target,
        box,
        png: toBytes(png),
      });
    } catch {
      cropFailures += 1; // a missing crop leaves the selector and box as evidence
    }
  }

  const durationMs = Math.max(0, params.now() - started);
  const version = axeResults.testEngine?.version;
  return {
    status: "ok",
    durationMs,
    axeVersion: typeof version === "string" ? version : null,
    violationCount: axeResults.violations.length,
    artifactJson: JSON.stringify({
      ...meta,
      status: "ok",
      durationMs,
      axeResults,
      boundingBoxes: boxes,
    }),
    elementCrops,
    cropFailures,
  };
}
