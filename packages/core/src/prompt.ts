import { buildCodemapFromText } from "./codemap.js";
import { getGitDiff } from "./git.js";
import { readTextFile, sliceTextByLines } from "./read.js";
import type { CodemapMode, GitDiffMode, SelectionEntry } from "./types.js";

function wrapCdata(text: string): string {
  return text.replaceAll("]]>", "]]]]><![CDATA[>");
}

export interface PromptBuildOptions {
  includeFileMap?: boolean;
  instructions?: string;
  maxFileBytes?: number;
  gitDiffMode?: GitDiffMode;
  maxGitDiffBytes?: number;
  codemapMode?: CodemapMode;
}

export interface PromptBuildResult {
  prompt: string;
  tokenEstimate: number;
}

export async function buildPrompt(
  root: string,
  selection: SelectionEntry[],
  options: PromptBuildOptions = {},
): Promise<PromptBuildResult> {
  const includeFileMap = options.includeFileMap ?? true;
  const maxFileBytes = options.maxFileBytes ?? 5_000_000;
  const gitDiffMode = options.gitDiffMode ?? "none";
  const maxGitDiffBytes = options.maxGitDiffBytes ?? 2_000_000;
  const codemapMode = options.codemapMode ?? "none";

  const textCache = new Map<string, string>();

  async function loadText(relativePath: string): Promise<string> {
    const cached = textCache.get(relativePath);
    if (cached !== undefined) {
      return cached;
    }
    const text = await readTextFile(root, relativePath, {
      maxBytes: maxFileBytes,
    });
    textCache.set(relativePath, text);
    return text;
  }

  const parts: string[] = [];

  if (options.instructions?.trim()) {
    parts.push(options.instructions.trim(), "");
  }

  if (includeFileMap) {
    parts.push("<file_map>");
    for (const entry of selection) {
      parts.push(entry.path);
    }
    parts.push("</file_map>", "");
  }

  const codemapEntries =
    codemapMode === "complete"
      ? selection.filter((e) => e.mode !== "codemap_only")
      : codemapMode === "auto"
        ? selection.filter((e) => e.mode === "slices")
        : [];

  if (codemapEntries.length > 0) {
    parts.push("<codemaps>");
    for (const entry of codemapEntries) {
      parts.push(`<codemap path="${entry.path}">`);
      try {
        const text = await loadText(entry.path);
        const codemap = await buildCodemapFromText(entry.path, text);
        parts.push("<![CDATA[");
        parts.push(wrapCdata(codemap.trimEnd()));
        parts.push("]]>");
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to build codemap";
        parts.push(`<![CDATA[Codemap error: ${message}]]>`);
      }
      parts.push("</codemap>");
    }
    parts.push("</codemaps>", "");
  }

  parts.push("<file_contents>");
  for (const entry of selection) {
    parts.push(`<file path="${entry.path}" mode="${entry.mode}">`);

    if (entry.mode === "codemap_only") {
      try {
        const text = await loadText(entry.path);
        const codemap = await buildCodemapFromText(entry.path, text);
        parts.push("<![CDATA[");
        parts.push(wrapCdata(codemap.trimEnd()));
        parts.push("]]>");
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to build codemap";
        parts.push(`<![CDATA[Codemap error: ${message}]]>`);
      }
      parts.push("</file>", "");
      continue;
    }

    let text = await loadText(entry.path);
    if (entry.mode === "slices") {
      text = sliceTextByLines(text, entry.slices ?? []);
    }

    parts.push("<![CDATA[");
    parts.push(wrapCdata(text));
    parts.push("]]>");
    parts.push("</file>", "");
  }
  parts.push("</file_contents>");

  if (gitDiffMode !== "none") {
    const { diff, truncated } = await getGitDiff(root, {
      mode: gitDiffMode,
      paths: selection.map((e) => e.path),
      maxBytes: maxGitDiffBytes,
    });

    if (diff.trim().length > 0) {
      parts.push("", "<git_diff>");
      parts.push("<![CDATA[");
      parts.push(wrapCdata(diff.trimEnd()));
      if (truncated) {
        parts.push("", "# (diff output truncated)");
      }
      parts.push("]]>");
      parts.push("</git_diff>");
    } else {
      parts.push("", "<git_diff>");
      parts.push("<![CDATA[(no git changes or not a git repo)]]>");
      parts.push("</git_diff>");
    }
  }

  const prompt = parts.join("\n").replaceAll(/\n+$/g, "\n");
  return { prompt, tokenEstimate: estimateTokens(prompt) };
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
