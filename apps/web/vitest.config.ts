import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@mortem/core": resolve(__dirname, "../../packages/core/src/index.ts"),
      "@mortem/scan-worker": resolve(
        __dirname,
        "../../workers/scan/src/index.ts",
      ),
    },
  },
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: ["e2e/**", "node_modules/**", ".next/**"],
  },
});
