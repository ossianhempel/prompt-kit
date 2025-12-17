import { promises as fs } from "node:fs";
import path from "node:path";

import { isBinaryBuffer } from "./binary.js";
import { createIgnoreMatcher, isIgnored } from "./ignore.js";
import { normalizeRelativePath, toPosixPath } from "./path.js";

export interface FileInfo {
  path: string;
  sizeBytes: number;
  isBinary: boolean;
}

export interface ScanWorkspaceOptions {
  additionalIgnorePatterns?: string[];
  maxFiles?: number;
  sampleBytesForBinaryDetection?: number;
}

async function detectBinary(
  filePath: string,
  sampleBytesForBinaryDetection: number,
): Promise<boolean> {
  const handle = await fs.open(filePath, "r");
  try {
    const { buffer, bytesRead } = await handle.read({
      buffer: Buffer.alloc(sampleBytesForBinaryDetection),
      position: 0,
      length: sampleBytesForBinaryDetection,
    });
    return isBinaryBuffer(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

export async function scanWorkspace(
  root: string,
  options: ScanWorkspaceOptions = {},
): Promise<FileInfo[]> {
  const ig = await createIgnoreMatcher(
    root,
    options.additionalIgnorePatterns
      ? { additionalPatterns: options.additionalIgnorePatterns }
      : {},
  );
  const maxFiles = options.maxFiles ?? 250_000;
  const sampleBytesForBinaryDetection =
    options.sampleBytesForBinaryDetection ?? 8000;

  const files: FileInfo[] = [];

  async function walk(absDir: string, relDir: string): Promise<void> {
    if (files.length >= maxFiles) {
      return;
    }

    const entries = await fs.readdir(absDir, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= maxFiles) {
        return;
      }

      const absPath = path.join(absDir, entry.name);
      const relPath = normalizeRelativePath(
        toPosixPath(path.posix.join(relDir, entry.name)),
      );

      if (entry.isDirectory()) {
        if (isIgnored(ig, relPath, true)) {
          continue;
        }
        await walk(absPath, relPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (isIgnored(ig, relPath, false)) {
        continue;
      }

      let stat: { size: number };
      try {
        stat = await fs.stat(absPath);
      } catch {
        continue;
      }

      let isBinary = false;
      try {
        isBinary = await detectBinary(absPath, sampleBytesForBinaryDetection);
      } catch {
        isBinary = true;
      }

      files.push({
        path: relPath,
        sizeBytes: stat.size,
        isBinary,
      });
    }
  }

  await walk(root, "");
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}
