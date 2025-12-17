import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { FileInfo } from "../src/scan.js";
import { searchFiles } from "../src/search.js";

function mkTempDir(): string {
  const root = path.join(
    os.tmpdir(),
    `promptkit-search-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(root, { recursive: true });
  return root;
}

describe("searchFiles", () => {
  it("finds matches with line numbers and previews", async () => {
    const root = mkTempDir();
    try {
      writeFileSync(
        path.join(root, "a.txt"),
        "one\ntwo\nneedle here\n",
        "utf8",
      );
      writeFileSync(path.join(root, "b.txt"), "nothing\n", "utf8");
      writeFileSync(
        path.join(root, "bin.dat"),
        Buffer.from([0x00, 0x01, 0x02]),
      );

      const files: FileInfo[] = [
        { path: "a.txt", sizeBytes: 0, isBinary: false },
        { path: "b.txt", sizeBytes: 0, isBinary: false },
        { path: "bin.dat", sizeBytes: 0, isBinary: true },
      ];

      const matches = await searchFiles(root, files, "needle", { limit: 10 });
      expect(matches.length).toBe(1);
      expect(matches[0]?.path).toBe("a.txt");
      expect(matches[0]?.line).toBe(3);
      expect(matches[0]?.preview).toContain("needle");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("respects the limit", async () => {
    const root = mkTempDir();
    try {
      writeFileSync(
        path.join(root, "a.txt"),
        "needle\nneedle\nneedle\n",
        "utf8",
      );
      const files: FileInfo[] = [
        { path: "a.txt", sizeBytes: 0, isBinary: false },
      ];

      const matches = await searchFiles(root, files, "needle", { limit: 2 });
      expect(matches.length).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
