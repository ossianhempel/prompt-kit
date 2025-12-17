import { promises as fs } from "node:fs";
import path from "node:path";
import ignore, { type Ignore } from "ignore";

import { normalizeRelativePath } from "./path.js";

export interface IgnoreOptions {
  additionalPatterns?: string[];
}

const DEFAULT_IGNORES = [
  ".git/",
  "node_modules/",
  "dist/",
  "target/",
  ".DS_Store",
  ".pnpm-store/",
];

export async function createIgnoreMatcher(
  root: string,
  options: IgnoreOptions = {},
): Promise<Ignore> {
  const ig = ignore();

  ig.add(DEFAULT_IGNORES);
  ig.add(options.additionalPatterns ?? []);

  const rootGitignorePath = path.join(root, ".gitignore");
  try {
    const contents = await fs.readFile(rootGitignorePath, "utf8");
    ig.add(contents.split(/\r?\n/));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }

  return ig;
}

export function isIgnored(
  ig: Ignore,
  relativePath: string,
  isDir = false,
): boolean {
  const normalized = normalizeRelativePath(relativePath);
  if (normalized.length === 0) {
    return false;
  }

  if (isDir) {
    return ig.ignores(`${normalized.replaceAll(/\/+$/g, "")}/`);
  }

  return ig.ignores(normalized);
}
