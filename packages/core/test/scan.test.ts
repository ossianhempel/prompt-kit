import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { scanWorkspace } from "../src/scan.js";

function mkTempDir(): string {
  const root = path.join(
    os.tmpdir(),
    `promptkit-scan-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(root, { recursive: true });
  return root;
}

describe("scanWorkspace", () => {
  it("respects default ignores and root .gitignore", async () => {
    const root = mkTempDir();
    try {
      writeFileSync(path.join(root, ".gitignore"), "ignored.txt\n", "utf8");

      writeFileSync(path.join(root, "keep.txt"), "hello", "utf8");
      writeFileSync(path.join(root, "ignored.txt"), "nope", "utf8");

      mkdirSync(path.join(root, "dist"), { recursive: true });
      writeFileSync(path.join(root, "dist", "bundle.js"), "x", "utf8");

      mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
      writeFileSync(
        path.join(root, "node_modules", "pkg", "index.js"),
        "x",
        "utf8",
      );

      const files = await scanWorkspace(root);
      const paths = files.map((f) => f.path);

      expect(paths).toContain("keep.txt");
      expect(paths).not.toContain("ignored.txt");
      expect(paths.some((p) => p.startsWith("dist/"))).toBe(false);
      expect(paths.some((p) => p.startsWith("node_modules/"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("detects binary files", async () => {
    const root = mkTempDir();
    try {
      writeFileSync(path.join(root, "text.txt"), "hello", "utf8");
      writeFileSync(
        path.join(root, "bin.dat"),
        Buffer.from([0x00, 0x01, 0x02]),
      );

      const files = await scanWorkspace(root, { maxFiles: 10 });
      const bin = files.find((f) => f.path === "bin.dat");
      const txt = files.find((f) => f.path === "text.txt");

      expect(bin?.isBinary).toBe(true);
      expect(txt?.isBinary).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
