import { spawn } from "node:child_process";

import type { GitDiffMode } from "./types.js";

type RunResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
};

function asTrimmedLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

async function runGit(
  root: string,
  args: string[],
  maxBytes = 2_000_000,
): Promise<RunResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", root, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;

    const cap = (chunk: Buffer, chunks: Buffer[], bytes: number) => {
      if (bytes >= maxBytes) {
        truncated = true;
        return bytes;
      }

      const remaining = maxBytes - bytes;
      const slice = chunk.subarray(0, remaining);
      chunks.push(slice);
      return bytes + slice.length;
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes = cap(chunk, stdoutChunks, stdoutBytes);
      if (stdoutBytes >= maxBytes && !truncated) {
        truncated = true;
      }
      if (stdoutBytes >= maxBytes) {
        child.kill();
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes = cap(chunk, stderrChunks, stderrBytes);
      if (stderrBytes >= maxBytes) {
        child.kill();
      }
    });

    child.on("error", (err) => {
      reject(err);
    });

    child.on("close", (code) => {
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        exitCode: code ?? 0,
        truncated,
      });
    });
  });
}

export async function isGitRepo(root: string): Promise<boolean> {
  try {
    const res = await runGit(
      root,
      ["rev-parse", "--is-inside-work-tree"],
      2048,
    );
    return res.exitCode === 0 && res.stdout.trim() === "true";
  } catch {
    return false;
  }
}

export async function getChangedFiles(
  root: string,
  options: { limit?: number } = {},
): Promise<string[]> {
  const limit = options.limit ?? 500;
  if (!(await isGitRepo(root))) {
    return [];
  }

  const head = await runGit(root, ["diff", "--name-only", "HEAD"], 500_000);
  let lines: string[] = [];
  if (head.exitCode === 0) {
    lines = asTrimmedLines(head.stdout);
  } else {
    const unstaged = await runGit(root, ["diff", "--name-only"], 500_000);
    const staged = await runGit(
      root,
      ["diff", "--name-only", "--cached"],
      500_000,
    );
    lines = [
      ...asTrimmedLines(unstaged.stdout),
      ...asTrimmedLines(staged.stdout),
    ];
  }

  return [...new Set(lines)].slice(0, limit);
}

export async function getGitDiff(
  root: string,
  options: {
    mode: GitDiffMode;
    paths?: string[];
    maxBytes?: number;
  },
): Promise<{ diff: string; truncated: boolean }> {
  const mode = options.mode;
  const maxBytes = options.maxBytes ?? 2_000_000;

  if (mode === "none") {
    return { diff: "", truncated: false };
  }

  if (!(await isGitRepo(root))) {
    return { diff: "", truncated: false };
  }

  const paths = options.paths ?? [];
  const pathArgs =
    mode === "selected" ? (paths.length ? ["--", ...paths] : []) : [];
  if (mode === "selected" && pathArgs.length === 0) {
    return { diff: "", truncated: false };
  }

  const headArgs = ["diff", "--no-color", "HEAD", ...pathArgs];
  const head = await runGit(root, headArgs, maxBytes);

  if (head.exitCode === 0) {
    return { diff: head.stdout, truncated: head.truncated };
  }

  const unstaged = await runGit(
    root,
    ["diff", "--no-color", ...pathArgs],
    Math.max(64_000, Math.floor(maxBytes / 2)),
  );
  const staged = await runGit(
    root,
    ["diff", "--no-color", "--cached", ...pathArgs],
    Math.max(64_000, Math.floor(maxBytes / 2)),
  );

  const parts: string[] = [];
  if (unstaged.stdout.trim()) {
    parts.push("# Unstaged", "", unstaged.stdout.trimEnd(), "");
  }
  if (staged.stdout.trim()) {
    parts.push("# Staged", "", staged.stdout.trimEnd(), "");
  }

  const combined = parts.join("\n").replaceAll(/\n+$/g, "\n");
  return { diff: combined, truncated: unstaged.truncated || staged.truncated };
}
