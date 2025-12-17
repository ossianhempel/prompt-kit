import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { URL } from "node:url";

import {
  type SelectionEntry,
  applyEditToText,
  assertPathWithinRoot,
  buildCodemapFromText,
  buildPrompt,
  getChangedFiles,
  isGitRepo,
  normalizeRelativePath,
  parseEditsXml,
  readTextFile,
  scanWorkspace,
  searchFiles,
  sliceTextByLines,
  toUnifiedDiff,
} from "@prompt-kit/core";
import {
  ApplyEditsParamsSchema,
  BuildPromptParamsSchema,
  DeletePresetParamsSchema,
  DiscoverParamsSchema,
  type FileInfo,
  GetCodeStructureParamsSchema,
  GetFileTreeParamsSchema,
  GetGitStatusParamsSchema,
  GetSelectionParamsSchema,
  type JsonRpcRequest,
  type JsonRpcResponse,
  ListPresetsParamsSchema,
  OpenWorkspaceParamsSchema,
  type Preset,
  PresetSchema,
  type PresetScope,
  type PresetUpsert,
  PreviewEditsParamsSchema,
  ProvidersRunParamsSchema,
  ReadFileParamsSchema,
  SearchParamsSchema,
  SelectionEntrySchema,
  type SetSelectionParams,
  SetSelectionParamsSchema,
  UndoEditsParamsSchema,
  UpsertPresetParamsSchema,
  WorkspaceContextParamsSchema,
} from "@prompt-kit/protocol";

type PresetsFileData = {
  version: 1;
  global: Preset[];
  workspaces: Record<string, Preset[]>;
};

type WorkspaceState = {
  id: string;
  root: string;
  rootKey: string;
  files: FileInfo[];
  selection: SelectionEntry[];
};

const workspaces = new Map<string, WorkspaceState>();

const CODEX_BIN =
  (process.env.PROMPTKIT_CODEX_BIN?.trim() || "codex").trim() || "codex";
const CLAUDE_BIN =
  (process.env.PROMPTKIT_CLAUDE_BIN?.trim() || "claude").trim() || "claude";

type RunProcessResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function extractJsonCandidate(text: string): string | null {
  const fencedJson = text.match(/```json\s*([\s\S]*?)```/i);
  if (fencedJson?.[1]) {
    return fencedJson[1].trim();
  }

  const fenced = text.match(/```\s*([\s\S]*?)```/);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const objStart = text.indexOf("{");
  const objEnd = text.lastIndexOf("}");
  if (objStart >= 0 && objEnd > objStart) {
    return text.slice(objStart, objEnd + 1).trim();
  }

  const arrStart = text.indexOf("[");
  const arrEnd = text.lastIndexOf("]");
  if (arrStart >= 0 && arrEnd > arrStart) {
    return text.slice(arrStart, arrEnd + 1).trim();
  }

  return null;
}

function clampInt(
  value: number,
  options: { min: number; max: number },
): number {
  if (!Number.isFinite(value)) {
    return options.min;
  }
  return Math.max(options.min, Math.min(options.max, Math.floor(value)));
}

function truncate(
  text: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  return {
    text: `${text.slice(0, Math.max(0, maxChars - 1))}…`,
    truncated: true,
  };
}

function formatLinesForTool(
  text: string,
  options: { maxLines: number; maxChars: number },
): { content: string; totalLines: number; truncated: boolean } {
  const lines = text.split(/\r?\n/);
  const totalLines = lines.length;

  const slice = lines.slice(0, options.maxLines);
  const numbered = slice
    .map((line, idx) => `${idx + 1}| ${line ?? ""}`)
    .join("\n");
  const { text: content, truncated: truncatedChars } = truncate(
    numbered,
    options.maxChars,
  );
  const truncatedLines = totalLines > slice.length;
  return { content, totalLines, truncated: truncatedLines || truncatedChars };
}

async function runProcess(
  cmd: string,
  args: string[],
  options: { cwd?: string; stdin?: string; maxBytes?: number } = {},
): Promise<RunProcessResult> {
  const maxBytes = options.maxBytes ?? 2_000_000;

  return await new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
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
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes = cap(chunk, stderrChunks, stderrBytes);
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

    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();
  });
}

function configDir(): string {
  const override = process.env.PROMPTKIT_CONFIG_DIR;
  if (override && override.trim().length > 0) {
    return override;
  }
  return path.join(os.homedir(), ".promptkit");
}

function presetsFilePath(): string {
  return path.join(configDir(), "presets.json");
}

function readJsonFile(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

function writeFileAtomic(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${randomUUID()}`;
  fs.writeFileSync(tmpPath, content, "utf8");
  fs.renameSync(tmpPath, filePath);
}

type CheckpointManifest = {
  version: 1;
  createdAt: string;
  workspaceRootKey: string;
  files: { path: string; existed: boolean }[];
};

function checkpointsBaseDir(): string {
  return path.join(configDir(), "checkpoints");
}

function workspaceCheckpointKey(rootKey: string): string {
  return createHash("sha1").update(rootKey).digest("hex");
}

function workspaceCheckpointsDir(rootKey: string): string {
  return path.join(checkpointsBaseDir(), workspaceCheckpointKey(rootKey));
}

function checkpointDir(rootKey: string, checkpointId: string): string {
  return path.join(workspaceCheckpointsDir(rootKey), checkpointId);
}

function readWorkspaceFileText(
  ws: WorkspaceState,
  relativePath: string,
): { existed: boolean; text: string } {
  const absPath = assertPathWithinRoot(ws.root, relativePath);
  try {
    return { existed: true, text: fs.readFileSync(absPath, "utf8") };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { existed: false, text: "" };
    }
    throw err;
  }
}

async function runCodexCli(
  prompt: string,
  options: { cwd?: string; model?: string } = {},
): Promise<{
  output: string;
  exitCode: number;
  stderr: string;
  truncated: boolean;
}> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "promptkit-codex-"));
  const outFile = path.join(tmpDir, "last_message.txt");

  try {
    const args = [
      "exec",
      "-",
      "--color",
      "never",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--output-last-message",
      outFile,
      ...(options.cwd ? ["--cd", options.cwd] : []),
      ...(options.model ? ["--model", options.model] : []),
    ];

    const res = await runProcess(CODEX_BIN, args, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      stdin: prompt,
      maxBytes: 2_000_000,
    });

    let output = "";
    try {
      output = fs.readFileSync(outFile, "utf8");
    } catch {
      output = res.stdout;
    }

    return {
      output,
      exitCode: res.exitCode,
      stderr: res.stderr,
      truncated: res.truncated,
    };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

async function runClaudeCodeCli(
  prompt: string,
  options: { cwd?: string; model?: string } = {},
): Promise<{
  output: string;
  exitCode: number;
  stderr: string;
  truncated: boolean;
}> {
  const args = [
    "-p",
    "--output-format",
    "text",
    "--tools",
    "",
    ...(options.model ? ["--model", options.model] : []),
  ];

  const res = await runProcess(CLAUDE_BIN, args, {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    stdin: prompt,
    maxBytes: 2_000_000,
  });

  return {
    output: res.stdout,
    exitCode: res.exitCode,
    stderr: res.stderr,
    truncated: res.truncated,
  };
}

type DiscoverToolName =
  | "get_file_tree"
  | "file_search"
  | "read_file"
  | "get_code_structure"
  | "token_estimate";

async function runDiscoveryAgent(
  ws: WorkspaceState,
  params: {
    task: string;
    provider: "codex_cli" | "claude_code_cli";
    model?: string;
    maxSteps: number;
    maxFiles: number;
    tokenBudget: number;
  },
): Promise<{
  selection: SelectionEntry[];
  prompt: string;
  tokenEstimate: number;
  log: string[];
}> {
  const log: string[] = [];

  const allPaths = ws.files
    .filter((f) => !f.isBinary)
    .map((f) => f.path)
    .sort();
  const fileMapLimit = 3500;
  const fileMapPaths = allPaths.slice(0, fileMapLimit);
  const fileMapTruncated = allPaths.length > fileMapPaths.length;

  const repo = await isGitRepo(ws.root);
  const changedFiles = repo
    ? await getChangedFiles(ws.root, { limit: 200 })
    : [];

  const rules = [
    "You are PromptKit Discovery. Your job is to select the minimum set of files needed to complete the task.",
    "",
    "You may call tools by outputting ONLY valid JSON with this schema:",
    `{"tool":"<name>","args":{...}}`,
    "",
    "Available tools:",
    '- {"tool":"get_file_tree"}',
    '- {"tool":"file_search","args":{"query":"string","limit":number}}',
    '- {"tool":"read_file","args":{"path":"relative/path","slices":[{"startLine":1,"endLine":2,"description":"optional"}]}}',
    '- {"tool":"get_code_structure","args":{"path":"relative/path"}}',
    '- {"tool":"token_estimate","args":{"selection":[{"path":"...","mode":"full|slices|codemap_only","slices":[...]}]}}',
    "",
    "When you are ready, output ONLY valid JSON with this schema:",
    `{"final":{"instructions":"string","selection":[{"path":"relative/path","mode":"full|slices|codemap_only","slices":[{"startLine":1,"endLine":2,"description":"optional"}]}]}}`,
    "",
    "Constraints:",
    `- Choose at most ${params.maxFiles} files.`,
    `- Keep the final prompt under ~${params.tokenBudget} tokens (token estimate is approximate).`,
    "- Only use paths that exist in the workspace file map.",
    '- Prefer mode "codemap_only" for large/secondary files; otherwise use "full".',
    "",
    "Task:",
    params.task.trim(),
    "",
    "Workspace file paths (relative):",
    "<file_map>",
    ...fileMapPaths,
    "</file_map>",
    ...(fileMapTruncated
      ? [
          `(file_map truncated to ${fileMapPaths.length} of ${allPaths.length} paths)`,
        ]
      : []),
    ...(repo && changedFiles.length
      ? [
          "",
          "Changed files (git diff HEAD):",
          "<changed_files>",
          ...changedFiles,
          "</changed_files>",
        ]
      : []),
  ].join("\n");

  const cwd = ws.root;
  let context = rules;
  let lastSelection: SelectionEntry[] | null = null;
  let lastInstructions: string | undefined;

  const fileSet = new Set(ws.files.map((f) => f.path));

  async function runProvider(prompt: string): Promise<string> {
    if (params.provider === "codex_cli") {
      const res = await runCodexCli(prompt, {
        ...(cwd ? { cwd } : {}),
        ...(params.model ? { model: params.model } : {}),
      });
      if (res.stderr.trim()) {
        log.push(`provider stderr: ${res.stderr.trim().slice(0, 300)}`);
      }
      if (res.exitCode !== 0) {
        log.push(`provider exit code: ${res.exitCode}`);
      }
      return res.output.trim();
    }

    const res = await runClaudeCodeCli(prompt, {
      ...(cwd ? { cwd } : {}),
      ...(params.model ? { model: params.model } : {}),
    });
    if (res.stderr.trim()) {
      log.push(`provider stderr: ${res.stderr.trim().slice(0, 300)}`);
    }
    if (res.exitCode !== 0) {
      log.push(`provider exit code: ${res.exitCode}`);
    }
    return res.output.trim();
  }

  async function runTool(
    tool: DiscoverToolName,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    switch (tool) {
      case "get_file_tree": {
        return {
          files: fileMapPaths,
          truncated: fileMapTruncated,
          total: allPaths.length,
        };
      }

      case "file_search": {
        const query = typeof args.query === "string" ? args.query : "";
        const limitRaw = typeof args.limit === "number" ? args.limit : 50;
        const limit = clampInt(limitRaw, { min: 1, max: 200 });
        const matches = await searchFiles(ws.root, ws.files, query, { limit });
        return { query, matches };
      }

      case "read_file": {
        const p = typeof args.path === "string" ? args.path : "";
        if (!p.trim()) {
          throw new Error("read_file requires a non-empty path");
        }
        if (!fileSet.has(p)) {
          throw new Error(`Path not found in workspace: ${p}`);
        }

        const text = await readTextFile(ws.root, p, { maxBytes: 500_000 });
        const slicesRaw = Array.isArray(args.slices) ? args.slices : undefined;
        const slices = slicesRaw
          ?.map((s) =>
            isRecord(s)
              ? {
                  startLine: Number(s.startLine),
                  endLine: Number(s.endLine),
                  ...(typeof s.description === "string"
                    ? { description: s.description }
                    : {}),
                }
              : null,
          )
          .filter(Boolean) as
          | { startLine: number; endLine: number; description?: string }[]
          | undefined;

        const sliced =
          slices && slices.length > 0 ? sliceTextByLines(text, slices) : text;

        return {
          path: p,
          ...formatLinesForTool(sliced, { maxLines: 220, maxChars: 80_000 }),
        };
      }

      case "get_code_structure": {
        const p = typeof args.path === "string" ? args.path : "";
        if (!p.trim()) {
          throw new Error("get_code_structure requires a non-empty path");
        }
        if (!fileSet.has(p)) {
          throw new Error(`Path not found in workspace: ${p}`);
        }
        const text = await readTextFile(ws.root, p, { maxBytes: 1_000_000 });
        const codemap = await buildCodemapFromText(p, text);
        const { text: content, truncated } = truncate(
          codemap.trimEnd(),
          80_000,
        );
        return { path: p, codemap: content, truncated };
      }

      case "token_estimate": {
        const rawSelection = Array.isArray(args.selection)
          ? args.selection
          : [];
        const parsed: SelectionEntry[] = [];
        for (const item of rawSelection) {
          const check = SelectionEntrySchema.safeParse(item);
          if (!check.success) {
            continue;
          }
          if (!fileSet.has(check.data.path)) {
            continue;
          }
          parsed.push(check.data as SelectionEntry);
        }
        const limited = parsed.slice(0, params.maxFiles);
        const result = await buildPrompt(ws.root, limited, {
          includeFileMap: true,
        });
        return {
          tokenEstimate: result.tokenEstimate,
          selectionCount: limited.length,
        };
      }
    }
  }

  for (let step = 0; step < params.maxSteps; step++) {
    log.push(`step ${step + 1}/${params.maxSteps}: waiting for model`);
    const output = await runProvider(
      `${context}\n\nReturn ONLY JSON for the next tool call or final result.`,
    );

    const candidate = extractJsonCandidate(output);
    if (!candidate) {
      log.push(`step ${step + 1}: model did not return JSON`);
      context += "\n\nYour last output was not JSON. Return ONLY valid JSON.";
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      log.push(`step ${step + 1}: invalid JSON`);
      context +=
        "\n\nYour last output was invalid JSON. Return ONLY valid JSON.";
      continue;
    }

    if (isRecord(parsed) && isRecord(parsed.final)) {
      const finalObj = parsed.final as Record<string, unknown>;
      const instructionsRaw = finalObj.instructions;
      const selectionRaw = finalObj.selection;
      const instructions =
        typeof instructionsRaw === "string" ? instructionsRaw.trim() : "";
      const rawArray = Array.isArray(selectionRaw) ? selectionRaw : null;
      if (!rawArray) {
        log.push(`step ${step + 1}: final.selection was not an array`);
        context +=
          "\n\nYour final.selection must be an array. Return ONLY valid JSON.";
        continue;
      }

      const parsedSelection: SelectionEntry[] = [];
      for (const item of rawArray) {
        const check = SelectionEntrySchema.safeParse(item);
        if (!check.success) {
          continue;
        }
        if (!fileSet.has(check.data.path)) {
          continue;
        }
        parsedSelection.push(check.data as SelectionEntry);
      }

      lastSelection = parsedSelection.slice(0, params.maxFiles);
      lastInstructions = instructions;
      log.push(
        `step ${step + 1}: got final selection (${lastSelection.length} files)`,
      );
      break;
    }

    if (isRecord(parsed) && typeof parsed.tool === "string") {
      const tool = parsed.tool.trim() as DiscoverToolName;
      const args = isRecord(parsed.args) ? parsed.args : {};
      if (
        tool !== "get_file_tree" &&
        tool !== "file_search" &&
        tool !== "read_file" &&
        tool !== "get_code_structure" &&
        tool !== "token_estimate"
      ) {
        log.push(`step ${step + 1}: unknown tool "${parsed.tool}"`);
        context +=
          "\n\nUnknown tool. Choose one of: get_file_tree, file_search, read_file, get_code_structure, token_estimate.";
        continue;
      }

      log.push(`step ${step + 1}: tool call ${tool}`);
      let toolResult: unknown;
      try {
        toolResult = await runTool(tool, args);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Tool error";
        toolResult = { error: message };
      }

      const toolJson = JSON.stringify(toolResult, null, 2);
      const limited = truncate(toolJson, 120_000);
      context += `\n\n---\nTool result (${tool}):\n${limited.text}\n---\n`;
      continue;
    }

    log.push(`step ${step + 1}: JSON was neither tool call nor final`);
    context +=
      '\n\nReturn either {"tool":...} or {"final":...}. Return ONLY JSON.';
  }

  if (!lastSelection) {
    throw new Error(
      "Discovery did not finish. Try increasing maxSteps or simplifying the task.",
    );
  }

  const isOverBudget = async (
    selection: SelectionEntry[],
    instructions?: string,
  ) => {
    const result = await buildPrompt(ws.root, selection, {
      includeFileMap: true,
      ...(instructions?.trim() ? { instructions: instructions.trim() } : {}),
    });
    return { ...result, over: result.tokenEstimate > params.tokenBudget };
  };

  let currentSelection = lastSelection;
  let currentInstructions = lastInstructions;

  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await isOverBudget(currentSelection, currentInstructions);
    if (!res.over) {
      ws.selection = currentSelection;
      return {
        selection: currentSelection,
        prompt: res.prompt,
        tokenEstimate: res.tokenEstimate,
        log,
      };
    }

    log.push(
      `token budget exceeded: ~${res.tokenEstimate} > ${params.tokenBudget}; asking model to reduce`,
    );
    const reducePrompt = [
      context,
      "",
      `Token estimate for your last selection is ~${res.tokenEstimate}. Budget is ~${params.tokenBudget}.`,
      "Reduce the selection to fit the budget. Prefer changing mode to codemap_only or using slices for huge files.",
      "Return ONLY final JSON again.",
    ].join("\n");

    const output = await runProvider(reducePrompt);
    const candidate = extractJsonCandidate(output);
    if (!candidate) {
      log.push("budget reduction: model did not return JSON");
      break;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      log.push("budget reduction: invalid JSON");
      break;
    }

    if (isRecord(parsed) && isRecord(parsed.final)) {
      const finalObj = parsed.final as Record<string, unknown>;
      const instructionsRaw = finalObj.instructions;
      const selectionRaw = finalObj.selection;
      const instructions =
        typeof instructionsRaw === "string" ? instructionsRaw.trim() : "";
      const rawArray = Array.isArray(selectionRaw) ? selectionRaw : null;
      if (!rawArray) {
        log.push("budget reduction: final.selection was not an array");
        break;
      }

      const parsedSelection: SelectionEntry[] = [];
      for (const item of rawArray) {
        const check = SelectionEntrySchema.safeParse(item);
        if (!check.success) {
          continue;
        }
        if (!fileSet.has(check.data.path)) {
          continue;
        }
        parsedSelection.push(check.data as SelectionEntry);
      }

      currentSelection = parsedSelection.slice(0, params.maxFiles);
      currentInstructions = instructions;
      log.push(
        `budget reduction: got revised selection (${currentSelection.length} files)`,
      );
      continue;
    }

    log.push("budget reduction: response missing final");
    break;
  }

  const finalRes = await buildPrompt(ws.root, currentSelection, {
    includeFileMap: true,
    ...(currentInstructions?.trim()
      ? { instructions: currentInstructions.trim() }
      : {}),
  });
  ws.selection = currentSelection;
  return {
    selection: currentSelection,
    prompt: finalRes.prompt,
    tokenEstimate: finalRes.tokenEstimate,
    log,
  };
}

function writeWorkspaceFileText(
  ws: WorkspaceState,
  relativePath: string,
  text: string,
): void {
  const absPath = assertPathWithinRoot(ws.root, relativePath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  const tmpPath = `${absPath}.tmp-${randomUUID()}`;
  fs.writeFileSync(tmpPath, text, "utf8");
  fs.renameSync(tmpPath, absPath);
}

function deleteWorkspaceFile(ws: WorkspaceState, relativePath: string): void {
  const absPath = assertPathWithinRoot(ws.root, relativePath);
  try {
    fs.unlinkSync(absPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw err;
    }
  }
}

function coercePresetArray(value: unknown): Preset[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const presets: Preset[] = [];
  for (const item of value) {
    const parsed = PresetSchema.safeParse(item);
    if (parsed.success) {
      presets.push(parsed.data);
    }
  }
  return presets;
}

function loadPresetsFromDisk(filePath: string): PresetsFileData {
  const raw = readJsonFile(filePath);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { version: 1, global: [], workspaces: {} };
  }

  const record = raw as Record<string, unknown>;
  const version = record.version;
  if (version !== 1) {
    return { version: 1, global: [], workspaces: {} };
  }

  const globalPresets = coercePresetArray(record.global);
  const workspaces: Record<string, Preset[]> = {};

  const workspacesRaw = record.workspaces;
  if (
    workspacesRaw &&
    typeof workspacesRaw === "object" &&
    !Array.isArray(workspacesRaw)
  ) {
    for (const [key, value] of Object.entries(
      workspacesRaw as Record<string, unknown>,
    )) {
      workspaces[key] = coercePresetArray(value);
    }
  }

  return { version: 1, global: globalPresets, workspaces };
}

function sortPresets(presets: Preset[]): Preset[] {
  return [...presets].sort((a, b) => a.name.localeCompare(b.name));
}

class PresetStore {
  private data: PresetsFileData;

  constructor(private readonly filePath: string) {
    this.data = loadPresetsFromDisk(filePath);
  }

  list(scope: PresetScope, workspaceRootKey?: string): Preset[] {
    if (scope === "global") {
      return sortPresets(this.data.global);
    }

    if (!workspaceRootKey) {
      return [];
    }

    return sortPresets(this.data.workspaces[workspaceRootKey] ?? []);
  }

  upsert(
    scope: PresetScope,
    workspaceRootKey: string | undefined,
    input: PresetUpsert,
  ): Preset {
    const now = new Date().toISOString();

    const list = this.ensureList(scope, workspaceRootKey);
    const idx = input.id ? list.findIndex((p) => p.id === input.id) : -1;
    const existing = idx >= 0 ? list[idx] : undefined;

    const id = existing?.id ?? input.id ?? randomUUID();
    const createdAt = existing?.createdAt ?? now;

    const preset: Preset = {
      id,
      name: input.name,
      createdAt,
      updatedAt: now,
      selection: input.selection,
      ...(existing?.description ? { description: existing.description } : {}),
      ...(existing?.instructions
        ? { instructions: existing.instructions }
        : {}),
      ...(existing?.includeFileMap === undefined
        ? {}
        : { includeFileMap: existing.includeFileMap }),
      ...(existing?.gitDiffMode === undefined
        ? {}
        : { gitDiffMode: existing.gitDiffMode }),
      ...(existing?.codemapMode === undefined
        ? {}
        : { codemapMode: existing.codemapMode }),
    };

    if (input.description !== undefined) {
      const trimmed = input.description.trim();
      if (trimmed.length > 0) {
        preset.description = trimmed;
      } else {
        preset.description = undefined;
      }
    }

    if (input.instructions !== undefined) {
      const trimmed = input.instructions.trim();
      if (trimmed.length > 0) {
        preset.instructions = trimmed;
      } else {
        preset.instructions = undefined;
      }
    }

    if (input.includeFileMap !== undefined) {
      preset.includeFileMap = input.includeFileMap;
    }

    if (input.gitDiffMode !== undefined) {
      preset.gitDiffMode = input.gitDiffMode;
    }

    if (input.codemapMode !== undefined) {
      preset.codemapMode = input.codemapMode;
    }

    if (idx >= 0) {
      list[idx] = preset;
    } else {
      list.push(preset);
    }

    this.save();
    return preset;
  }

  delete(
    scope: PresetScope,
    workspaceRootKey: string | undefined,
    presetId: string,
  ): boolean {
    const list = this.getList(scope, workspaceRootKey);
    if (!list) {
      return false;
    }

    const idx = list.findIndex((p) => p.id === presetId);
    if (idx < 0) {
      return false;
    }

    list.splice(idx, 1);
    this.save();
    return true;
  }

  private getList(
    scope: PresetScope,
    workspaceRootKey?: string,
  ): Preset[] | undefined {
    if (scope === "global") {
      return this.data.global;
    }

    if (!workspaceRootKey) {
      return undefined;
    }

    return this.data.workspaces[workspaceRootKey];
  }

  private ensureList(scope: PresetScope, workspaceRootKey?: string): Preset[] {
    if (scope === "global") {
      return this.data.global;
    }

    if (!workspaceRootKey) {
      throw new Error("workspaceRootKey is required for workspace presets");
    }

    this.data.workspaces[workspaceRootKey] ??= [];
    return this.data.workspaces[workspaceRootKey];
  }

  private save(): void {
    writeFileAtomic(this.filePath, `${JSON.stringify(this.data, null, 2)}\n`);
  }
}

const presetStore = new PresetStore(presetsFilePath());

function normalizeSelection(
  selection: SetSelectionParams["selection"],
): SelectionEntry[] {
  return selection.map((entry) => ({
    path: entry.path,
    mode: entry.mode,
    ...(entry.slices
      ? {
          slices: entry.slices.map(({ startLine, endLine, description }) =>
            description === undefined
              ? { startLine, endLine }
              : { startLine, endLine, description },
          ),
        }
      : {}),
  }));
}

function jsonRpcError(
  id: JsonRpcResponse["id"],
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
  };
}

function jsonRpcResult(
  id: JsonRpcResponse["id"],
  result: unknown,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

async function handleRpc(req: JsonRpcRequest): Promise<JsonRpcResponse> {
  const id = req.id ?? null;

  try {
    switch (req.method) {
      case "workspace.open": {
        const params = OpenWorkspaceParamsSchema.parse(req.params);
        const workspaceId = randomUUID();
        const files = await scanWorkspace(params.root);
        const rootKey = path.resolve(params.root);
        workspaces.set(workspaceId, {
          id: workspaceId,
          root: params.root,
          rootKey,
          files,
          selection: [],
        });
        return jsonRpcResult(id, { workspaceId });
      }

      case "workspace.getFileTree": {
        const params = GetFileTreeParamsSchema.parse(req.params);
        const ws = workspaces.get(params.workspaceId);
        if (!ws) {
          return jsonRpcError(id, -32004, "Unknown workspaceId");
        }
        return jsonRpcResult(id, { files: ws.files });
      }

      case "workspace.readFile": {
        const params = ReadFileParamsSchema.parse(req.params);
        const ws = workspaces.get(params.workspaceId);
        if (!ws) {
          return jsonRpcError(id, -32004, "Unknown workspaceId");
        }

        const text = await readTextFile(ws.root, params.path);
        const slices = params.slices?.map(
          ({ startLine, endLine, description }) =>
            description === undefined
              ? { startLine, endLine }
              : { startLine, endLine, description },
        );
        const content = slices?.length ? sliceTextByLines(text, slices) : text;
        return jsonRpcResult(id, { path: params.path, content });
      }

      case "workspace.search": {
        const params = SearchParamsSchema.parse(req.params);
        const ws = workspaces.get(params.workspaceId);
        if (!ws) {
          return jsonRpcError(id, -32004, "Unknown workspaceId");
        }
        const matches = await searchFiles(
          ws.root,
          ws.files,
          params.query,
          params.limit === undefined ? {} : { limit: params.limit },
        );
        return jsonRpcResult(id, { matches });
      }

      case "workspace.getCodeStructure": {
        const params = GetCodeStructureParamsSchema.parse(req.params);
        const ws = workspaces.get(params.workspaceId);
        if (!ws) {
          return jsonRpcError(id, -32004, "Unknown workspaceId");
        }

        const file = ws.files.find((f) => f.path === params.path);
        if (!file) {
          return jsonRpcError(id, -32004, `File not found: ${params.path}`);
        }
        if (file.isBinary) {
          return jsonRpcError(
            id,
            -32004,
            `Cannot build codemap for binary file: ${params.path}`,
          );
        }

        const text = await readTextFile(ws.root, params.path);
        const codemap = await buildCodemapFromText(params.path, text);
        return jsonRpcResult(id, { path: params.path, codemap });
      }

      case "workspace.setSelection": {
        const params = SetSelectionParamsSchema.parse(req.params);
        const ws = workspaces.get(params.workspaceId);
        if (!ws) {
          return jsonRpcError(id, -32004, "Unknown workspaceId");
        }
        ws.selection = normalizeSelection(params.selection);
        return jsonRpcResult(id, { ok: true });
      }

      case "workspace.getSelection": {
        const params = GetSelectionParamsSchema.parse(req.params);
        const ws = workspaces.get(params.workspaceId);
        if (!ws) {
          return jsonRpcError(id, -32004, "Unknown workspaceId");
        }
        return jsonRpcResult(id, { selection: ws.selection });
      }

      case "workspace.buildPrompt": {
        const params = BuildPromptParamsSchema.parse(req.params);
        const ws = workspaces.get(params.workspaceId);
        if (!ws) {
          return jsonRpcError(id, -32004, "Unknown workspaceId");
        }

        const selection = params.selection
          ? normalizeSelection(params.selection)
          : ws.selection;
        const options = {
          ...(params.includeFileMap === undefined
            ? {}
            : { includeFileMap: params.includeFileMap }),
          ...(params.instructions === undefined
            ? {}
            : { instructions: params.instructions }),
          ...(params.gitDiffMode === undefined
            ? {}
            : { gitDiffMode: params.gitDiffMode }),
          ...(params.codemapMode === undefined
            ? {}
            : { codemapMode: params.codemapMode }),
        };
        const result = await buildPrompt(ws.root, selection, options);
        return jsonRpcResult(id, result);
      }

      case "workspace.getContext": {
        const params = WorkspaceContextParamsSchema.parse(req.params);
        const ws = workspaces.get(params.workspaceId);
        if (!ws) {
          return jsonRpcError(id, -32004, "Unknown workspaceId");
        }
        return jsonRpcResult(id, {
          workspaceId: ws.id,
          root: ws.root,
          fileCount: ws.files.length,
          selection: ws.selection,
        });
      }

      case "workspace.getGitStatus": {
        const params = GetGitStatusParamsSchema.parse(req.params);
        const ws = workspaces.get(params.workspaceId);
        if (!ws) {
          return jsonRpcError(id, -32004, "Unknown workspaceId");
        }

        const isRepo = await isGitRepo(ws.root);
        const changedFiles = isRepo
          ? await getChangedFiles(ws.root, { limit: 200 })
          : [];
        return jsonRpcResult(id, { isRepo, changedFiles });
      }

      case "workspace.discover": {
        const params = DiscoverParamsSchema.parse(req.params);
        const ws = workspaces.get(params.workspaceId);
        if (!ws) {
          return jsonRpcError(id, -32004, "Unknown workspaceId");
        }

        const maxSteps = clampInt(params.maxSteps ?? 6, { min: 1, max: 20 });
        const maxFiles = clampInt(params.maxFiles ?? 25, { min: 1, max: 200 });
        const tokenBudget = clampInt(params.tokenBudget ?? 60_000, {
          min: 1_000,
          max: 500_000,
        });

        const result = await runDiscoveryAgent(ws, {
          task: params.task,
          provider: params.provider,
          ...(params.model ? { model: params.model } : {}),
          maxSteps,
          maxFiles,
          tokenBudget,
        });

        return jsonRpcResult(id, {
          selection: result.selection,
          tokenEstimate: result.tokenEstimate,
          handoff: result.prompt,
          log: result.log,
        });
      }

      case "workspace.previewEdits": {
        const params = PreviewEditsParamsSchema.parse(req.params);
        const ws = workspaces.get(params.workspaceId);
        if (!ws) {
          return jsonRpcError(id, -32004, "Unknown workspaceId");
        }

        const edits = await parseEditsXml(params.xml);
        const previews: { file: string; kind: string; unifiedDiff: string }[] =
          [];

        for (const edit of edits) {
          const { text: oldText } = readWorkspaceFileText(ws, edit.file);
          const newText = applyEditToText(edit, oldText);
          const unifiedDiff = await toUnifiedDiff(edit.file, oldText, newText);
          previews.push({ file: edit.file, kind: edit.kind, unifiedDiff });
        }

        return jsonRpcResult(id, { edits: previews });
      }

      case "workspace.applyEdits": {
        const params = ApplyEditsParamsSchema.parse(req.params);
        const ws = workspaces.get(params.workspaceId);
        if (!ws) {
          return jsonRpcError(id, -32004, "Unknown workspaceId");
        }

        const parsed = await parseEditsXml(params.xml);
        const requested = params.files?.length
          ? new Set(
              params.files
                .map((p) => normalizeRelativePath(p.trim()))
                .filter(Boolean),
            )
          : null;
        const edits = requested
          ? parsed.filter((e) => requested.has(e.file))
          : parsed;

        if (requested) {
          const missing = [...requested].filter(
            (p) => !parsed.some((e) => e.file === p),
          );
          if (missing.length > 0) {
            return jsonRpcError(
              id,
              -32602,
              `No edit found for: ${missing.join(", ")}`,
            );
          }
        }

        const plans = edits.map((edit) => {
          const { existed, text: oldText } = readWorkspaceFileText(
            ws,
            edit.file,
          );
          const newText = applyEditToText(edit, oldText);
          return { edit, existed, oldText, newText };
        });

        const checkpointId = `${new Date()
          .toISOString()
          .replaceAll(/[:.]/g, "-")}-${randomUUID()}`;
        const dir = checkpointDir(ws.rootKey, checkpointId);

        const manifest: CheckpointManifest = {
          version: 1,
          createdAt: new Date().toISOString(),
          workspaceRootKey: ws.rootKey,
          files: plans.map((p) => ({ path: p.edit.file, existed: p.existed })),
        };

        fs.mkdirSync(dir, { recursive: true });
        writeFileAtomic(
          path.join(dir, "manifest.json"),
          `${JSON.stringify(manifest, null, 2)}\n`,
        );

        for (const plan of plans) {
          if (plan.existed) {
            const backupPath = assertPathWithinRoot(dir, plan.edit.file);
            fs.mkdirSync(path.dirname(backupPath), { recursive: true });
            fs.writeFileSync(backupPath, plan.oldText, "utf8");
          }
        }

        for (const plan of plans) {
          writeWorkspaceFileText(ws, plan.edit.file, plan.newText);
        }

        return jsonRpcResult(id, {
          ok: true,
          applied: plans.map((p) => p.edit.file),
          checkpointId,
        });
      }

      case "workspace.undoEdits": {
        const params = UndoEditsParamsSchema.parse(req.params);
        const ws = workspaces.get(params.workspaceId);
        if (!ws) {
          return jsonRpcError(id, -32004, "Unknown workspaceId");
        }

        const baseDir = workspaceCheckpointsDir(ws.rootKey);
        let checkpointId = params.checkpointId;
        if (!checkpointId) {
          try {
            const entries = fs
              .readdirSync(baseDir, { withFileTypes: true })
              .filter((e) => e.isDirectory())
              .map((e) => e.name)
              .sort();
            checkpointId = entries.at(-1);
          } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code !== "ENOENT") {
              throw err;
            }
          }
        }

        if (!checkpointId) {
          return jsonRpcError(id, -32006, "No checkpoints found to undo");
        }

        const dir = checkpointDir(ws.rootKey, checkpointId);
        const manifestRaw = readJsonFile(path.join(dir, "manifest.json"));
        const manifest = manifestRaw as CheckpointManifest | null;
        if (
          !manifest ||
          manifest.version !== 1 ||
          !Array.isArray(manifest.files)
        ) {
          return jsonRpcError(id, -32006, "Invalid checkpoint manifest");
        }

        const restored: string[] = [];
        for (const file of manifest.files) {
          if (!file || typeof file.path !== "string") {
            continue;
          }
          const existed =
            typeof file.existed === "boolean" ? file.existed : false;
          if (existed) {
            const backupPath = assertPathWithinRoot(dir, file.path);
            const text = fs.readFileSync(backupPath, "utf8");
            writeWorkspaceFileText(ws, file.path, text);
          } else {
            deleteWorkspaceFile(ws, file.path);
          }
          restored.push(file.path);
        }

        return jsonRpcResult(id, { ok: true, restored, checkpointId });
      }

      case "providers.run": {
        const params = ProvidersRunParamsSchema.parse(req.params);
        const ws = params.workspaceId
          ? workspaces.get(params.workspaceId)
          : undefined;
        const cwd = ws?.root;

        try {
          if (params.provider === "codex_cli") {
            const res = await runCodexCli(params.prompt, {
              ...(cwd ? { cwd } : {}),
              ...(params.model ? { model: params.model } : {}),
            });
            return jsonRpcResult(id, {
              output: res.output,
              exitCode: res.exitCode,
              stderr: res.stderr.trim() ? res.stderr : undefined,
              truncated: res.truncated ? true : undefined,
            });
          }

          if (params.provider === "claude_code_cli") {
            const res = await runClaudeCodeCli(params.prompt, {
              ...(cwd ? { cwd } : {}),
              ...(params.model ? { model: params.model } : {}),
            });
            return jsonRpcResult(id, {
              output: res.output,
              exitCode: res.exitCode,
              stderr: res.stderr.trim() ? res.stderr : undefined,
              truncated: res.truncated ? true : undefined,
            });
          }

          return jsonRpcError(id, -32602, "Unknown provider");
        } catch (err) {
          const nodeErr = err as NodeJS.ErrnoException;
          if (nodeErr?.code === "ENOENT") {
            const cmd =
              params.provider === "codex_cli" ? CODEX_BIN : CLAUDE_BIN;
            const envVar =
              params.provider === "codex_cli"
                ? "PROMPTKIT_CODEX_BIN"
                : "PROMPTKIT_CLAUDE_BIN";
            return jsonRpcError(
              id,
              -32007,
              `Command not found: ${cmd}. Install it and make sure it's on PATH, or set ${envVar} to the full path of the binary. If you launched the app from Finder, try launching it from a terminal so it inherits your shell PATH.`,
            );
          }

          const message = err instanceof Error ? err.message : "Provider error";
          return jsonRpcError(id, -32007, message);
        }
      }

      case "presets.list": {
        const params = ListPresetsParamsSchema.parse(req.params);
        let rootKey: string | undefined;
        if (params.scope === "workspace") {
          if (!params.workspaceId) {
            return jsonRpcError(id, -32602, "workspaceId is required");
          }
          const ws = workspaces.get(params.workspaceId);
          if (!ws) {
            return jsonRpcError(id, -32004, "Unknown workspaceId");
          }
          rootKey = ws.rootKey;
        }

        return jsonRpcResult(id, {
          presets: presetStore.list(params.scope, rootKey),
        });
      }

      case "presets.upsert": {
        const params = UpsertPresetParamsSchema.parse(req.params);
        let rootKey: string | undefined;
        if (params.scope === "workspace") {
          if (!params.workspaceId) {
            return jsonRpcError(id, -32602, "workspaceId is required");
          }
          const ws = workspaces.get(params.workspaceId);
          if (!ws) {
            return jsonRpcError(id, -32004, "Unknown workspaceId");
          }
          rootKey = ws.rootKey;
        }

        const normalizedPreset: PresetUpsert = {
          ...params.preset,
          selection: normalizeSelection(params.preset.selection),
        };

        const preset = presetStore.upsert(
          params.scope,
          rootKey,
          normalizedPreset,
        );
        return jsonRpcResult(id, { preset });
      }

      case "presets.delete": {
        const params = DeletePresetParamsSchema.parse(req.params);
        let rootKey: string | undefined;
        if (params.scope === "workspace") {
          if (!params.workspaceId) {
            return jsonRpcError(id, -32602, "workspaceId is required");
          }
          const ws = workspaces.get(params.workspaceId);
          if (!ws) {
            return jsonRpcError(id, -32004, "Unknown workspaceId");
          }
          rootKey = ws.rootKey;
        }

        const ok = presetStore.delete(params.scope, rootKey, params.presetId);
        if (!ok) {
          return jsonRpcError(id, -32005, "Preset not found");
        }
        return jsonRpcResult(id, { ok: true });
      }
    }

    return jsonRpcError(id, -32601, `Method not found: ${req.method}`);
  } catch (err) {
    if (err instanceof Error) {
      return jsonRpcError(id, -32602, err.message);
    }
    return jsonRpcError(id, -32603, "Internal error");
  }
}

function parsePort(): number {
  const portArg = process.argv.find((a) => a.startsWith("--port="));
  const portEnv = process.env.PROMPTKIT_DAEMON_PORT;
  const raw = portArg?.slice("--port=".length) ?? portEnv ?? "31337";

  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid port: ${raw}`);
  }
  return port;
}

const port = parsePort();

const server = http.createServer(async (req, res) => {
  const requestHeadersRaw = req.headers["access-control-request-headers"];
  const requestHeaders = Array.isArray(requestHeadersRaw)
    ? requestHeadersRaw.join(", ")
    : requestHeadersRaw;

  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  res.setHeader(
    "access-control-allow-headers",
    requestHeaders?.trim() ? requestHeaders : "content-type",
  );

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(
    req.url ?? "/",
    `http://${req.headers.host ?? "127.0.0.1"}`,
  );

  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method !== "POST" || url.pathname !== "/rpc") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));

  req.on("end", async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify(jsonRpcError(null, -32700, "Parse error")));
      return;
    }

    const request = parsed as Partial<JsonRpcRequest>;
    if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          jsonRpcError(
            (request.id as JsonRpcResponse["id"]) ?? null,
            -32600,
            "Invalid Request",
          ),
        ),
      );
      return;
    }

    const response = await handleRpc(request as JsonRpcRequest);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(response));
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`prompt-kit daemon listening on http://127.0.0.1:${port}`);
});
