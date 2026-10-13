import { defineConfig, globalIgnores } from "eslint/config";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextTs,
  globalIgnores(["cloudflare-env.d.ts", ".wrangler/**"]),
]);
