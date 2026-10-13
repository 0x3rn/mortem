import { describe, expect, it } from "vitest";
import {
  CATEGORY_WEIGHTS,
  DIAGNOSTIC_CATEGORIES,
  normalizeUrlInput,
} from "@mortem/core";

describe("@mortem/web shared core integration", () => {
  it("normalizes user intake URLs identically to the scan worker", () => {
    expect(normalizeUrlInput("linear.app/features")).toBe(
      "https://linear.app/features",
    );
    expect(normalizeUrlInput("not-a-domain")).toBeNull();
  });

  it("reads the 7 diagnostic categories from @mortem/core", () => {
    expect(DIAGNOSTIC_CATEGORIES).toContain("performance");
    expect(DIAGNOSTIC_CATEGORIES).toContain("conversion");
    expect(CATEGORY_WEIGHTS.performance).toBe(0.2);
    expect(CATEGORY_WEIGHTS.conversion).toBe(0.2);
  });
});
