import path from "node:path";

export function toPosixPath(p: string): string {
  return p.replaceAll(path.win32.sep, path.posix.sep);
}

export function normalizeRelativePath(p: string): string {
  const normalized = toPosixPath(p)
    .replaceAll(/\/+/g, "/")
    .replaceAll(/^\.\/+/g, "");
  return normalized.replaceAll(/^\/+/g, "");
}

export function assertPathWithinRoot(
  root: string,
  relativePath: string,
): string {
  const safeRelative = normalizeRelativePath(relativePath);
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(resolvedRoot, safeRelative);
  const rel = path.relative(resolvedRoot, resolvedTarget);

  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
    return resolvedTarget;
  }

  throw new Error(`Path escapes root: ${relativePath}`);
}
