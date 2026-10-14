import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const targetFile = path.join(
  rootDir,
  "node_modules",
  "@opennextjs",
  "cloudflare",
  "dist",
  "cli",
  "build",
  "patches",
  "plugins",
  "load-manifest.js",
);

if (fs.existsSync(targetFile)) {
  let content = fs.readFileSync(targetFile, "utf8");
  let modified = false;

  if (
    content.includes(
      "{*-manifest,required-server-files,prefetch-hints}.json",
    ) &&
    !content.includes("preview-props")
  ) {
    content = content.replace(
      "{*-manifest,required-server-files,prefetch-hints}.json",
      "{*-manifest,required-server-files,prefetch-hints,preview-props}.json",
    );
    modified = true;
  }

  if (
    content.includes('p.endsWith("prefetch-hints")) {') &&
    !content.includes('p.endsWith("preview-props")')
  ) {
    content = content.replace(
      'p.endsWith("prefetch-hints")) {',
      'p.endsWith("prefetch-hints") ||\n        p.endsWith("preview-props")) {',
    );
    modified = true;
  }

  if (modified) {
    fs.writeFileSync(targetFile, content, "utf8");
    console.log(
      "[patch-opennext-cloudflare] Patched load-manifest.js for Next.js 16.4+ preview-props.json support.",
    );
  }
}
