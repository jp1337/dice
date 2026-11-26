// The personal-data guard (docs-tech/personal-data.md) against a throwaway repository with a fictitious
// denylist. Each case is one that passed unnoticed before: a file name with an umlaut (git escaped it),
// a binary file, an added line starting with "++ ", an external diff tool, a denylist with CRLF line ends.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const script = path.resolve("scripts/scan-personal-data.sh");

function repo(denylist = "Mustermann\nMüller\n") {
  const dir = mkdtempSync(path.join(tmpdir(), "dice-scan-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
  git("init", "-q");
  git("config", "user.email", "x@users.noreply.github.com");
  git("config", "user.name", "x");
  writeFileSync(path.join(dir, "denylist"), denylist);
  writeFileSync(path.join(dir, "ok.txt"), "nothing here\n");
  git("add", "ok.txt");
  git("commit", "-qm", "init");
  const scan = (mode: "staged" | "repo", env: Record<string, string> = {}) =>
    spawnSync(script, [mode], { cwd: dir, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", PERSONAL_DENYLIST_FILE: path.join(dir, "denylist"), ...env } })
      .status;
  return { dir, git, scan };
}

describe("personal-data scan", () => {
  it("passes a clean repository", () => {
    const { scan } = repo();
    expect(scan("staged")).toBe(0);
    expect(scan("repo")).toBe(0);
  });

  const cases: [string, (dir: string) => [string, string | Buffer]][] = [
    ["a plain text line", () => ["a.txt", "hello Mustermann\n"]],
    ["a file name with an umlaut", () => ["Müller.txt", "nothing\n"]],
    ["a binary file", () => ["b.bin", Buffer.from("x\0y Mustermann z\n")]],
    ["an added line starting with ++", () => ["c.txt", "++ Mustermann\n"]],
    ["a name glued to an underscore", () => ["d.txt", "see max_mustermann_cv.pdf\n"]],
    ["a name glued to digits", () => ["e.txt", "login mustermann2024\n"]],
  ];
  it.each(cases)("catches %s when staged, and in the history after it is deleted", (_name, make) => {
    const { dir, git, scan } = repo();
    const [file, content] = make(dir);
    writeFileSync(path.join(dir, file), content);
    git("add", "--", file);
    expect(scan("staged")).toBe(1);
    git("commit", "-qm", "add", "--no-verify");
    git("rm", "-q", "--", file);
    git("commit", "-qm", "remove", "--no-verify");
    expect(scan("repo")).toBe(1);
  });

  it("is not fooled by an external diff tool", () => {
    const { dir, git, scan } = repo();
    writeFileSync(path.join(dir, "a.txt"), "hello Mustermann\n");
    git("add", "a.txt");
    expect(scan("staged", { GIT_EXTERNAL_DIFF: "true" })).toBe(1);
  });

  it("ignores case in umlauts under any locale", () => {
    const { dir, git, scan } = repo();
    writeFileSync(path.join(dir, "a.txt"), "MÜLLER\n");
    git("add", "a.txt");
    expect(scan("staged", { LC_ALL: "C" })).toBe(1);
  });

  it("reads an entry with spaces around it", () => {
    const { dir, git, scan } = repo("  Mustermann \n");
    writeFileSync(path.join(dir, "a.txt"), "hello Mustermann,\n");
    git("add", "a.txt");
    expect(scan("staged")).toBe(1);
  });

  it("does not hit a longer word that contains an entry", () => {
    const { dir, git, scan } = repo();
    writeFileSync(path.join(dir, "a.txt"), "Mustermannstraße ist ein Beispiel\n");
    git("add", "a.txt");
    expect(scan("staged")).toBe(0);
  });

  it("reads a denylist with CRLF line ends", () => {
    const { dir, git, scan } = repo("Mustermann\r\n");
    writeFileSync(path.join(dir, "a.txt"), "hello Mustermann\n");
    git("add", "a.txt");
    expect(scan("staged")).toBe(1);
  });
});
