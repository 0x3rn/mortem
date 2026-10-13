import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
import type { NextConfig } from "next";

if (process.env.NODE_ENV === "development") {
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
