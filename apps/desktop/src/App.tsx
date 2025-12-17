import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useMemo, useState } from "react";
import "./App.css";

type DaemonInfo = {
  port: number;
  rpcUrl: string;
  healthUrl: string;
};

type Slice = {
  startLine: number;
  endLine: number;
  description?: string;
};

type SelectionMode = "full" | "slices" | "codemap_only";

type SelectionEntry = {
  path: string;
  mode: SelectionMode;
  slices?: Slice[];
};

type GitDiffMode = "none" | "selected" | "all_changed";

type CodemapMode = "none" | "auto" | "complete";

type EditKind = "rewrite" | "replace";

type PreviewEdit = {
  file: string;
  kind: EditKind;
  unifiedDiff: string;
};

type ProviderId = "codex_cli" | "claude_code_cli";

type PresetScope = "workspace" | "global";

type Preset = {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  instructions?: string;
  includeFileMap?: boolean;
  gitDiffMode?: GitDiffMode;
  codemapMode?: CodemapMode;
  selection: SelectionEntry[];
};

type FileInfo = {
  path: string;
  sizeBytes: number;
  isBinary: boolean;
};

type SearchMatch = {
  path: string;
  line: number;
  preview: string;
};

const DEFAULT_DAEMON_RPC_URL = "http://127.0.0.1:31337/rpc";
const DEFAULT_PREVIEW_LINES = 200;
const PREVIEW_LINES_STEP = 200;
const DISCOVER_FILE_MAP_LIMIT = 3500;

type JsonRpcResponse<T> = {
  jsonrpc: "2.0";
  id: string;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
};

async function rpc<T>(
  rpcUrl: string,
  method: string,
  params: unknown,
): Promise<T> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method,
      params,
    }),
  });

  if (!res.ok) {
    throw new Error(`Daemon HTTP ${res.status}`);
  }

  const data = (await res.json()) as JsonRpcResponse<T>;
  if (data.error) {
    throw new Error(data.error.message);
  }
  if (data.result === undefined) {
    throw new Error("Daemon returned no result");
  }
  return data.result;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function clampInt(
  value: string,
  fallback: number,
  options: { min?: number; max?: number } = {},
): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  const min = options.min ?? Number.NEGATIVE_INFINITY;
  const max = options.max ?? Number.POSITIVE_INFINITY;
  return Math.max(min, Math.min(max, parsed));
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

function normalizeSuggestedPath(input: string): string {
  let path = input.trim().replace(/\\/g, "/");
  path = path.replace(/^\.?\//, "");
  while (path.startsWith("/")) {
    path = path.slice(1);
  }
  return path;
}

function normalizeSuggestedMode(input: unknown): SelectionMode {
  if (typeof input !== "string") {
    return "full";
  }
  const mode = input.trim().toLowerCase();
  if (mode === "codemap_only" || mode === "codemap-only") {
    return "codemap_only";
  }
  if (mode === "api_only" || mode === "api-only" || mode === "api") {
    return "codemap_only";
  }
  if (mode === "full") {
    return "full";
  }
  return "full";
}

function parseDiscoverSelection(raw: string): SelectionEntry[] {
  const candidate = extractJsonCandidate(raw);
  if (!candidate) {
    throw new Error("Provider did not return JSON.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    throw new Error("Provider returned invalid JSON.");
  }

  let items: unknown[] | null = null;
  if (Array.isArray(parsed)) {
    items = parsed;
  } else if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const selection = (parsed as Record<string, unknown>).selection;
    if (Array.isArray(selection)) {
      items = selection;
    }
  }

  if (!items) {
    throw new Error(
      "Provider JSON must be an array or an object with a `selection` array.",
    );
  }

  const byPath = new Map<string, SelectionEntry>();
  for (const item of items) {
    if (typeof item === "string") {
      const path = normalizeSuggestedPath(item);
      if (path) {
        byPath.set(path, { path, mode: "full" });
      }
      continue;
    }

    if (!item || typeof item !== "object") {
      continue;
    }

    const record = item as Record<string, unknown>;
    const rawPath = record.path;
    if (typeof rawPath !== "string") {
      continue;
    }

    const path = normalizeSuggestedPath(rawPath);
    if (!path) {
      continue;
    }

    const mode = normalizeSuggestedMode(record.mode);
    byPath.set(path, { path, mode });
  }

  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function App() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [activeTab, setActiveTab] = useState<"compose" | "discover" | "apply">(
    "compose",
  );

  const [daemonRpcUrl, setDaemonRpcUrl] = useState(DEFAULT_DAEMON_RPC_URL);
  const [daemonHealth, setDaemonHealth] = useState<"unknown" | "ok" | "down">(
    "unknown",
  );

  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [filter, setFilter] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchMatch[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [selection, setSelection] = useState<Record<string, SelectionEntry>>(
    {},
  );
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [activeFileContent, setActiveFileContent] = useState<string>("");
  const [activeFileError, setActiveFileError] = useState<string | null>(null);
  const [activeFileLoading, setActiveFileLoading] = useState(false);
  const [previewLineLimit, setPreviewLineLimit] = useState(
    DEFAULT_PREVIEW_LINES,
  );
  const [pendingSliceStart, setPendingSliceStart] = useState<number | null>(
    null,
  );
  const [sliceStartInput, setSliceStartInput] = useState("");
  const [sliceEndInput, setSliceEndInput] = useState("");
  const [sliceDescriptionInput, setSliceDescriptionInput] = useState("");

  const [instructions, setInstructions] = useState("");
  const [includeFileMap, setIncludeFileMap] = useState(true);
  const [gitDiffMode, setGitDiffMode] = useState<GitDiffMode>("none");
  const [codemapMode, setCodemapMode] = useState<CodemapMode>("none");
  const [tokenEstimate, setTokenEstimate] = useState<number | null>(null);
  const [prompt, setPrompt] = useState("");
  const [provider, setProvider] = useState<ProviderId>("claude_code_cli");
  const [providerModel, setProviderModel] = useState("");
  const [providerOutput, setProviderOutput] = useState("");

  const [discoverTask, setDiscoverTask] = useState("");
  const [discoverMaxFiles, setDiscoverMaxFiles] = useState("25");
  const [discoverMaxSteps, setDiscoverMaxSteps] = useState("8");
  const [discoverTokenBudget, setDiscoverTokenBudget] = useState("60000");
  const [discoverSuggestions, setDiscoverSuggestions] = useState<
    SelectionEntry[]
  >([]);
  const [discoverSelection, setDiscoverSelection] = useState<
    Record<string, boolean>
  >({});
  const [discoverHandoff, setDiscoverHandoff] = useState("");
  const [discoverRawOutput, setDiscoverRawOutput] = useState("");
  const [discoverWarning, setDiscoverWarning] = useState<string | null>(null);

  const [editsXml, setEditsXml] = useState("");
  const [editPreviews, setEditPreviews] = useState<PreviewEdit[]>([]);
  const [activeEditFile, setActiveEditFile] = useState("");
  const [editSelection, setEditSelection] = useState<Record<string, boolean>>(
    {},
  );
  const [lastCheckpointId, setLastCheckpointId] = useState<string | null>(null);

  const [presetScope, setPresetScope] = useState<PresetScope>("workspace");
  const [presets, setPresets] = useState<Preset[]>([]);
  const [activePresetId, setActivePresetId] = useState<string>("");

  const [gitStatus, setGitStatus] = useState<{
    isRepo: boolean;
    changedFiles: string[];
  }>({ isRepo: false, changedFiles: [] });
  const [gitStatusLoading, setGitStatusLoading] = useState(false);

  const filteredFiles = useMemo(() => {
    const q = filter.trim();
    if (!q) return files;
    return files.filter((f) => f.path.toLowerCase().includes(q.toLowerCase()));
  }, [files, filter]);

  const selectedCount = useMemo(
    () => Object.keys(selection).length,
    [selection],
  );

  const selectedEntries = useMemo(
    () => Object.values(selection).sort((a, b) => a.path.localeCompare(b.path)),
    [selection],
  );

  const sliceIssues = useMemo(
    () =>
      selectedEntries.filter(
        (entry) => entry.mode === "slices" && (entry.slices?.length ?? 0) === 0,
      ),
    [selectedEntries],
  );

  const activePreset = useMemo(
    () => presets.find((p) => p.id === activePresetId) ?? null,
    [presets, activePresetId],
  );

  const selectedEditCount = useMemo(
    () => Object.values(editSelection).filter(Boolean).length,
    [editSelection],
  );

  const discoverSelectedCount = useMemo(
    () => Object.values(discoverSelection).filter(Boolean).length,
    [discoverSelection],
  );

  const activeEditPreview = useMemo(() => {
    if (!activeEditFile) {
      return editPreviews[0] ?? null;
    }
    return editPreviews.find((e) => e.file === activeEditFile) ?? null;
  }, [editPreviews, activeEditFile]);

  const checkDaemonHealth = useCallback(async (url: string) => {
    const healthUrl = url.replace(/\/rpc\/?$/, "/health");
    try {
      const res = await fetch(healthUrl, { method: "GET" });
      setDaemonHealth(res.ok ? "ok" : "down");
      return res.ok;
    } catch {
      setDaemonHealth("down");
      return false;
    }
  }, []);

  useEffect(() => {
    void checkDaemonHealth(daemonRpcUrl);
  }, [daemonRpcUrl, checkDaemonHealth]);

  const loadActiveFile = useCallback(async () => {
    if (!workspaceId || !activeFilePath) {
      setActiveFileContent("");
      setActiveFileError(null);
      setActiveFileLoading(false);
      return;
    }

    setActiveFileLoading(true);
    setActiveFileError(null);

    try {
      const result = await rpc<{ path: string; content: string }>(
        daemonRpcUrl,
        "workspace.readFile",
        { workspaceId, path: activeFilePath },
      );
      setActiveFileContent(result.content);
      setPreviewLineLimit(DEFAULT_PREVIEW_LINES);
      setPendingSliceStart(null);
      setSliceStartInput("");
      setSliceEndInput("");
      setSliceDescriptionInput("");
    } catch (e) {
      setActiveFileContent("");
      setActiveFileError(
        e instanceof Error ? e.message : "Failed to read file",
      );
    } finally {
      setActiveFileLoading(false);
    }
  }, [daemonRpcUrl, workspaceId, activeFilePath]);

  useEffect(() => {
    void loadActiveFile();
  }, [loadActiveFile]);

  const loadGitStatus = useCallback(async () => {
    if (!workspaceId) {
      setGitStatus({ isRepo: false, changedFiles: [] });
      return;
    }

    setGitStatusLoading(true);
    try {
      const result = await rpc<{ isRepo: boolean; changedFiles: string[] }>(
        daemonRpcUrl,
        "workspace.getGitStatus",
        { workspaceId },
      );
      setGitStatus(result);
    } catch {
      setGitStatus({ isRepo: false, changedFiles: [] });
    } finally {
      setGitStatusLoading(false);
    }
  }, [daemonRpcUrl, workspaceId]);

  useEffect(() => {
    void loadGitStatus();
  }, [loadGitStatus]);

  const loadPresets = useCallback(async () => {
    if (presetScope === "workspace" && !workspaceId) {
      setPresets([]);
      return;
    }

    try {
      const result = await rpc<{ presets: Preset[] }>(
        daemonRpcUrl,
        "presets.list",
        {
          scope: presetScope,
          ...(presetScope === "workspace" ? { workspaceId } : {}),
        },
      );
      setPresets(result.presets);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load presets");
    }
  }, [daemonRpcUrl, presetScope, workspaceId]);

  useEffect(() => {
    void loadPresets();
  }, [loadPresets]);

  const startDaemon = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const info = (await invoke("start_daemon", {
        port: 31337,
      })) as DaemonInfo;
      setDaemonRpcUrl(info.rpcUrl);
      let ok = false;
      for (let i = 0; i < 20; i++) {
        ok = await checkDaemonHealth(info.rpcUrl);
        if (ok) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      if (!ok) {
        const status = (await invoke("daemon_status")) as DaemonInfo | null;
        if (!status) {
          setError(
            "Daemon failed to start. If you're running from a repo checkout, run `pnpm build` once and try again.",
          );
        } else {
          setError(
            `Daemon started but is not reachable on ${status.rpcUrl}. Check if port ${status.port} is already in use.`,
          );
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start daemon");
    } finally {
      setBusy(false);
    }
  }, [checkDaemonHealth]);

  useEffect(() => {
    let cancelled = false;
    async function initDaemon() {
      try {
        const status = (await invoke("daemon_status")) as DaemonInfo | null;
        if (cancelled) return;
        if (status) {
          setDaemonRpcUrl(status.rpcUrl);
          await checkDaemonHealth(status.rpcUrl);
          return;
        }
        const ok = await checkDaemonHealth(daemonRpcUrl);
        if (cancelled) return;
        if (ok) {
          return;
        }
        await startDaemon();
      } catch {
        // Best-effort: user can still click Start daemon.
      }
    }
    void initDaemon();
    return () => {
      cancelled = true;
    };
  }, [checkDaemonHealth, daemonRpcUrl, startDaemon]);

  async function stopDaemon() {
    setError(null);
    setBusy(true);
    try {
      await invoke("stop_daemon");
      await checkDaemonHealth(daemonRpcUrl);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to stop daemon");
    } finally {
      setBusy(false);
    }
  }

  async function openWorkspace() {
    setError(null);
    setBusy(true);
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Open workspace folder",
      });

      if (!selected || typeof selected !== "string") {
        return;
      }

      setWorkspaceRoot(selected);
      const openResult = await rpc<{ workspaceId: string }>(
        daemonRpcUrl,
        "workspace.open",
        { root: selected },
      );
      setWorkspaceId(openResult.workspaceId);

      const tree = await rpc<{ files: FileInfo[] }>(
        daemonRpcUrl,
        "workspace.getFileTree",
        {
          workspaceId: openResult.workspaceId,
        },
      );
      setFiles(tree.files);
      setFilter("");
      setSearchQuery("");
      setSearchResults([]);
      setSelection({});
      setActiveFilePath(null);
      setActivePresetId("");
      setGitDiffMode("none");
      setCodemapMode("none");
      setPrompt("");
      setTokenEstimate(null);
      setProviderOutput("");
      setEditsXml("");
      setEditPreviews([]);
      setActiveEditFile("");
      setEditSelection({});
      setLastCheckpointId(null);
      setDiscoverSuggestions([]);
      setDiscoverSelection({});
      setDiscoverHandoff("");
      setDiscoverRawOutput("");
      setDiscoverWarning(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to open workspace");
    } finally {
      setBusy(false);
    }
  }

  async function refreshFileTree() {
    if (!workspaceId) return;
    setError(null);
    setBusy(true);
    try {
      const tree = await rpc<{ files: FileInfo[] }>(
        daemonRpcUrl,
        "workspace.getFileTree",
        {
          workspaceId,
        },
      );
      setFiles(tree.files);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to refresh file tree");
    } finally {
      setBusy(false);
    }
  }

  async function runSearch() {
    if (!workspaceId) return;

    const query = searchQuery.trim();
    if (!query) {
      setSearchResults([]);
      return;
    }

    setError(null);
    setSearchLoading(true);
    try {
      const result = await rpc<{ matches: SearchMatch[] }>(
        daemonRpcUrl,
        "workspace.search",
        { workspaceId, query, limit: 200 },
      );
      setSearchResults(result.matches);
    } catch (e) {
      setSearchResults([]);
      setError(e instanceof Error ? e.message : "Failed to search workspace");
    } finally {
      setSearchLoading(false);
    }
  }

  function toggleSelected(path: string) {
    setSelection((prev) => {
      const next = { ...prev };
      if (next[path]) {
        delete next[path];
      } else {
        next[path] = { path, mode: "full" };
      }
      return next;
    });
    setActiveFilePath((prev) => (prev === path ? null : prev));
  }

  function applyPreset(preset: Preset) {
    setInstructions(preset.instructions ?? "");
    setIncludeFileMap(preset.includeFileMap ?? true);
    setGitDiffMode(preset.gitDiffMode ?? "none");
    setCodemapMode(preset.codemapMode ?? "none");
    setSelection(
      Object.fromEntries(preset.selection.map((entry) => [entry.path, entry])),
    );
    if (preset.selection.length > 0) {
      setActiveFilePath(preset.selection[0]?.path ?? null);
    }
    setPrompt("");
    setTokenEstimate(null);
  }

  function updateSelectionEntry(
    path: string,
    updater: (entry: SelectionEntry) => SelectionEntry,
  ) {
    setSelection((prev) => {
      const existing = prev[path];
      if (!existing) {
        return prev;
      }

      return {
        ...prev,
        [path]: updater(existing),
      };
    });
  }

  function setEntryMode(path: string, mode: SelectionMode) {
    updateSelectionEntry(path, (entry) => ({ ...entry, mode }));
  }

  function addSlice(path: string, slice: Slice) {
    updateSelectionEntry(path, (entry) => {
      const existingSlices = entry.slices ?? [];
      return {
        ...entry,
        mode: "slices",
        slices: [...existingSlices, slice].sort(
          (a, b) => a.startLine - b.startLine || a.endLine - b.endLine,
        ),
      };
    });
  }

  function removeSlice(path: string, index: number) {
    updateSelectionEntry(path, (entry) => {
      if (!entry.slices?.length) {
        return entry;
      }
      const nextSlices = entry.slices.filter((_, i) => i !== index);
      return {
        ...entry,
        mode:
          nextSlices.length === 0 && entry.mode === "slices"
            ? "full"
            : entry.mode,
        slices: nextSlices.length > 0 ? nextSlices : undefined,
      };
    });
  }

  function clearSlices(path: string) {
    updateSelectionEntry(path, (entry) => ({
      ...entry,
      mode: entry.mode === "slices" ? "full" : entry.mode,
      slices: undefined,
    }));
  }

  async function savePresetAsNew() {
    if (presetScope === "workspace" && !workspaceId) {
      setError("Open a workspace before saving a workspace preset.");
      return;
    }

    const name = window.prompt("Preset name");
    if (!name || name.trim().length === 0) {
      return;
    }

    setError(null);
    setBusy(true);
    try {
      const selectionEntries = selectedEntries;

      const result = await rpc<{ preset: Preset }>(
        daemonRpcUrl,
        "presets.upsert",
        {
          scope: presetScope,
          ...(presetScope === "workspace" ? { workspaceId } : {}),
          preset: {
            name: name.trim(),
            instructions,
            includeFileMap,
            gitDiffMode,
            codemapMode,
            selection: selectionEntries,
          },
        },
      );
      await loadPresets();
      setActivePresetId(result.preset.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save preset");
    } finally {
      setBusy(false);
    }
  }

  async function updateActivePreset() {
    if (!activePreset) {
      return;
    }

    if (
      !window.confirm(
        `Update preset "${activePreset.name}" with current selection and instructions?`,
      )
    ) {
      return;
    }

    setError(null);
    setBusy(true);
    try {
      const selectionEntries = selectedEntries;

      const result = await rpc<{ preset: Preset }>(
        daemonRpcUrl,
        "presets.upsert",
        {
          scope: presetScope,
          ...(presetScope === "workspace" ? { workspaceId } : {}),
          preset: {
            id: activePreset.id,
            name: activePreset.name,
            instructions,
            includeFileMap,
            gitDiffMode,
            codemapMode,
            selection: selectionEntries,
          },
        },
      );
      await loadPresets();
      setActivePresetId(result.preset.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update preset");
    } finally {
      setBusy(false);
    }
  }

  async function deleteActivePreset() {
    if (!activePreset) {
      return;
    }

    if (!window.confirm(`Delete preset "${activePreset.name}"?`)) {
      return;
    }

    setError(null);
    setBusy(true);
    try {
      await rpc<{ ok: true }>(daemonRpcUrl, "presets.delete", {
        scope: presetScope,
        ...(presetScope === "workspace" ? { workspaceId } : {}),
        presetId: activePreset.id,
      });

      setActivePresetId("");
      await loadPresets();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete preset");
    } finally {
      setBusy(false);
    }
  }

  async function buildPromptFromSelection() {
    if (!workspaceId) return;
    setError(null);
    setBusy(true);

    try {
      const selectionEntries = selectedEntries;

      const result = await rpc<{ prompt: string; tokenEstimate: number }>(
        daemonRpcUrl,
        "workspace.buildPrompt",
        {
          workspaceId,
          selection: selectionEntries,
          includeFileMap,
          gitDiffMode,
          codemapMode,
          ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
        },
      );

      setPrompt(result.prompt);
      setTokenEstimate(result.tokenEstimate);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to build prompt");
    } finally {
      setBusy(false);
    }
  }

  function toggleEditFile(file: string) {
    setEditSelection((prev) => ({ ...prev, [file]: !(prev[file] ?? true) }));
  }

  function setAllEditsSelected(selected: boolean) {
    setEditSelection(
      Object.fromEntries(editPreviews.map((e) => [e.file, selected])),
    );
  }

  async function previewEditsFromXml() {
    if (!workspaceId) return;
    if (!editsXml.trim()) {
      setError("Paste XML edits first.");
      return;
    }

    setError(null);
    setBusy(true);
    try {
      const result = await rpc<{ edits: PreviewEdit[] }>(
        daemonRpcUrl,
        "workspace.previewEdits",
        { workspaceId, xml: editsXml },
      );
      setEditPreviews(result.edits);
      setEditSelection(
        Object.fromEntries(result.edits.map((e) => [e.file, true])),
      );
      setActiveEditFile(result.edits[0]?.file ?? "");
      setLastCheckpointId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to preview edits");
    } finally {
      setBusy(false);
    }
  }

  async function applySelectedEdits() {
    if (!workspaceId) return;
    if (!editsXml.trim()) {
      setError("Paste XML edits first.");
      return;
    }

    const files = Object.entries(editSelection)
      .filter(([, selected]) => selected)
      .map(([file]) => file);

    if (files.length === 0) {
      setError("Select at least one file to apply.");
      return;
    }

    if (!window.confirm(`Apply edits to ${files.length} file(s)?`)) {
      return;
    }

    setError(null);
    setBusy(true);
    try {
      const result = await rpc<{
        ok: true;
        applied: string[];
        checkpointId: string;
      }>(daemonRpcUrl, "workspace.applyEdits", {
        workspaceId,
        xml: editsXml,
        files,
      });

      setLastCheckpointId(result.checkpointId);

      const tree = await rpc<{ files: FileInfo[] }>(
        daemonRpcUrl,
        "workspace.getFileTree",
        { workspaceId },
      );
      setFiles(tree.files);
      await loadActiveFile();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to apply edits");
    } finally {
      setBusy(false);
    }
  }

  async function undoLastEdits() {
    if (!workspaceId) return;
    if (!window.confirm("Undo last applied edits?")) {
      return;
    }

    setError(null);
    setBusy(true);
    try {
      const result = await rpc<{
        ok: true;
        restored: string[];
        checkpointId: string;
      }>(daemonRpcUrl, "workspace.undoEdits", {
        workspaceId,
        ...(lastCheckpointId ? { checkpointId: lastCheckpointId } : {}),
      });

      setLastCheckpointId(result.checkpointId);

      const tree = await rpc<{ files: FileInfo[] }>(
        daemonRpcUrl,
        "workspace.getFileTree",
        { workspaceId },
      );
      setFiles(tree.files);
      await loadActiveFile();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to undo edits");
    } finally {
      setBusy(false);
    }
  }

  async function copyPrompt() {
    setError(null);
    try {
      await navigator.clipboard.writeText(prompt);
    } catch {
      setError("Failed to copy to clipboard");
    }
  }

  async function copyAndOpen(url: string) {
    if (!prompt) return;
    setError(null);
    try {
      await navigator.clipboard.writeText(prompt);
      await openUrl(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to open browser");
    }
  }

  async function runProvider() {
    if (!prompt.trim()) {
      setError("Build a prompt first.");
      return;
    }

    setError(null);
    setBusy(true);
    try {
      const result = await rpc<{
        output: string;
        exitCode: number;
        stderr?: string;
        truncated?: boolean;
      }>(daemonRpcUrl, "providers.run", {
        ...(workspaceId ? { workspaceId } : {}),
        provider,
        prompt,
        ...(providerModel.trim() ? { model: providerModel.trim() } : {}),
      });

      const parts: string[] = [];
      parts.push(result.output.trimEnd());
      if (result.stderr?.trim()) {
        parts.push("", "----- stderr -----", result.stderr.trimEnd());
      }
      if (result.truncated) {
        parts.push("", "(output truncated)");
      }
      parts.push("", `(exit code: ${result.exitCode})`);
      setProviderOutput(parts.join("\n").replace(/\n+$/g, "\n"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to run provider");
    } finally {
      setBusy(false);
    }
  }

  function toggleDiscoverPath(path: string) {
    setDiscoverSelection((prev) => {
      const current = prev[path] ?? true;
      return { ...prev, [path]: !current };
    });
  }

  function setAllDiscoverSelected(selected: boolean) {
    setDiscoverSelection(
      Object.fromEntries(discoverSuggestions.map((s) => [s.path, selected])),
    );
  }

  function applyDiscoverSelection(mode: "replace" | "add") {
    const chosen = discoverSuggestions.filter(
      (s) => discoverSelection[s.path] ?? true,
    );

    if (chosen.length === 0) {
      setError("Select at least one suggested file.");
      return;
    }

    setSelection((prev) => {
      const next: Record<string, SelectionEntry> =
        mode === "replace" ? {} : { ...prev };
      for (const entry of chosen) {
        if (mode === "replace" || !next[entry.path]) {
          next[entry.path] = entry;
        }
      }
      return next;
    });

    if (!instructions.trim() && discoverTask.trim()) {
      setInstructions(discoverTask.trim());
    }

    setActiveFilePath(chosen[0]?.path ?? null);
    setPrompt("");
    setTokenEstimate(null);
    setProviderOutput("");
    setActiveTab("compose");
  }

  async function suggestDiscoverFiles() {
    if (!workspaceId) {
      setError("Open a workspace first.");
      return;
    }

    const task = discoverTask.trim();
    if (!task) {
      setError("Enter a task first.");
      return;
    }

    const maxFiles = clampInt(discoverMaxFiles, 25, { min: 1, max: 200 });
    if (String(maxFiles) !== discoverMaxFiles.trim()) {
      setDiscoverMaxFiles(String(maxFiles));
    }

    setError(null);
    setDiscoverWarning(null);
    setBusy(true);
    try {
      const allPaths = files.map((f) => f.path).sort();
      const fileMapPaths = allPaths.slice(0, DISCOVER_FILE_MAP_LIMIT);
      const truncated = allPaths.length > fileMapPaths.length;

      const changed = gitStatus.isRepo
        ? gitStatus.changedFiles.slice(0, 200)
        : [];

      const discoverPrompt = [
        "You are a repo context builder. Select the most relevant files to read for the task.",
        "",
        "Task:",
        task,
        "",
        "Repository file paths (relative):",
        "<file_map>",
        ...fileMapPaths,
        "</file_map>",
        ...(gitStatus.isRepo && changed.length
          ? [
              "",
              "Recently changed files (git diff HEAD):",
              "<changed_files>",
              ...changed,
              "</changed_files>",
            ]
          : []),
        ...(truncated
          ? [
              "",
              `Note: <file_map> was truncated to ${fileMapPaths.length} of ${allPaths.length} paths.`,
            ]
          : []),
        "",
        "Return ONLY valid JSON. No prose, no markdown.",
        `Schema: {"selection":[{"path":"relative/path","mode":"full|codemap_only"}]}`,
        "Rules:",
        `- Choose at most ${maxFiles} files.`,
        "- Only use paths that appear in <file_map>.",
        "- Prefer a minimal set that is sufficient to implement the task.",
        '- Use mode "codemap_only" for large/secondary files; otherwise use "full".',
      ].join("\n");

      const result = await rpc<{
        output: string;
        exitCode: number;
        stderr?: string;
        truncated?: boolean;
      }>(daemonRpcUrl, "providers.run", {
        workspaceId,
        provider,
        prompt: discoverPrompt,
        ...(providerModel.trim() ? { model: providerModel.trim() } : {}),
      });

      const parts: string[] = [];
      parts.push(result.output.trimEnd());
      if (result.stderr?.trim()) {
        parts.push("", "----- stderr -----", result.stderr.trimEnd());
      }
      if (result.truncated) {
        parts.push("", "(output truncated)");
      }
      parts.push("", `(exit code: ${result.exitCode})`);
      setDiscoverRawOutput(parts.join("\n").replace(/\n+$/g, "\n"));

      const suggested = parseDiscoverSelection(result.output);
      const fileSet = new Set(files.map((f) => f.path));
      const validInWorkspace = suggested.filter((s) => fileSet.has(s.path));
      const limited = validInWorkspace.slice(0, maxFiles);

      const missingCount = suggested.length - validInWorkspace.length;
      const trimmedCount = validInWorkspace.length - limited.length;
      const warnings: string[] = [];
      if (missingCount > 0) {
        warnings.push(
          `Ignored ${missingCount} suggested path(s) not found in this workspace.`,
        );
      }
      if (trimmedCount > 0) {
        warnings.push(`Trimmed to max files (${maxFiles}).`);
      }
      setDiscoverWarning(warnings.length > 0 ? warnings.join(" ") : null);

      setDiscoverSuggestions(limited);
      setDiscoverSelection(
        Object.fromEntries(limited.map((s) => [s.path, true])),
      );
      setDiscoverHandoff("");
    } catch (e) {
      setDiscoverSuggestions([]);
      setDiscoverSelection({});
      setDiscoverHandoff("");
      setDiscoverWarning(null);
      setError(
        e instanceof Error ? e.message : "Failed to suggest files via provider",
      );
    } finally {
      setBusy(false);
    }
  }

  async function runDiscovery() {
    if (!workspaceId) {
      setError("Open a workspace first.");
      return;
    }

    const task = discoverTask.trim();
    if (!task) {
      setError("Enter a task first.");
      return;
    }

    const maxFiles = clampInt(discoverMaxFiles, 25, { min: 1, max: 200 });
    if (String(maxFiles) !== discoverMaxFiles.trim()) {
      setDiscoverMaxFiles(String(maxFiles));
    }

    const maxSteps = clampInt(discoverMaxSteps, 8, { min: 1, max: 20 });
    if (String(maxSteps) !== discoverMaxSteps.trim()) {
      setDiscoverMaxSteps(String(maxSteps));
    }

    const tokenBudget = clampInt(discoverTokenBudget, 60000, {
      min: 1000,
      max: 500000,
    });
    if (String(tokenBudget) !== discoverTokenBudget.trim()) {
      setDiscoverTokenBudget(String(tokenBudget));
    }

    setError(null);
    setDiscoverWarning(null);
    setBusy(true);
    try {
      const result = await rpc<{
        selection: SelectionEntry[];
        tokenEstimate: number;
        handoff: string;
        log: string[];
      }>(daemonRpcUrl, "workspace.discover", {
        workspaceId,
        task,
        provider,
        ...(providerModel.trim() ? { model: providerModel.trim() } : {}),
        maxSteps,
        maxFiles,
        tokenBudget,
      });

      setDiscoverSuggestions(result.selection);
      setDiscoverSelection(
        Object.fromEntries(result.selection.map((s) => [s.path, true])),
      );
      setDiscoverHandoff(result.handoff);
      setDiscoverRawOutput(result.log.join("\n").trimEnd());

      if (result.tokenEstimate > tokenBudget) {
        setDiscoverWarning(
          `Discovery prompt is ~${result.tokenEstimate} tokens (budget ~${tokenBudget}). Consider reducing max files or switching some files to API-only / slices.`,
        );
      } else {
        setDiscoverWarning(
          `Discovery prompt is ~${result.tokenEstimate} tokens.`,
        );
      }
    } catch (e) {
      setDiscoverSuggestions([]);
      setDiscoverSelection({});
      setDiscoverHandoff("");
      setDiscoverRawOutput("");
      setDiscoverWarning(null);
      setError(e instanceof Error ? e.message : "Failed to run discovery");
    } finally {
      setBusy(false);
    }
  }

  const activeEntry = activeFilePath ? selection[activeFilePath] : undefined;
  const activeEntrySlices = activeEntry?.slices ?? [];

  const activeFileLines = useMemo(() => {
    if (!activeFileContent) {
      return [];
    }
    return activeFileContent.split(/\r?\n/);
  }, [activeFileContent]);

  function handlePreviewLineClick(lineNo: number) {
    if (!activeFilePath) {
      return;
    }
    if (!activeEntry) {
      setError("Select the file first to add slices.");
      return;
    }

    if (pendingSliceStart === null) {
      setPendingSliceStart(lineNo);
      return;
    }

    const start = pendingSliceStart;
    const end = lineNo;
    const normalized: Slice = {
      startLine: Math.min(start, end),
      endLine: Math.max(start, end),
    };
    addSlice(activeFilePath, normalized);
    setPendingSliceStart(null);
  }

  function handleAddSliceFromInputs() {
    if (!activeFilePath || !activeEntry) {
      return;
    }

    const startLine = Number(sliceStartInput);
    const endLine = Number(sliceEndInput);
    if (!Number.isInteger(startLine) || startLine <= 0) {
      setError("Slice start line must be a positive integer.");
      return;
    }
    if (!Number.isInteger(endLine) || endLine <= 0) {
      setError("Slice end line must be a positive integer.");
      return;
    }

    const normalized: Slice = {
      startLine: Math.min(startLine, endLine),
      endLine: Math.max(startLine, endLine),
      ...(sliceDescriptionInput.trim()
        ? { description: sliceDescriptionInput.trim() }
        : {}),
    };

    addSlice(activeFilePath, normalized);
    setSliceStartInput("");
    setSliceEndInput("");
    setSliceDescriptionInput("");
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brandTitle">PromptKit</div>
          <div className="brandSub">
            {activeTab === "compose"
              ? "Compose (MVP)"
              : activeTab === "discover"
                ? "Discover (MVP)"
                : "Apply + Review (MVP)"}
          </div>
        </div>

        <div className="tabs">
          <button
            type="button"
            className={activeTab === "compose" ? "tab tab-active" : "tab"}
            onClick={() => setActiveTab("compose")}
            disabled={busy}
          >
            Compose
          </button>
          <button
            type="button"
            className={activeTab === "discover" ? "tab tab-active" : "tab"}
            onClick={() => setActiveTab("discover")}
            disabled={busy}
          >
            Discover
          </button>
          <button
            type="button"
            className={activeTab === "apply" ? "tab tab-active" : "tab"}
            onClick={() => setActiveTab("apply")}
            disabled={busy}
          >
            Apply
          </button>
        </div>

        <div className="controls">
          <button type="button" onClick={startDaemon} disabled={busy}>
            Start daemon
          </button>
          <button type="button" onClick={stopDaemon} disabled={busy}>
            Stop daemon
          </button>
          <span
            className={`pill pill-${daemonHealth}`}
            title="The daemon is a local background service that scans files, builds prompts, and runs providers."
          >
            daemon: {daemonHealth}
          </span>
        </div>

        <div className="controls grow">
          <label className="field">
            <span>RPC</span>
            <input
              value={daemonRpcUrl}
              onChange={(e) => setDaemonRpcUrl(e.currentTarget.value)}
              spellCheck={false}
            />
          </label>
          <button
            type="button"
            onClick={() => checkDaemonHealth(daemonRpcUrl)}
            disabled={busy}
          >
            Check
          </button>
          <button
            type="button"
            onClick={openWorkspace}
            disabled={busy || daemonHealth !== "ok"}
          >
            Open folder…
          </button>
        </div>
      </header>

      {error ? <div className="error">{error}</div> : null}

      <main className="main">
        {activeTab === "compose" ? (
          <>
            <section className="panel">
              <div className="panelHeader">
                <div className="panelTitle">Files</div>
                <div className="panelMeta">
                  {workspaceRoot ? (
                    <span title={workspaceRoot}>{workspaceRoot}</span>
                  ) : (
                    <span>—</span>
                  )}
                </div>
              </div>

              <div className="row gap">
                <input
                  placeholder="Filter paths…"
                  value={filter}
                  onChange={(e) => setFilter(e.currentTarget.value)}
                  spellCheck={false}
                />
                <button
                  type="button"
                  onClick={refreshFileTree}
                  disabled={busy || !workspaceId}
                >
                  Refresh
                </button>
              </div>

              <div className="row gap">
                <input
                  placeholder="Search file contents…"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      void runSearch();
                    }
                  }}
                  spellCheck={false}
                />
                <button
                  type="button"
                  onClick={runSearch}
                  disabled={busy || !workspaceId || searchLoading}
                  title="Searches within workspace text files"
                >
                  {searchLoading ? "Search…" : "Search"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSearchQuery("");
                    setSearchResults([]);
                  }}
                  disabled={
                    busy ||
                    (searchQuery.length === 0 && searchResults.length === 0)
                  }
                >
                  Clear
                </button>
              </div>

              {searchResults.length > 0 ? (
                <details className="details" open>
                  <summary>Search results ({searchResults.length})</summary>
                  <div className="detailsBody">
                    {searchResults.map((m, idx) => (
                      <div
                        key={`${m.path}:${m.line}:${idx}`}
                        className="detailsRow"
                      >
                        <div className="row gap">
                          <button
                            type="button"
                            className="filePathButton"
                            onClick={() => setActiveFilePath(m.path)}
                            disabled={busy}
                            title={`${m.path}:${m.line}`}
                          >
                            {m.path}:{m.line}
                          </button>
                          <button
                            type="button"
                            className="sliceRemove"
                            onClick={() => toggleSelected(m.path)}
                            disabled={busy}
                            title="Toggle selection"
                          >
                            {selection[m.path] ? "Unselect" : "Select"}
                          </button>
                        </div>
                        <div className="fileMeta">{m.preview}</div>
                      </div>
                    ))}
                  </div>
                </details>
              ) : null}

              <div className="fileList">
                {filteredFiles.length === 0 ? (
                  <div className="previewStatus">
                    {daemonHealth !== "ok"
                      ? "Daemon is down. Click Start daemon to open a folder and load files."
                      : workspaceId
                        ? "No files found. Try Refresh, or open a different folder."
                        : "Open folder… to load a repo/workspace."}
                  </div>
                ) : (
                  filteredFiles.map((f) => {
                    const isSelected = Boolean(selection[f.path]);
                    const isActive = activeFilePath === f.path;
                    return (
                      <div
                        key={f.path}
                        className={[
                          "fileRow",
                          isSelected ? "fileRow-selected" : "",
                          isActive ? "fileRow-active" : "",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                      >
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleSelected(f.path)}
                          disabled={busy}
                        />
                        <button
                          type="button"
                          className="filePathButton"
                          onClick={() => setActiveFilePath(f.path)}
                          disabled={!workspaceId}
                          title={f.path}
                        >
                          {f.path}
                        </button>
                        <span className="fileMeta">
                          {f.isBinary ? "bin" : "txt"} ·{" "}
                          {formatBytes(f.sizeBytes)}
                        </span>
                      </div>
                    );
                  })
                )}
              </div>

              <div className="previewPane">
                <div className="previewHeader">
                  <div className="previewTitle">
                    {activeFilePath ? activeFilePath : "Preview"}
                  </div>
                  <div className="row gap">
                    {activeFilePath && selection[activeFilePath] ? (
                      <select
                        value={selection[activeFilePath].mode}
                        onChange={(e) =>
                          setEntryMode(
                            activeFilePath,
                            e.currentTarget.value as SelectionMode,
                          )
                        }
                        disabled={busy}
                        title="Mode"
                      >
                        <option value="full">Full</option>
                        <option value="slices">Slices</option>
                        <option value="codemap_only">API only</option>
                      </select>
                    ) : null}
                    <button
                      type="button"
                      onClick={loadActiveFile}
                      disabled={
                        !activeFilePath || !workspaceId || activeFileLoading
                      }
                    >
                      Reload
                    </button>
                    {activeFilePath && !selection[activeFilePath] ? (
                      <button
                        type="button"
                        onClick={() => toggleSelected(activeFilePath)}
                        disabled={busy}
                      >
                        Select
                      </button>
                    ) : null}
                  </div>
                </div>

                {activeFileError ? (
                  <div className="errorSmall">{activeFileError}</div>
                ) : null}

                {activeFilePath && activeEntry ? (
                  <div className="sliceTools">
                    <div className="sliceToolsHeader">
                      <div className="sliceToolsTitle">Slices</div>
                      <div className="sliceToolsHint">
                        {pendingSliceStart === null
                          ? "Click a line number to set start"
                          : `Start at ${pendingSliceStart}. Click another line to finish.`}
                      </div>
                    </div>

                    <div className="row gap">
                      <input
                        placeholder="Start"
                        value={sliceStartInput}
                        onChange={(e) =>
                          setSliceStartInput(e.currentTarget.value)
                        }
                        disabled={busy}
                      />
                      <input
                        placeholder="End"
                        value={sliceEndInput}
                        onChange={(e) =>
                          setSliceEndInput(e.currentTarget.value)
                        }
                        disabled={busy}
                      />
                      <input
                        placeholder="Description (optional)"
                        value={sliceDescriptionInput}
                        onChange={(e) =>
                          setSliceDescriptionInput(e.currentTarget.value)
                        }
                        disabled={busy}
                      />
                      <button
                        type="button"
                        onClick={handleAddSliceFromInputs}
                        disabled={busy || !activeFilePath}
                      >
                        Add
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setPendingSliceStart(null);
                          clearSlices(activeFilePath);
                        }}
                        disabled={busy || activeEntrySlices.length === 0}
                      >
                        Clear
                      </button>
                    </div>

                    {activeEntrySlices.length > 0 ? (
                      <div className="sliceList">
                        {activeEntrySlices.map((s, i) => (
                          <div
                            key={`${s.startLine}-${s.endLine}-${i}`}
                            className="sliceRow"
                          >
                            <span className="sliceRange">
                              {s.startLine}–{s.endLine}
                              {s.description ? ` · ${s.description}` : ""}
                            </span>
                            <button
                              type="button"
                              className="sliceRemove"
                              onClick={() => removeSlice(activeFilePath, i)}
                              disabled={busy}
                            >
                              Remove
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="sliceEmpty">
                        No slices yet. Switch mode to “Slices” or add a slice to
                        enable slice output.
                      </div>
                    )}
                  </div>
                ) : null}

                {activeFileLoading ? (
                  <div className="previewStatus">Loading…</div>
                ) : activeFilePath ? (
                  <div className="codePane">
                    <div className="codeMeta">
                      <span>
                        Showing{" "}
                        {Math.min(previewLineLimit, activeFileLines.length)} of{" "}
                        {activeFileLines.length} lines
                      </span>
                      <div className="row gap">
                        <button
                          type="button"
                          onClick={() =>
                            setPreviewLineLimit((n) => n + PREVIEW_LINES_STEP)
                          }
                          disabled={
                            previewLineLimit >= activeFileLines.length ||
                            activeFileLines.length === 0
                          }
                        >
                          Show more
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setPreviewLineLimit(activeFileLines.length)
                          }
                          disabled={
                            previewLineLimit >= activeFileLines.length ||
                            activeFileLines.length === 0
                          }
                        >
                          Show all
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setPreviewLineLimit(DEFAULT_PREVIEW_LINES)
                          }
                          disabled={
                            previewLineLimit <= DEFAULT_PREVIEW_LINES ||
                            activeFileLines.length === 0
                          }
                        >
                          Reset
                        </button>
                      </div>
                    </div>

                    <div className="code">
                      {activeFileLines
                        .slice(0, previewLineLimit)
                        .map((line, idx) => {
                          const lineNo = idx + 1;
                          const isStart = pendingSliceStart === lineNo;
                          const isSliced = activeEntrySlices.some(
                            (s) => lineNo >= s.startLine && lineNo <= s.endLine,
                          );
                          return (
                            <div
                              key={lineNo}
                              className={[
                                "codeLine",
                                isStart ? "codeLine-start" : "",
                                isSliced ? "codeLine-sliced" : "",
                              ]
                                .filter(Boolean)
                                .join(" ")}
                            >
                              <button
                                type="button"
                                className="codeNo"
                                onClick={() => handlePreviewLineClick(lineNo)}
                                disabled={!activeEntry}
                                title={
                                  activeEntry
                                    ? "Click to add slice range"
                                    : "Select file to enable slicing"
                                }
                              >
                                {lineNo}
                              </button>
                              <span className="codeText">{line}</span>
                            </div>
                          );
                        })}
                    </div>
                  </div>
                ) : (
                  <div className="previewStatus">
                    Click a file path to preview and create slices.
                  </div>
                )}
              </div>
            </section>

            <section className="panel">
              <div className="panelHeader">
                <div className="panelTitle">Prompt</div>
                <div className="panelMeta">
                  <span>{selectedCount} selected</span>
                  {tokenEstimate === null ? null : (
                    <span> · ~{tokenEstimate} tokens</span>
                  )}
                </div>
              </div>

              <div className="row gap">
                <select
                  value={presetScope}
                  onChange={(e) => {
                    setActivePresetId("");
                    setPresetScope(e.currentTarget.value as PresetScope);
                  }}
                  disabled={busy}
                >
                  <option value="workspace">Workspace presets</option>
                  <option value="global">Global presets</option>
                </select>
                <select
                  value={activePresetId}
                  onChange={(e) => {
                    const id = e.currentTarget.value;
                    setActivePresetId(id);
                    const preset = presets.find((p) => p.id === id);
                    if (preset) {
                      applyPreset(preset);
                    }
                  }}
                  disabled={busy || presets.length === 0}
                >
                  <option value="">No preset</option>
                  {presets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={savePresetAsNew}
                  disabled={
                    busy || selectedCount === 0 || sliceIssues.length > 0
                  }
                >
                  Save as…
                </button>
                <button
                  type="button"
                  onClick={updateActivePreset}
                  disabled={
                    busy ||
                    !activePreset ||
                    selectedCount === 0 ||
                    sliceIssues.length > 0
                  }
                >
                  Update
                </button>
                <button
                  type="button"
                  onClick={deleteActivePreset}
                  disabled={busy || !activePreset}
                >
                  Delete
                </button>
              </div>

              <label className="field">
                <span>Instructions</span>
                <textarea
                  value={instructions}
                  onChange={(e) => setInstructions(e.currentTarget.value)}
                  placeholder="What do you want the model to do?"
                />
              </label>

              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={includeFileMap}
                  onChange={(e) => setIncludeFileMap(e.currentTarget.checked)}
                  disabled={busy}
                />
                <span>Include file map</span>
              </label>

              <div className="row gap">
                <label className="field fieldInline">
                  <span>Codemaps</span>
                  <select
                    value={codemapMode}
                    onChange={(e) =>
                      setCodemapMode(e.currentTarget.value as CodemapMode)
                    }
                    disabled={busy}
                  >
                    <option value="none">None</option>
                    <option value="auto">Auto (slice-mode files)</option>
                    <option value="complete">All selected files</option>
                  </select>
                </label>
              </div>

              <div className="row gap">
                <label className="field fieldInline">
                  <span>Git diff</span>
                  <select
                    value={gitDiffMode}
                    onChange={(e) =>
                      setGitDiffMode(e.currentTarget.value as GitDiffMode)
                    }
                    disabled={busy}
                  >
                    <option value="none">None</option>
                    <option value="selected">Selected files</option>
                    <option value="all_changed">All changed files</option>
                  </select>
                </label>
                <button
                  type="button"
                  onClick={loadGitStatus}
                  disabled={busy || !workspaceId || gitStatusLoading}
                  title="Refresh git status"
                >
                  {gitStatusLoading ? "Git…" : "Git status"}
                </button>
                <span
                  className="badge"
                  title="Changed files from git diff HEAD"
                >
                  {gitStatus.isRepo
                    ? `${gitStatus.changedFiles.length} changed`
                    : "not a repo"}
                </span>
              </div>

              {gitStatus.isRepo && gitStatus.changedFiles.length > 0 ? (
                <details className="details">
                  <summary>Changed files</summary>
                  <div className="detailsBody">
                    {gitStatus.changedFiles.map((p) => (
                      <div key={p} className="detailsRow">
                        {p}
                      </div>
                    ))}
                  </div>
                </details>
              ) : null}

              {selectedEntries.length > 0 ? (
                <div className="selectedList">
                  {selectedEntries.map((entry) => {
                    const sliceCount = entry.slices?.length ?? 0;
                    const hasSliceIssue =
                      entry.mode === "slices" && sliceCount === 0;
                    return (
                      <div key={entry.path} className="selectedRow">
                        <button
                          type="button"
                          className="selectedPath"
                          onClick={() => setActiveFilePath(entry.path)}
                          title="Open in preview"
                        >
                          {entry.path}
                        </button>
                        <select
                          value={entry.mode}
                          onChange={(e) =>
                            setEntryMode(
                              entry.path,
                              e.currentTarget.value as SelectionMode,
                            )
                          }
                          disabled={busy}
                          title="Mode"
                        >
                          <option value="full">Full</option>
                          <option value="slices">Slices</option>
                          <option value="codemap_only">API only</option>
                        </select>
                        {entry.mode === "slices" ? (
                          <span
                            className={[
                              "badge",
                              hasSliceIssue ? "badge-warn" : "",
                            ]
                              .filter(Boolean)
                              .join(" ")}
                            title={
                              hasSliceIssue
                                ? "Add at least one slice"
                                : "Slices configured"
                            }
                          >
                            {sliceCount} slices
                          </span>
                        ) : (
                          <span className="badge">{entry.mode}</span>
                        )}
                        <button
                          type="button"
                          className="selectedRemove"
                          onClick={() => toggleSelected(entry.path)}
                          disabled={busy}
                          title="Remove from selection"
                        >
                          Remove
                        </button>
                      </div>
                    );
                  })}
                </div>
              ) : null}

              {sliceIssues.length > 0 ? (
                <div className="warning">
                  Add at least one slice for:{" "}
                  {sliceIssues.map((e) => e.path).join(", ")}
                </div>
              ) : null}

              <div className="row gap">
                <button
                  type="button"
                  onClick={buildPromptFromSelection}
                  disabled={
                    busy ||
                    !workspaceId ||
                    selectedCount === 0 ||
                    sliceIssues.length > 0
                  }
                >
                  Build prompt
                </button>
                <button type="button" onClick={copyPrompt} disabled={!prompt}>
                  Copy
                </button>
                <button
                  type="button"
                  onClick={() => copyAndOpen("https://chatgpt.com")}
                  disabled={!prompt}
                  title="Copy prompt and open ChatGPT in your browser"
                >
                  ChatGPT
                </button>
                <button
                  type="button"
                  onClick={() => copyAndOpen("https://claude.ai")}
                  disabled={!prompt}
                  title="Copy prompt and open Claude in your browser"
                >
                  Claude
                </button>
              </div>

              <label className="field">
                <span>Output</span>
                <textarea value={prompt} readOnly spellCheck={false} />
              </label>

              <div className="row gap">
                <label className="field fieldInline">
                  <span>Run with</span>
                  <select
                    value={provider}
                    onChange={(e) =>
                      setProvider(e.currentTarget.value as ProviderId)
                    }
                    disabled={busy}
                  >
                    <option value="claude_code_cli">
                      Claude Code (claude)
                    </option>
                    <option value="codex_cli">Codex CLI (codex)</option>
                  </select>
                </label>
                <label className="field fieldInline">
                  <span>Model (optional)</span>
                  <input
                    value={providerModel}
                    onChange={(e) => setProviderModel(e.currentTarget.value)}
                    placeholder="e.g. sonnet, gpt-5, …"
                    spellCheck={false}
                    disabled={busy}
                  />
                </label>
                <button
                  type="button"
                  onClick={runProvider}
                  disabled={busy || daemonHealth !== "ok" || !prompt}
                  title="Runs locally via the selected CLI (must be installed and authenticated)"
                >
                  Run
                </button>
              </div>

              <label className="field">
                <span>Provider output</span>
                <textarea value={providerOutput} readOnly spellCheck={false} />
              </label>
            </section>
          </>
        ) : activeTab === "discover" ? (
          <>
            <section className="panel">
              <div className="panelHeader">
                <div className="panelTitle">Discover</div>
                <div className="panelMeta">
                  {workspaceRoot ? (
                    <span title={workspaceRoot}>{workspaceRoot}</span>
                  ) : (
                    <span>—</span>
                  )}
                </div>
              </div>

              <label className="field">
                <span>Task</span>
                <textarea
                  value={discoverTask}
                  onChange={(e) => setDiscoverTask(e.currentTarget.value)}
                  placeholder="What are you trying to do? (e.g. add a feature, fix a bug, refactor...)"
                />
              </label>

              <div className="row gap">
                <label className="field fieldInline">
                  <span>Run with</span>
                  <select
                    value={provider}
                    onChange={(e) =>
                      setProvider(e.currentTarget.value as ProviderId)
                    }
                    disabled={busy}
                  >
                    <option value="claude_code_cli">
                      Claude Code (claude)
                    </option>
                    <option value="codex_cli">Codex CLI (codex)</option>
                  </select>
                </label>
                <label className="field fieldInline">
                  <span>Model (optional)</span>
                  <input
                    value={providerModel}
                    onChange={(e) => setProviderModel(e.currentTarget.value)}
                    placeholder="e.g. sonnet, gpt-5, …"
                    spellCheck={false}
                    disabled={busy}
                  />
                </label>
              </div>

              <div className="row gap">
                <label className="field fieldInline">
                  <span>Max files</span>
                  <input
                    value={discoverMaxFiles}
                    onChange={(e) => setDiscoverMaxFiles(e.currentTarget.value)}
                    spellCheck={false}
                    disabled={busy}
                  />
                </label>
                <button
                  type="button"
                  onClick={suggestDiscoverFiles}
                  disabled={
                    busy ||
                    daemonHealth !== "ok" ||
                    !workspaceId ||
                    !discoverTask.trim()
                  }
                  title="Asks your selected CLI provider to suggest relevant files (based on paths only)"
                >
                  Suggest files
                </button>
              </div>

              <div className="row gap">
                <label className="field fieldInline">
                  <span>Max steps</span>
                  <input
                    value={discoverMaxSteps}
                    onChange={(e) => setDiscoverMaxSteps(e.currentTarget.value)}
                    spellCheck={false}
                    disabled={busy}
                  />
                </label>
                <label className="field fieldInline">
                  <span>Token budget</span>
                  <input
                    value={discoverTokenBudget}
                    onChange={(e) =>
                      setDiscoverTokenBudget(e.currentTarget.value)
                    }
                    spellCheck={false}
                    disabled={busy}
                  />
                </label>
                <button
                  type="button"
                  onClick={runDiscovery}
                  disabled={
                    busy ||
                    daemonHealth !== "ok" ||
                    !workspaceId ||
                    !discoverTask.trim()
                  }
                  title="Runs a multi-step discovery loop (search/read/codemap) to produce a ready-to-paste prompt under a budget"
                >
                  Run discovery
                </button>
              </div>

              {discoverWarning ? (
                <div className="warning">{discoverWarning}</div>
              ) : null}

              <div className="row gap">
                <button
                  type="button"
                  onClick={() => setAllDiscoverSelected(true)}
                  disabled={busy || discoverSuggestions.length === 0}
                >
                  All
                </button>
                <button
                  type="button"
                  onClick={() => setAllDiscoverSelected(false)}
                  disabled={busy || discoverSuggestions.length === 0}
                >
                  None
                </button>
                <span className="badge">
                  {discoverSelectedCount}/{discoverSuggestions.length} selected
                </span>
              </div>

              <div className="fileList">
                {discoverSuggestions.length === 0 ? (
                  <div className="previewStatus">
                    Enter a task and click Suggest files (fast) or Run discovery
                    (agent). Use the result to switch back to Compose, or copy
                    the handoff prompt directly.
                  </div>
                ) : (
                  discoverSuggestions.map((s) => {
                    const selected = discoverSelection[s.path] ?? true;
                    return (
                      <div
                        key={s.path}
                        className={[
                          "fileRow",
                          selected ? "fileRow-selected" : "",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                      >
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => toggleDiscoverPath(s.path)}
                          disabled={busy}
                        />
                        <button
                          type="button"
                          className="filePathButton"
                          onClick={() => toggleDiscoverPath(s.path)}
                          disabled={busy}
                          title={s.path}
                        >
                          {s.path}
                        </button>
                        <span className="badge">
                          {s.mode === "codemap_only" ? "API only" : "full"}
                        </span>
                      </div>
                    );
                  })
                )}
              </div>

              <div className="row gap">
                <button
                  type="button"
                  onClick={() => applyDiscoverSelection("replace")}
                  disabled={busy || discoverSuggestions.length === 0}
                  title="Replaces your current selection"
                >
                  Use (replace)
                </button>
                <button
                  type="button"
                  onClick={() => applyDiscoverSelection("add")}
                  disabled={busy || discoverSuggestions.length === 0}
                  title="Adds missing files to your current selection"
                >
                  Use (add)
                </button>
              </div>
            </section>

            <section className="panel">
              <div className="panelHeader">
                <div className="panelTitle">Output</div>
                <div className="panelMeta">
                  <span>Discovery prompt + log</span>
                </div>
              </div>

              <label className="field">
                <span>Handoff prompt</span>
                <textarea value={discoverHandoff} readOnly spellCheck={false} />
              </label>

              <label className="field">
                <span>Log / raw</span>
                <textarea
                  value={discoverRawOutput}
                  readOnly
                  spellCheck={false}
                />
              </label>
            </section>
          </>
        ) : (
          <>
            <section className="panel">
              <div className="panelHeader">
                <div className="panelTitle">Apply</div>
                <div className="panelMeta">
                  {workspaceRoot ? (
                    <span title={workspaceRoot}>{workspaceRoot}</span>
                  ) : (
                    <span>—</span>
                  )}
                </div>
              </div>

              <label className="field">
                <span>XML edits</span>
                <textarea
                  value={editsXml}
                  onChange={(e) => setEditsXml(e.currentTarget.value)}
                  placeholder={`<edits>\n  <edit file=\"path/to/file.ts\">\n    <rewrite><![CDATA[\n// new contents\n]]></rewrite>\n  </edit>\n</edits>`}
                  spellCheck={false}
                />
              </label>

              <div className="row gap">
                <button
                  type="button"
                  onClick={previewEditsFromXml}
                  disabled={busy || !workspaceId || daemonHealth !== "ok"}
                >
                  Preview
                </button>
                <button
                  type="button"
                  onClick={applySelectedEdits}
                  disabled={
                    busy ||
                    !workspaceId ||
                    editPreviews.length === 0 ||
                    selectedEditCount === 0
                  }
                >
                  Apply selected
                </button>
                <button
                  type="button"
                  onClick={undoLastEdits}
                  disabled={busy || !workspaceId}
                >
                  Undo
                </button>
              </div>

              {lastCheckpointId ? (
                <div className="panelMeta" title={lastCheckpointId}>
                  Last checkpoint: {lastCheckpointId}
                </div>
              ) : null}

              {editPreviews.length > 0 ? (
                <>
                  <div className="row gap">
                    <button
                      type="button"
                      onClick={() => setAllEditsSelected(true)}
                      disabled={busy}
                    >
                      All
                    </button>
                    <button
                      type="button"
                      onClick={() => setAllEditsSelected(false)}
                      disabled={busy}
                    >
                      None
                    </button>
                    <span className="badge">
                      {selectedEditCount}/{editPreviews.length} selected
                    </span>
                  </div>

                  <div className="editList">
                    {editPreviews.map((e) => {
                      const isSelected = editSelection[e.file] ?? true;
                      const isActive = activeEditFile === e.file;
                      return (
                        <div
                          key={e.file}
                          className={[
                            "fileRow",
                            isSelected ? "fileRow-selected" : "",
                            isActive ? "fileRow-active" : "",
                          ]
                            .filter(Boolean)
                            .join(" ")}
                        >
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleEditFile(e.file)}
                            disabled={busy}
                          />
                          <button
                            type="button"
                            className="filePathButton"
                            onClick={() => setActiveEditFile(e.file)}
                            disabled={!workspaceId}
                            title={e.file}
                          >
                            {e.file}
                          </button>
                          <span className="badge">{e.kind}</span>
                        </div>
                      );
                    })}
                  </div>
                </>
              ) : (
                <div className="previewStatus">
                  Paste XML edits and click Preview to see diffs.
                </div>
              )}
            </section>

            <section className="panel">
              <div className="panelHeader">
                <div className="panelTitle">Review</div>
                <div className="panelMeta">
                  {activeEditPreview ? (
                    <span title={activeEditPreview.file}>
                      {activeEditPreview.file} · {activeEditPreview.kind}
                    </span>
                  ) : (
                    <span>—</span>
                  )}
                </div>
              </div>

              <label className="field">
                <span>Unified diff</span>
                <textarea
                  value={activeEditPreview?.unifiedDiff ?? ""}
                  readOnly
                  spellCheck={false}
                />
              </label>
            </section>
          </>
        )}
      </main>
    </div>
  );
}

export default App;
