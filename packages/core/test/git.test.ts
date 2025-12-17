import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { getChangedFiles, getGitDiff, isGitRepo } from "../src/git.js";

function mkTempDir(): string {
  const root = path.join(
    os.tmpdir(),
    `promptkit-git-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(root, { recursive: true });
  return root;
}

function git(root: string, args: string[]) {
  const res = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: "pipe",
  });
  if (res.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${res.stderr || res.stdout || res.status}`,
    );
  }
  return res.stdout;
}

describe("git helpers", () => {
  it("returns no diff info for non-git folders", async () => {
    const root = mkTempDir();
    try {
      expect(await isGitRepo(root)).toBe(false);
      expect(await getChangedFiles(root)).toEqual([]);
      expect(await getGitDiff(root, { mode: "all_changed" })).toEqual({
        diff: "",
        truncated: false,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("detects changed files and diffs in a git repo", async () => {
    const root = mkTempDir();
    try {
      git(root, ["init"]);
      git(root, ["config", "user.email", "test@example.com"]);
      git(root, ["config", "user.name", "Test"]);

      writeFileSync(path.join(root, "a.txt"), "one\n", "utf8");
      git(root, ["add", "a.txt"]);
      git(root, ["commit", "-m", "init"]);

      writeFileSync(path.join(root, "a.txt"), "one\ntwo\n", "utf8");

      const changed = await getChangedFiles(root, { limit: 10 });
      expect(changed).toContain("a.txt");

      const { diff } = await getGitDiff(root, { mode: "all_changed" });
      expect(diff).toContain("a.txt");
      expect(diff).toContain("+two");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
