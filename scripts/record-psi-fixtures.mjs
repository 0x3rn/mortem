#!/usr/bin/env node
/**
 * Records real PageSpeed Insights v5 responses as test fixtures (THE-180).
 *
 *   PAGESPEED_API_KEY=... node scripts/record-psi-fixtures.mjs https://example.com/ [more urls]
 *   node scripts/record-psi-fixtures.mjs --retrim
 *
 * Writes packages/core/src/__fixtures__/psi/recorded-<host>-<strategy>.json for
 * MOBILE and DESKTOP. Only HTTP 200 responses are written. The API key is read
 * from the environment, is never printed, and is stripped from any error text.
 * Recording makes live, quota-consuming requests to Google; run it manually.
 *
 * To keep the repository small, screenshots and the raw network-request log are
 * removed from fixtures (Mortem's parser reads neither). Everything else is kept
 * verbatim, and the removed parts are listed in `_mortemFixture.trimmed`.
 * Production stores the full untrimmed response in R2.
 * `--retrim` applies the same trimming to fixtures that are already recorded.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ENDPOINT = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
const STRATEGIES = ["MOBILE", "DESKTOP"];
const TIMEOUT_MS = 90_000;
const TRIMMED_AUDITS = [
  "screenshot-thumbnails",
  "final-screenshot",
  "network-requests",
];

const outDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../packages/core/src/__fixtures__/psi",
);

/** Removes bulky payloads the parser never reads; returns the list of removed paths. */
function trimFixture(fixture) {
  const removed = [];
  const lighthouse = fixture.lighthouseResult;
  if (lighthouse && typeof lighthouse === "object") {
    if ("fullPageScreenshot" in lighthouse) {
      delete lighthouse.fullPageScreenshot;
      removed.push("lighthouseResult.fullPageScreenshot");
    }
    for (const id of TRIMMED_AUDITS) {
      if (lighthouse.audits && id in lighthouse.audits) {
        delete lighthouse.audits[id];
        removed.push(`lighthouseResult.audits.${id}`);
      }
    }
  }
  return removed;
}

function writeFixture(file, fixture) {
  writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
}

if (process.argv[2] === "--retrim") {
  for (const name of readdirSync(outDir).filter(
    (n) => n.startsWith("recorded-") && n.endsWith(".json"),
  )) {
    const file = join(outDir, name);
    const fixture = JSON.parse(readFileSync(file, "utf8"));
    if (!fixture.lighthouseResult) continue; // recorded error responses have nothing to trim
    const removed = trimFixture(fixture);
    if (removed.length === 0) continue;
    const meta = fixture._mortemFixture ?? { origin: "recorded" };
    meta.trimmed = [...new Set([...(meta.trimmed ?? []), ...removed])];
    writeFixture(file, { _mortemFixture: meta, ...fixture });
    console.log(`Trimmed ${name}: ${removed.join(", ")}`);
  }
  process.exit(0);
}

const apiKey = process.env.PAGESPEED_API_KEY?.trim();
const urls = process.argv.slice(2);

if (!apiKey) {
  console.error(
    "PAGESPEED_API_KEY is not set. Export it in your shell (do not commit it) and re-run.",
  );
  process.exit(1);
}
if (urls.length === 0) {
  console.error(
    "Usage: PAGESPEED_API_KEY=... node scripts/record-psi-fixtures.mjs <url> [url...]",
  );
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

function redact(text) {
  return String(text).split(apiKey).join("REDACTED");
}

let failures = 0;

for (const target of urls) {
  let host;
  try {
    host = new URL(target).hostname.replace(/[^a-z0-9.-]/gi, "_");
  } catch {
    console.error(`Skipping invalid URL: ${target}`);
    failures += 1;
    continue;
  }

  for (const strategy of STRATEGIES) {
    const search = new URLSearchParams({
      url: target,
      strategy,
      category: "PERFORMANCE",
      key: apiKey,
    });
    try {
      const response = await fetch(`${ENDPOINT}?${search}`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const body = await response.text();
      if (!response.ok) {
        console.error(
          `${strategy} ${target}: HTTP ${response.status} — ${redact(body).slice(0, 300)}`,
        );
        failures += 1;
        continue;
      }

      const parsed = JSON.parse(body);
      const removed = trimFixture(parsed);
      const fixture = {
        _mortemFixture: {
          origin: "recorded",
          recordedAt: new Date().toISOString(),
          url: target,
          strategy,
          trimmed: removed,
        },
        ...parsed,
      };
      const file = join(
        outDir,
        `recorded-${host}-${strategy.toLowerCase()}.json`,
      );
      writeFixture(file, fixture);
      console.log(`Recorded ${strategy} ${target} -> ${file}`);
    } catch (error) {
      console.error(
        `${strategy} ${target}: ${redact(error instanceof Error ? error.message : error)}`,
      );
      failures += 1;
    }
  }
}

process.exit(failures === 0 ? 0 : 1);
