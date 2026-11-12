import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
import type { NextConfig } from "next";
import {
  HTTPS_REDIRECT,
  buildSecurityHeaders,
} from "./src/lib/security-headers";

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
  // Security headers on every route (Mortem's own THE-183 checks flagged them).
  async headers() {
    return [
      {
        source: "/:path*",
        headers: buildSecurityHeaders(process.env.NODE_ENV === "development"),
      },
    ];
  },
  // Plain-HTTP requests go to HTTPS (Cloudflare sets X-Forwarded-Proto).
  async redirects() {
    return [HTTPS_REDIRECT];
  },
};

export default nextConfig;
