import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runAccessibilityChecks } from "./accessibility-checks-runner";
import {
  capturePageAcrossViewports,
  type PlaywrightBrowserLike,
} from "./browser-capture";
import { persistPageCaptureEvidenceToR2AndD1 } from "./evidence-storage";
import { findLocalChromium, launchLocalChromium } from "./test-browser";
import {
  createInMemoryR2,
  createSqliteD1,
  seedScanWithPages,
} from "./test-support";

/**
 * Live end-to-end accessibility check (THE-182) on a real public page with a
 * real local Chromium: production capture (both viewports, axe-core injected)
 * → production evidence writer → accessibility runner. Skipped unless
 * A11Y_LIVE=1, so CI never depends on a third-party site.
 *
 *   A11Y_LIVE=1 A11Y_URL=https://mortem.corstack.dev/ npx vitest run src/accessibility-checks.live.test.ts
 */
const chromiumPath = findLocalChromium();
const url = process.env.A11Y_URL ?? "https://mortem.corstack.dev/";

describe.skipIf(process.env.A11Y_LIVE !== "1" || !chromiumPath)(
  "accessibility live (real page, real browser)",
  () => {
    it("captures, audits and writes evidence-backed findings for a real page", async () => {
      const browser = await launchLocalChromium(chromiumPath!);
      try {
        const capture = await capturePageAcrossViewports({
          targetUrl: url,
          browserLauncher: async () =>
            browser as unknown as PlaywrightBrowserLike,
          axeSource: readFileSync(
            resolve(__dirname, "../../../node_modules/axe-core/axe.min.js"),
            "utf8",
          ),
        });

        const d1 = createSqliteD1();
        const r2 = createInMemoryR2();
        await seedScanWithPages(d1, {
          scanId: "scan_live_a11y",
          origin: new URL(url).origin,
          pages: [{ id: "page_live", url, templateType: "home" }],
        });
        await persistPageCaptureEvidenceToR2AndD1({
          d1,
          r2,
          scanId: "scan_live_a11y",
          pageId: "page_live",
          capture,
        });
        const summary = await runAccessibilityChecks({
          d1,
          r2,
          scanId: "scan_live_a11y",
        });

        const findings = d1.sqlite
          .prepare(
            `SELECT f.check_id, f.severity, f.measured_value_json,
                    (SELECT COUNT(*) FROM finding_occurrences o WHERE o.finding_id = f.id) AS occurrences,
                    (SELECT COUNT(*) FROM finding_occurrences o JOIN evidence_artifacts a ON a.id = o.evidence_artifact_id
                      WHERE o.finding_id = f.id AND a.kind = 'screenshot_element') AS cropped,
                    (SELECT COUNT(*) FROM finding_occurrences o WHERE o.finding_id = f.id AND o.bbox_json IS NOT NULL) AS boxed
             FROM findings f ORDER BY f.priority_score DESC, f.check_id`,
          )
          .all() as Array<Record<string, unknown>>;
        console.info(
          JSON.stringify({
            url,
            captureStatus: capture.captureStatus,
            desktopAxe: capture.desktop.accessibility?.status,
            mobileAxe: capture.mobile.accessibility?.status,
            desktopAxeMs: capture.desktop.accessibility?.durationMs,
            mobileAxeMs: capture.mobile.accessibility?.durationMs,
            summary: { ...summary, coverageNote: undefined },
            findings: findings.map((f) => {
              const m = JSON.parse(String(f.measured_value_json));
              return `${f.check_id} [${f.severity}] elements=${m.value} occ=${f.occurrences} cropped=${f.cropped} boxed=${f.boxed} wcag=${m.rawContext.wcag.map((w: { sc: string; level: string }) => `${w.sc}/${w.level}`).join(",") || "best-practice"}`;
            }),
          }),
        );

        expect(capture.desktop.accessibility?.status).toBe("ok");
        expect(capture.mobile.accessibility?.status).toBe("ok");
        expect(summary.viewportsAudited).toBe(2);
        expect(summary.unavailable).toEqual([]);
      } finally {
        await browser.close();
      }
    }, 180_000);
  },
);
