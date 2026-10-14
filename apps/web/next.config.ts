import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
import type { NextConfig } from "next";

const isNextDevOrStart = process.argv.some(
  (arg) => arg === "dev" || arg === "start",
);

if (isNextDevOrStart) {
  initOpenNextCloudflareForDev({
    persist: {
      path: "../../.wrangler/state/v3",
    },
  });
}

const nextConfig: NextConfig = {
  transpilePackages: ["@mortem/core"],
};

export default nextConfig;
