// The client build refuses zod (vite.config.ts): it holds for transitive imports too, which no scan of
// the web sources can promise. Values the browser needs live in src/shared/constants.ts.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { describe, expect, it } from "vitest";

const configFile = fileURLToPath(new URL("../vite.config.ts", import.meta.url));
const contracts = fileURLToPath(new URL("../src/shared/contracts.ts", import.meta.url));

function entry(code: string) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "dice-bundle-")), "entry.ts");
  writeFileSync(file, code);
  return file;
}
const bundle = (input: string) => build({ configFile, logLevel: "silent", build: { write: false, rollupOptions: { input } } });

describe("the browser bundle", () => {
  it("fails to build when anything pulls in zod, even through contracts.ts", async () => {
    await expect(bundle(entry(`import { clientMessageSchema } from ${JSON.stringify(contracts)};\nconsole.log(clientMessageSchema);`))).rejects.toThrow(
      /zod must not reach the browser bundle/,
    );
  });

  it("builds from contracts.ts types alone", async () => {
    await expect(bundle(entry(`import type { MeResponse } from ${JSON.stringify(contracts)};\nconst me: MeResponse | null = null;\nconsole.log(me);`))).resolves.toBeDefined();
  });
});
