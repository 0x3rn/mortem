// The declaration for the text-loaded "axe-core/axe.min.js" is ambient, so it cannot be
// imported; this reference carries it into every program that compiles this file
// (the web app type-checks worker sources through its @mortem/scan-worker path).
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./axe-source-module.d.ts" />
// axe-core's minified browser build, bundled as a plain string (THE-182).
// Wrangler loads it through the "Text" rule in wrangler.jsonc, and Vitest
// through the matching plugin in vitest.config.ts, so the string that tests
// inject is exactly the one production injects into Browser Run pages.
import axeMinSource from "axe-core/axe.min.js";

export const AXE_SOURCE: string = axeMinSource;
