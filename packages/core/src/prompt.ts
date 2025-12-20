import { buildCodemapFromText } from "./codemap.js";
import { getGitDiff } from "./git.js";
import { readTextFile, sliceTextByLines } from "./read.js";
import type { CodemapMode, GitDiffMode, SelectionEntry } from "./types.js";

export type PromptRootResolver = {
  resolvePath: (path: string) => {
    root: string;
    relativePath: string;
    rootLabel?: string;
  };
  listRoots?: () => { root: string; rootLabel?: string }[];
};

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
  root: string | PromptRootResolver,
  selection: SelectionEntry[],
  options: PromptBuildOptions = {},
): Promise<PromptBuildResult> {
  const resolver: PromptRootResolver =
    typeof root === "string"
      ? {
          resolvePath: (path) => ({ root, relativePath: path }),
          listRoots: () => [{ root }],
        }
      : root;
  const includeFileMap = options.includeFileMap ?? true;
  const maxFileBytes = options.maxFileBytes ?? 5_000_000;
  const gitDiffMode = options.gitDiffMode ?? "none";
  const maxGitDiffBytes = options.maxGitDiffBytes ?? 2_000_000;
  const codemapMode = options.codemapMode ?? "none";

  const textCache = new Map<string, string>();

  async function loadText(relativePath: string): Promise<string> {
    const resolved = resolver.resolvePath(relativePath);
    const cacheKey = `${resolved.root}::${resolved.relativePath}`;
    const cachedResolved = textCache.get(cacheKey);
    if (cachedResolved !== undefined) {
      return cachedResolved;
    }
    const text = await readTextFile(resolved.root, resolved.relativePath, {
      maxBytes: maxFileBytes,
    });
    textCache.set(cacheKey, text);
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
    const rootsByPath = new Map<
      string,
      { rootLabel: string | undefined; paths: string[] }
    >();
    for (const entry of selection) {
      const resolved = resolver.resolvePath(entry.path);
      const existing = rootsByPath.get(resolved.root) ?? {
        rootLabel: resolved.rootLabel ?? undefined,
        paths: [] as string[],
      };
      existing.paths.push(resolved.relativePath);
      if (!existing.rootLabel && resolved.rootLabel) {
        existing.rootLabel = resolved.rootLabel;
      }
      rootsByPath.set(resolved.root, existing);
    }

    const listedRoots = resolver.listRoots?.();
    const rootsList =
      listedRoots && listedRoots.length > 0
        ? listedRoots
        : [...rootsByPath.entries()].map(([rootPath, info]) => ({
            root: rootPath,
            rootLabel: info.rootLabel,
          }));
    const multipleRoots = rootsList.length > 1;
    const perRootMax =
      multipleRoots && rootsList.length > 0
        ? Math.max(64_000, Math.floor(maxGitDiffBytes / rootsList.length))
        : maxGitDiffBytes;

    const diffParts: string[] = [];
    let anyDiff = false;
    let anyTruncated = false;

    for (const rootInfo of rootsList) {
      const selected = rootsByPath.get(rootInfo.root)?.paths ?? [];
      if (gitDiffMode === "selected" && selected.length === 0) {
        continue;
      }
      const { diff, truncated } = await getGitDiff(rootInfo.root, {
        mode: gitDiffMode,
        paths: selected,
        maxBytes: perRootMax,
      });
      if (!diff.trim()) {
        if (truncated) {
          anyTruncated = true;
        }
        continue;
      }
      anyDiff = true;
      if (multipleRoots) {
        diffParts.push(`# Root: ${rootInfo.rootLabel ?? rootInfo.root}`, "");
      }
      diffParts.push(diff.trimEnd(), "");
      if (truncated) {
        diffParts.push("# (diff output truncated)", "");
        anyTruncated = true;
      }
    }

    if (anyDiff) {
      const combined = diffParts.join("\n").replaceAll(/\n+$/g, "\n");
      parts.push("", "<git_diff>");
      parts.push("<![CDATA[");
      parts.push(wrapCdata(combined.trimEnd()));
      parts.push("]]>");
      parts.push("</git_diff>");
    } else {
      const note = anyTruncated ? " (output truncated)" : "";
      parts.push("", "<git_diff>");
      parts.push(`<![CDATA[(no git changes or not a git repo)${note}]]>`);
      parts.push("</git_diff>");
    }
  }

  const prompt = parts.join("\n").replaceAll(/\n+$/g, "\n");
  return { prompt, tokenEstimate: estimateTokens(prompt) };
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
