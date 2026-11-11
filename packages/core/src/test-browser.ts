import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";

/**
 * Test-only: finds a locally installed Chromium so accessibility tests can run
 * axe-core in a real browser. Returns null when none is installed, so those
 * tests skip (with a reason) instead of failing on machines without browsers.
 */
export function findLocalChromium(): string | null {
  try {
    const bundled = chromium.executablePath();
    if (bundled && existsSync(bundled)) return bundled;
  } catch {
    // playwright-core could not resolve its own build; search the cache below
  }
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, "ms-playwright")
      : undefined,
    join(homedir(), ".cache", "ms-playwright"),
    join(homedir(), "Library", "Caches", "ms-playwright"),
  ].filter((root): root is string => Boolean(root) && existsSync(root!));

  const candidates = [
    ["chrome-win64", "chrome.exe"],
    ["chrome-win", "chrome.exe"],
    ["chrome-linux64", "chrome"],
    ["chrome-linux", "chrome"],
    ["chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"],
  ];
  for (const root of roots) {
    const builds = readdirSync(root)
      .filter((name) => /^chromium-\d+$/.test(name))
      .sort()
      .reverse();
    for (const build of builds) {
      for (const parts of candidates) {
        const exe = join(root, build, ...parts);
        if (existsSync(exe)) return exe;
      }
    }
  }
  return null;
}

export async function launchLocalChromium(
  executablePath: string,
): Promise<Browser> {
  return chromium.launch({ executablePath, headless: true });
}
