import { readTextFile } from "./read.js";
import type { FileInfo } from "./scan.js";

export interface SearchMatch {
  path: string;
  line: number;
  preview: string;
}

export interface SearchOptions {
  limit?: number;
  maxFileBytes?: number;
}

export async function searchFiles(
  root: string,
  files: FileInfo[],
  query: string,
  options: SearchOptions = {},
): Promise<SearchMatch[]> {
  const trimmed = query.trim();
  if (!trimmed) {
    return [];
  }

  const limit = options.limit ?? 200;
  const maxFileBytes = options.maxFileBytes ?? 1_000_000;
  const matches: SearchMatch[] = [];

  for (const file of files) {
    if (matches.length >= limit) {
      break;
    }
    if (file.isBinary) {
      continue;
    }
    if (file.sizeBytes > maxFileBytes) {
      continue;
    }

    let text: string;
    try {
      text = await readTextFile(root, file.path, { maxBytes: maxFileBytes });
    } catch {
      continue;
    }

    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= limit) {
        break;
      }
      const lineText = lines[i] ?? "";
      if (lineText.includes(trimmed)) {
        matches.push({
          path: file.path,
          line: i + 1,
          preview: lineText.slice(0, 300),
        });
      }
    }
  }

  return matches;
}
