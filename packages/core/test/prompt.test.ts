import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildPrompt } from "../src/prompt.js";

function mkTempDir(): string {
  const root = path.join(
    os.tmpdir(),
    `promptkit-prompt-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(root, { recursive: true });
  return root;
}

describe("buildPrompt", () => {
  it("builds a prompt with file map and contents", async () => {
    const root = mkTempDir();
    try {
      mkdirSync(path.join(root, "src"), { recursive: true });
      writeFileSync(
        path.join(root, "src", "main.ts"),
        "export function greet(name: string) { return `hi ${name}`; }\n",
        "utf8",
      );

      const result = await buildPrompt(
        root,
        [{ path: "src/main.ts", mode: "full" }],
        { includeFileMap: true },
      );

      expect(result.prompt).toContain("<file_map>");
      expect(result.prompt).toContain("src/main.ts");
      expect(result.prompt).toContain("<file_contents>");
      expect(result.prompt).toContain('file path="src/main.ts"');
      expect(result.tokenEstimate).toBeGreaterThan(10);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("renders slices with line numbers", async () => {
    const root = mkTempDir();
    try {
      writeFileSync(path.join(root, "a.txt"), "one\ntwo\nthree\n", "utf8");

      const result = await buildPrompt(
        root,
        [
          {
            path: "a.txt",
            mode: "slices",
            slices: [{ startLine: 2, endLine: 3, description: "snippet" }],
          },
        ],
        { includeFileMap: false },
      );

      expect(result.prompt).toContain("# Lines 2-3 (snippet)");
      expect(result.prompt).toContain("2| two");
      expect(result.prompt).toContain("3| three");
      expect(result.prompt).not.toContain("1| one");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("supports codemap-only mode", async () => {
    const root = mkTempDir();
    try {
      writeFileSync(
        path.join(root, "x.ts"),
        "export function add(a: number, b: number) { return a + b }\n",
        "utf8",
      );

      const result = await buildPrompt(
        root,
        [{ path: "x.ts", mode: "codemap_only" }],
        { includeFileMap: false },
      );

      expect(result.prompt).toContain('mode="codemap_only"');
      expect(result.prompt.toLowerCase()).toContain("export");
      expect(result.prompt.toLowerCase()).toContain("function");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("builds prompts across multiple roots with a resolver", async () => {
    const rootA = mkTempDir();
    const rootB = mkTempDir();
    try {
      writeFileSync(path.join(rootA, "a.txt"), "alpha\n", "utf8");
      writeFileSync(path.join(rootB, "b.txt"), "beta\n", "utf8");

      const resolver = {
        resolvePath: (p: string) => {
          if (p.startsWith("rootA/")) {
            return { root: rootA, relativePath: p.slice("rootA/".length) };
          }
          if (p.startsWith("rootB/")) {
            return { root: rootB, relativePath: p.slice("rootB/".length) };
          }
          return { root: rootA, relativePath: p };
        },
      };

      const result = await buildPrompt(
        resolver,
        [
          { path: "rootA/a.txt", mode: "full" },
          { path: "rootB/b.txt", mode: "full" },
        ],
        { includeFileMap: true },
      );

      expect(result.prompt).toContain("<file_map>");
      expect(result.prompt).toContain("rootA/a.txt");
      expect(result.prompt).toContain("rootB/b.txt");
      expect(result.prompt).toContain("alpha");
      expect(result.prompt).toContain("beta");
    } finally {
      rmSync(rootA, { recursive: true, force: true });
      rmSync(rootB, { recursive: true, force: true });
    }
  });
});
