import { promises as fs } from "node:fs";

import { assertPathWithinRoot } from "./path.js";
import type { Slice } from "./types.js";

export interface ReadFileOptions {
  maxBytes?: number;
}

export async function readTextFile(
  root: string,
  relativePath: string,
  options: ReadFileOptions = {},
): Promise<string> {
  const absPath = assertPathWithinRoot(root, relativePath);
  const maxBytes = options.maxBytes ?? 5_000_000;

  const stat = await fs.stat(absPath);
  if (stat.size > maxBytes) {
    throw new Error(`File too large (${stat.size} bytes): ${relativePath}`);
  }

  return await fs.readFile(absPath, "utf8");
}

export function sliceTextByLines(text: string, slices: Slice[]): string {
  const lines = text.split(/\r?\n/);

  const normalizedSlices = slices
    .map((s) => ({
      startLine: Math.max(1, Math.floor(s.startLine)),
      endLine: Math.max(1, Math.floor(s.endLine)),
      description: s.description,
    }))
    .map((s) => ({
      ...s,
      endLine: Math.max(s.startLine, s.endLine),
    }))
    .sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);

  const chunks: string[] = [];
  for (const s of normalizedSlices) {
    const startIdx = s.startLine - 1;
    const endIdx = s.endLine - 1;

    const header = s.description
      ? `# Lines ${s.startLine}-${s.endLine} (${s.description})`
      : `# Lines ${s.startLine}-${s.endLine}`;
    chunks.push(header);

    for (let i = startIdx; i <= endIdx && i < lines.length; i++) {
      const lineNo = i + 1;
      chunks.push(`${lineNo}| ${lines[i] ?? ""}`);
    }
    chunks.push("");
  }

  return chunks.join("\n").replaceAll(/\n+$/g, "\n");
}
