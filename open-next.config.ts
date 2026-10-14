import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import r2IncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache";

export default {
  ...defineCloudflareConfig({
    incrementalCache: r2IncrementalCache,
  }),
  appPath: "apps/web",
  buildOutputPath: "apps/web",
  packageJsonPath: "apps/web/package.json",
  buildCommand: "npm --workspace @mortem/web run build",
};
