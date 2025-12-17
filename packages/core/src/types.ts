export interface Slice {
  startLine: number;
  endLine: number;
  description?: string;
}

export type SelectionMode = "full" | "slices" | "codemap_only";

export interface SelectionEntry {
  path: string;
  mode: SelectionMode;
  slices?: Slice[];
}

export type GitDiffMode = "none" | "selected" | "all_changed";

export type CodemapMode = "none" | "auto" | "complete";
