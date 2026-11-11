import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AXE_SOURCE } from "./axe-source";

describe("AXE_SOURCE (THE-182)", () => {
  it("is axe-core's minified browser build as a plain string, byte for byte", () => {
    const onDisk = readFileSync(
      join(__dirname, "../../../node_modules/axe-core/axe.min.js"),
      "utf8",
    );
    expect(typeof AXE_SOURCE).toBe("string");
    expect(AXE_SOURCE).toBe(onDisk);
    expect(AXE_SOURCE).toContain("axe v4.14.0");
  });
});

describe("wrangler bundling rule for axe-core (THE-182)", () => {
  it("keeps the Text rule that makes Wrangler ship axe.min.js as a string module", () => {
    const config = readFileSync(join(__dirname, "../wrangler.jsonc"), "utf8");
    // Verified with `wrangler deploy --dry-run`: only this glob form is honoured;
    // without it, axe is bundled as executable JavaScript and every audit fails.
    expect(config).toMatch(
      /"type":\s*"Text",\s*"globs":\s*\[\s*"\*\*\/axe\.min\.js"\s*\]/,
    );
  });
});
