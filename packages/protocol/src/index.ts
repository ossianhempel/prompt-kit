import { z } from "zod";

export const SliceSchema = z
  .object({
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    description: z.string().optional(),
  })
  .refine((s) => s.endLine >= s.startLine, {
    message: "endLine must be >= startLine",
    path: ["endLine"],
  });

export type Slice = z.infer<typeof SliceSchema>;

export const SelectionModeSchema = z.enum(["full", "slices", "codemap_only"]);
export type SelectionMode = z.infer<typeof SelectionModeSchema>;

export const SelectionEntrySchema = z
  .object({
    path: z.string().min(1),
    mode: SelectionModeSchema.default("full"),
    slices: z.array(SliceSchema).optional(),
  })
  .refine(
    (entry) => entry.mode !== "slices" || (entry.slices?.length ?? 0) > 0,
    {
      message: "slices are required when mode is 'slices'",
      path: ["slices"],
    },
  );

export type SelectionEntry = z.infer<typeof SelectionEntrySchema>;

export const GitDiffModeSchema = z.enum(["none", "selected", "all_changed"]);
export type GitDiffMode = z.infer<typeof GitDiffModeSchema>;

export const CodemapModeSchema = z.enum(["none", "auto", "complete"]);
export type CodemapMode = z.infer<typeof CodemapModeSchema>;

export const FileInfoSchema = z.object({
  path: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  isBinary: z.boolean(),
});
export type FileInfo = z.infer<typeof FileInfoSchema>;

export const JsonRpcIdSchema = z.union([
  z.string(),
  z.number().int(),
  z.null(),
]);
export type JsonRpcId = z.infer<typeof JsonRpcIdSchema>;

export const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: JsonRpcIdSchema.optional(),
  method: z.string().min(1),
  params: z.unknown().optional(),
});
export type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>;

export const JsonRpcErrorObjectSchema = z.object({
  code: z.number().int(),
  message: z.string(),
  data: z.unknown().optional(),
});
export type JsonRpcErrorObject = z.infer<typeof JsonRpcErrorObjectSchema>;

export const JsonRpcResponseSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: JsonRpcIdSchema,
    result: z.unknown().optional(),
    error: JsonRpcErrorObjectSchema.optional(),
  })
  .refine((res) => (res.result === undefined) !== (res.error === undefined), {
    message: "response must have exactly one of result or error",
  });
export type JsonRpcResponse = z.infer<typeof JsonRpcResponseSchema>;

export const DaemonMethodSchema = z.enum([
  "workspace.open",
  "workspace.getFileTree",
  "workspace.readFile",
  "workspace.search",
  "workspace.getCodeStructure",
  "workspace.setSelection",
  "workspace.getSelection",
  "workspace.buildPrompt",
  "workspace.getContext",
  "workspace.getGitStatus",
  "workspace.discover",
  "workspace.discoverStart",
  "workspace.discoverStatus",
  "workspace.previewEdits",
  "workspace.applyEdits",
  "workspace.undoEdits",
  "providers.run",
  "presets.list",
  "presets.upsert",
  "presets.delete",
]);
export type DaemonMethod = z.infer<typeof DaemonMethodSchema>;

export const OpenWorkspaceParamsSchema = z
  .object({
    root: z.string().min(1).optional(),
    roots: z.array(z.string().min(1)).optional(),
  })
  .refine((params) => {
    if (typeof params.root === "string" && params.root.trim().length > 0) {
      return true;
    }
    return Array.isArray(params.roots) && params.roots.length > 0;
  }, "root or roots is required");
export type OpenWorkspaceParams = z.infer<typeof OpenWorkspaceParamsSchema>;

export const OpenWorkspaceResultSchema = z.object({
  workspaceId: z.string().min(1),
});
export type OpenWorkspaceResult = z.infer<typeof OpenWorkspaceResultSchema>;

export const GetFileTreeParamsSchema = z.object({
  workspaceId: z.string().min(1),
});
export type GetFileTreeParams = z.infer<typeof GetFileTreeParamsSchema>;

export const GetFileTreeResultSchema = z.object({
  files: z.array(FileInfoSchema),
});
export type GetFileTreeResult = z.infer<typeof GetFileTreeResultSchema>;

export const ReadFileParamsSchema = z.object({
  workspaceId: z.string().min(1),
  path: z.string().min(1),
  slices: z.array(SliceSchema).optional(),
});
export type ReadFileParams = z.infer<typeof ReadFileParamsSchema>;

export const ReadFileResultSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});
export type ReadFileResult = z.infer<typeof ReadFileResultSchema>;

export const SearchParamsSchema = z.object({
  workspaceId: z.string().min(1),
  query: z.string().min(1),
  limit: z.number().int().positive().optional(),
});
export type SearchParams = z.infer<typeof SearchParamsSchema>;

export const SearchMatchSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().positive(),
  preview: z.string(),
});
export type SearchMatch = z.infer<typeof SearchMatchSchema>;

export const SearchResultSchema = z.object({
  matches: z.array(SearchMatchSchema),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;

export const GetCodeStructureParamsSchema = z.object({
  workspaceId: z.string().min(1),
  path: z.string().min(1),
});
export type GetCodeStructureParams = z.infer<
  typeof GetCodeStructureParamsSchema
>;

export const GetCodeStructureResultSchema = z.object({
  path: z.string().min(1),
  codemap: z.string(),
});
export type GetCodeStructureResult = z.infer<
  typeof GetCodeStructureResultSchema
>;

export const SetSelectionParamsSchema = z.object({
  workspaceId: z.string().min(1),
  selection: z.array(SelectionEntrySchema),
});
export type SetSelectionParams = z.infer<typeof SetSelectionParamsSchema>;

export const SetSelectionResultSchema = z.object({
  ok: z.literal(true),
});
export type SetSelectionResult = z.infer<typeof SetSelectionResultSchema>;

export const GetSelectionParamsSchema = z.object({
  workspaceId: z.string().min(1),
});
export type GetSelectionParams = z.infer<typeof GetSelectionParamsSchema>;

export const GetSelectionResultSchema = z.object({
  selection: z.array(SelectionEntrySchema),
});
export type GetSelectionResult = z.infer<typeof GetSelectionResultSchema>;

export const BuildPromptParamsSchema = z.object({
  workspaceId: z.string().min(1),
  selection: z.array(SelectionEntrySchema).optional(),
  instructions: z.string().optional(),
  includeFileMap: z.boolean().optional(),
  gitDiffMode: GitDiffModeSchema.optional(),
  codemapMode: CodemapModeSchema.optional(),
});
export type BuildPromptParams = z.infer<typeof BuildPromptParamsSchema>;

export const BuildPromptResultSchema = z.object({
  prompt: z.string(),
  tokenEstimate: z.number().int().nonnegative(),
});
export type BuildPromptResult = z.infer<typeof BuildPromptResultSchema>;

export const WorkspaceContextParamsSchema = z.object({
  workspaceId: z.string().min(1),
});
export type WorkspaceContextParams = z.infer<
  typeof WorkspaceContextParamsSchema
>;

export const WorkspaceContextResultSchema = z.object({
  workspaceId: z.string().min(1),
  root: z.string().min(1),
  roots: z.array(z.string().min(1)).optional(),
  fileCount: z.number().int().nonnegative(),
  selection: z.array(SelectionEntrySchema),
});
export type WorkspaceContextResult = z.infer<
  typeof WorkspaceContextResultSchema
>;

export const PresetScopeSchema = z.enum(["global", "workspace"]);
export type PresetScope = z.infer<typeof PresetScopeSchema>;

export const PresetSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  instructions: z.string().optional(),
  includeFileMap: z.boolean().optional(),
  gitDiffMode: GitDiffModeSchema.optional(),
  codemapMode: CodemapModeSchema.optional(),
  selection: z.array(SelectionEntrySchema),
});
export type Preset = z.infer<typeof PresetSchema>;

export const PresetUpsertSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  instructions: z.string().optional(),
  includeFileMap: z.boolean().optional(),
  gitDiffMode: GitDiffModeSchema.optional(),
  codemapMode: CodemapModeSchema.optional(),
  selection: z.array(SelectionEntrySchema),
});
export type PresetUpsert = z.infer<typeof PresetUpsertSchema>;

export const ListPresetsParamsSchema = z
  .object({
    scope: PresetScopeSchema,
    workspaceId: z.string().min(1).optional(),
  })
  .refine((p) => p.scope !== "workspace" || p.workspaceId !== undefined, {
    message: "workspaceId is required when scope is 'workspace'",
    path: ["workspaceId"],
  });
export type ListPresetsParams = z.infer<typeof ListPresetsParamsSchema>;

export const ListPresetsResultSchema = z.object({
  presets: z.array(PresetSchema),
});
export type ListPresetsResult = z.infer<typeof ListPresetsResultSchema>;

export const UpsertPresetParamsSchema = z
  .object({
    scope: PresetScopeSchema,
    workspaceId: z.string().min(1).optional(),
    preset: PresetUpsertSchema,
  })
  .refine((p) => p.scope !== "workspace" || p.workspaceId !== undefined, {
    message: "workspaceId is required when scope is 'workspace'",
    path: ["workspaceId"],
  });
export type UpsertPresetParams = z.infer<typeof UpsertPresetParamsSchema>;

export const UpsertPresetResultSchema = z.object({
  preset: PresetSchema,
});
export type UpsertPresetResult = z.infer<typeof UpsertPresetResultSchema>;

export const DeletePresetParamsSchema = z
  .object({
    scope: PresetScopeSchema,
    workspaceId: z.string().min(1).optional(),
    presetId: z.string().min(1),
  })
  .refine((p) => p.scope !== "workspace" || p.workspaceId !== undefined, {
    message: "workspaceId is required when scope is 'workspace'",
    path: ["workspaceId"],
  });
export type DeletePresetParams = z.infer<typeof DeletePresetParamsSchema>;

export const DeletePresetResultSchema = z.object({
  ok: z.literal(true),
});
export type DeletePresetResult = z.infer<typeof DeletePresetResultSchema>;

export const GetGitStatusParamsSchema = z.object({
  workspaceId: z.string().min(1),
});
export type GetGitStatusParams = z.infer<typeof GetGitStatusParamsSchema>;

export const GetGitStatusResultSchema = z.object({
  isRepo: z.boolean(),
  changedFiles: z.array(z.string()),
});
export type GetGitStatusResult = z.infer<typeof GetGitStatusResultSchema>;

export const EditKindSchema = z.enum(["rewrite", "replace"]);
export type EditKind = z.infer<typeof EditKindSchema>;

export const PreviewEditsParamsSchema = z.object({
  workspaceId: z.string().min(1),
  xml: z.string().min(1),
});
export type PreviewEditsParams = z.infer<typeof PreviewEditsParamsSchema>;

export const PreviewEditSchema = z.object({
  file: z.string().min(1),
  kind: EditKindSchema,
  unifiedDiff: z.string(),
});
export type PreviewEdit = z.infer<typeof PreviewEditSchema>;

export const PreviewEditsResultSchema = z.object({
  edits: z.array(PreviewEditSchema),
});
export type PreviewEditsResult = z.infer<typeof PreviewEditsResultSchema>;

export const ApplyEditsParamsSchema = z.object({
  workspaceId: z.string().min(1),
  xml: z.string().min(1),
  files: z.array(z.string().min(1)).optional(),
});
export type ApplyEditsParams = z.infer<typeof ApplyEditsParamsSchema>;

export const ApplyEditsResultSchema = z.object({
  ok: z.literal(true),
  applied: z.array(z.string().min(1)),
  checkpointId: z.string().min(1),
});
export type ApplyEditsResult = z.infer<typeof ApplyEditsResultSchema>;

export const UndoEditsParamsSchema = z.object({
  workspaceId: z.string().min(1),
  checkpointId: z.string().min(1).optional(),
});
export type UndoEditsParams = z.infer<typeof UndoEditsParamsSchema>;

export const UndoEditsResultSchema = z.object({
  ok: z.literal(true),
  restored: z.array(z.string().min(1)),
  checkpointId: z.string().min(1),
});
export type UndoEditsResult = z.infer<typeof UndoEditsResultSchema>;

export const ProviderIdSchema = z.enum(["codex_cli", "claude_code_cli"]);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

export const DiscoverParamsSchema = z.object({
  workspaceId: z.string().min(1),
  task: z.string().min(1),
  provider: ProviderIdSchema,
  model: z.string().min(1).optional(),
  maxSteps: z.number().int().positive().optional(),
  maxFiles: z.number().int().positive().optional(),
  tokenBudget: z.number().int().positive().optional(),
});
export type DiscoverParams = z.infer<typeof DiscoverParamsSchema>;

export const DiscoverResultSchema = z.object({
  selection: z.array(SelectionEntrySchema),
  tokenEstimate: z.number().int().nonnegative(),
  handoff: z.string(),
  log: z.array(z.string()),
});
export type DiscoverResult = z.infer<typeof DiscoverResultSchema>;

export const DiscoverStartParamsSchema = DiscoverParamsSchema;
export type DiscoverStartParams = z.infer<typeof DiscoverStartParamsSchema>;

export const DiscoverStartResultSchema = z.object({
  runId: z.string().min(1),
  status: z.enum(["running"]),
  log: z.array(z.string()),
});
export type DiscoverStartResult = z.infer<typeof DiscoverStartResultSchema>;

export const DiscoverStatusParamsSchema = z.object({
  runId: z.string().min(1),
});
export type DiscoverStatusParams = z.infer<typeof DiscoverStatusParamsSchema>;

export const DiscoverStatusResultSchema = z.object({
  status: z.enum(["running", "complete", "error"]),
  log: z.array(z.string()),
  selection: z.array(SelectionEntrySchema).optional(),
  tokenEstimate: z.number().int().nonnegative().optional(),
  handoff: z.string().optional(),
  error: z.string().optional(),
});
export type DiscoverStatusResult = z.infer<typeof DiscoverStatusResultSchema>;

export const ProvidersRunParamsSchema = z.object({
  workspaceId: z.string().min(1).optional(),
  provider: ProviderIdSchema,
  prompt: z.string().min(1),
  model: z.string().min(1).optional(),
});
export type ProvidersRunParams = z.infer<typeof ProvidersRunParamsSchema>;

export const ProvidersRunResultSchema = z.object({
  output: z.string(),
  exitCode: z.number().int(),
  stderr: z.string().optional(),
  truncated: z.boolean().optional(),
});
export type ProvidersRunResult = z.infer<typeof ProvidersRunResultSchema>;
