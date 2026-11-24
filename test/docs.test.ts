// The two documentations and their boundary. docs/ is for whoever runs dice and is published: read
// on GitHub as the user documentation, and the only docs a stranger is pointed to. docs-tech/ is for
// whoever maintains the repository and is never published. That is held here structurally, not by an
// exclusion list someone has to remember.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

// Repository-relative paths of every file below dir.
function walk(dir: string): string[] {
  return readdirSync(path.join(root, dir)).flatMap((name) => {
    const rel = path.posix.join(dir, name);
    return statSync(path.join(root, rel)).isDirectory() ? walk(rel) : [rel];
  });
}

const docs = walk("docs");
const docsTech = walk("docs-tech");
const markdown = ["README.md", ...docs, ...docsTech].filter((file) => file.endsWith(".md"));

// .dockerignore pattern to a regex over repository-relative paths (Docker uses Go's filepath.Match plus **).
function dockerPattern(pattern: string) {
  const glob = pattern.replace(/^\//, "").replace(/\/$/, "");
  const source = glob
    .split(/(\*\*|\*|\?)/)
    .map((part) => (part === "**" ? ".*" : part === "*" ? "[^/]*" : part === "?" ? "[^/]" : part.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${source}$`);
}

// A pattern matches a path if it matches the path itself or one of its parent directories.
const matches = (pattern: RegExp, file: string) =>
  file.split("/").some((_, i, parts) => pattern.test(parts.slice(0, i + 1).join("/")));

describe("the technical docs are not published", () => {
  it("docs-tech/ exists outside docs/ and holds the specification", () => {
    expect(docsTech).toContain("docs-tech/spec.md");
    for (const name of ["docs-tech", "tech", "technical", "internal"]) {
      expect(existsSync(path.join(root, "docs", name)), `docs/${name} must not exist`).toBe(false);
    }
  });

  it("nothing under docs/ points into docs-tech/", () => {
    expect(docs.length).toBeGreaterThan(2);
    const hits = docs.filter((file) => read(file).includes("docs-tech"));
    expect(hits).toEqual([]);
  });

  it("the image build context is an allowlist that leaves docs-tech/ out", () => {
    const patterns = read(".dockerignore")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    // Everything excluded first, then single re-inclusions.
    expect(patterns[0]).toBe("*");
    const included = patterns.filter((p) => p.startsWith("!")).map((p) => dockerPattern(p.slice(1)));
    expect(included.length).toBeGreaterThan(0);
    expect(included.some((p) => matches(p, "src/server/main.ts")), "the check must see a re-included file").toBe(true);
    const leaked = docsTech.filter((file) => included.some((p) => matches(p, file)));
    expect(leaked).toEqual([]);
  });
});

describe("documentation links", () => {
  it("every relative link resolves to a file", () => {
    const broken: string[] = [];
    let seen = 0;
    for (const file of markdown) {
      const text = read(file);
      const targets = [...text.matchAll(/\]\(([^)\s]+)\)|(?:href|src)="([^"]+)"/g)].map((m) => m[1] ?? m[2]!);
      for (const target of targets) {
        if (/^(https?:|mailto:|#)/.test(target)) continue;
        seen++;
        const resolved = path.join(root, path.dirname(file), decodeURIComponent(target.split("#")[0]!));
        if (!existsSync(resolved)) broken.push(`${file} -> ${target}`);
      }
    }
    expect(seen).toBeGreaterThan(10);
    expect(broken).toEqual([]);
  });
});

describe("configuration", () => {
  it("every environment variable is documented in docs/configuration.md", () => {
    const names = new Set([
      ...[...read("src/server/config.ts").matchAll(/^\s+([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]!),
      ...[...read(".env.example").matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]!),
      ...[...read("docker-compose.yml").matchAll(/\$\{([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]!),
    ]);
    expect(names.size).toBeGreaterThan(15);
    const page = read("docs/configuration.md");
    const missing = [...names].filter((name) => !page.includes(`\`${name}\``));
    expect(missing).toEqual([]);
  });
});
