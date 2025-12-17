import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertPathWithinRoot,
  normalizeRelativePath,
  toPosixPath,
} from "../src/path.js";

describe("path helpers", () => {
  it("toPosixPath converts Windows separators to POSIX", () => {
    expect(toPosixPath("a\\b\\c")).toBe("a/b/c");
  });

  it("normalizeRelativePath strips leading ./ and collapses slashes", () => {
    expect(normalizeRelativePath("./a//b///c")).toBe("a/b/c");
    expect(normalizeRelativePath("/a/b")).toBe("a/b");
  });

  it("assertPathWithinRoot blocks path traversal", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "promptkit-path-"));
    try {
      expect(() => assertPathWithinRoot(root, "../secret.txt")).toThrow(
        /escapes root/i,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("assertPathWithinRoot resolves safe paths", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "promptkit-path-"));
    try {
      const resolved = assertPathWithinRoot(root, "src/index.ts");
      expect(resolved.startsWith(path.resolve(root))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
