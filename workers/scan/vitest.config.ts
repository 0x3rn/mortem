import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

// Mirrors the wrangler.jsonc "Text" rule: axe-core's minified build is imported
// as a string, so tests inject exactly what production injects.
export default defineConfig({
  plugins: [
    {
      name: "axe-core-min-as-text",
      enforce: "pre",
      load(id) {
        if (id.replace(/\\/g, "/").endsWith("/axe-core/axe.min.js")) {
          return `export default ${JSON.stringify(readFileSync(id, "utf8"))};`;
        }
        return null;
      },
    },
  ],
  test: {
    server: {
      deps: {
        // Process axe-core through Vite so the plugin above applies.
        inline: ["axe-core"],
      },
    },
  },
});
