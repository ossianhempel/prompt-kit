export type { FileInfo, ScanWorkspaceOptions } from "./scan.js";
export { scanWorkspace } from "./scan.js";

export {
  assertPathWithinRoot,
  normalizeRelativePath,
  toPosixPath,
} from "./path.js";

export type { ReadFileOptions } from "./read.js";
export { readTextFile, sliceTextByLines } from "./read.js";

export type { SearchMatch, SearchOptions } from "./search.js";
export { searchFiles } from "./search.js";

export type { PromptBuildOptions, PromptBuildResult } from "./prompt.js";
export { buildPrompt, estimateTokens } from "./prompt.js";

export { getChangedFiles, getGitDiff, isGitRepo } from "./git.js";

export type { CodemapLanguage } from "./codemap.js";
export { buildCodemapFromText, detectCodemapLanguage } from "./codemap.js";

export type { PreviewEdit, XmlEdit } from "./edits.js";
export { applyEditToText, parseEditsXml, toUnifiedDiff } from "./edits.js";

export type {
  CodemapMode,
  GitDiffMode,
  SelectionEntry,
  SelectionMode,
  Slice,
} from "./types.js";
