import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

if (process.env.VITEST && !process.env.TEST_DATABASE_URL) {
  console.warn("\nTEST_DATABASE_URL is not set: the tests that need PostgreSQL are skipped.\n");
}

export default defineConfig({
  root: "src/web",
  plugins: [react()],
  build: { outDir: "../../dist/web", emptyOutDir: true },
  test: { root: ".", include: ["test/**/*.test.ts"] },
});
