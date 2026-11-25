import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

if (process.env.VITEST && !process.env.TEST_DATABASE_URL) {
  console.warn("\nTEST_DATABASE_URL is not set: the tests that need PostgreSQL are skipped.\n");
}

export default defineConfig({
  root: "src/web",
  plugins: [
    react(),
    {
      // zod belongs to the server: values the browser needs live in src/shared/constants.ts, and the
      // web code takes only types from contracts.ts. Fails the build on any path that reaches zod.
      name: "no-zod-in-browser",
      apply: "build",
      enforce: "pre",
      resolveId(source, importer) {
        if (source === "zod" || source.startsWith("zod/")) {
          this.error(`zod must not reach the browser bundle (imported by ${importer}); import values from src/shared/constants.ts`);
        }
      },
    },
  ],
  build: { outDir: "../../dist/web", emptyOutDir: true },
  test: { root: ".", include: ["test/**/*.test.ts"], globalSetup: ["test/global-setup.ts"] },
});
