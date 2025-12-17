import { createHash } from "node:crypto";

export type CodemapLanguage =
  | "typescript"
  | "tsx"
  | "javascript"
  | "jsx"
  | "rust";

type TreeSitterParser = {
  setLanguage(lang: unknown): void;
  parse(input: string): { rootNode: TreeSitterNode };
};

type TreeSitterNode = {
  type: string;
  startIndex: number;
  endIndex: number;
  namedChildren: TreeSitterNode[];
  childForFieldName(name: string): TreeSitterNode | null;
};

type CodemapItem = {
  kind: string;
  name: string | null;
  exported: boolean;
  signature: string;
};

const CODEMAP_VERSION = "v1";

const parserCache = new Map<CodemapLanguage, TreeSitterParser>();
const codemapCache = new Map<string, string>();

function normalizeOneLine(text: string): string {
  return text.replaceAll(/\s+/g, " ").trim();
}

function truncateOneLine(text: string, maxLen = 140): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(0, maxLen - 1))}…`;
}

function hashText(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

function languageLabel(lang: CodemapLanguage): string {
  switch (lang) {
    case "typescript":
      return "TypeScript";
    case "tsx":
      return "TSX";
    case "javascript":
      return "JavaScript";
    case "jsx":
      return "JSX";
    case "rust":
      return "Rust";
  }
}

export function detectCodemapLanguage(
  filePath: string,
): CodemapLanguage | null {
  const lower = filePath.toLowerCase();
  if (
    lower.endsWith(".ts") ||
    lower.endsWith(".mts") ||
    lower.endsWith(".cts")
  ) {
    return "typescript";
  }
  if (lower.endsWith(".tsx")) {
    return "tsx";
  }
  if (
    lower.endsWith(".js") ||
    lower.endsWith(".mjs") ||
    lower.endsWith(".cjs")
  ) {
    return "javascript";
  }
  if (lower.endsWith(".jsx")) {
    return "jsx";
  }
  if (lower.endsWith(".rs")) {
    return "rust";
  }
  return null;
}

async function loadTreeSitter(): Promise<new () => TreeSitterParser> {
  const mod = (await import("tree-sitter")) as unknown as {
    default?: new () => TreeSitterParser;
  };
  const Parser = mod.default ?? (mod as unknown as new () => TreeSitterParser);
  return Parser;
}

async function loadLanguage(lang: CodemapLanguage): Promise<unknown> {
  switch (lang) {
    case "typescript":
    case "tsx": {
      const mod = (await import("tree-sitter-typescript")) as unknown as {
        default?: { typescript: unknown; tsx: unknown };
        typescript?: unknown;
        tsx?: unknown;
      };
      const pkg = mod.default ?? mod;
      return lang === "typescript" ? pkg.typescript : pkg.tsx;
    }
    case "javascript":
    case "jsx": {
      const mod = (await import("tree-sitter-javascript")) as unknown as {
        default?: unknown;
      };
      return mod.default ?? (mod as unknown);
    }
    case "rust": {
      const mod = (await import("tree-sitter-rust")) as unknown as {
        default?: unknown;
      };
      return mod.default ?? (mod as unknown);
    }
  }
}

async function getParser(lang: CodemapLanguage): Promise<TreeSitterParser> {
  const cached = parserCache.get(lang);
  if (cached) return cached;

  const Parser = await loadTreeSitter();
  const language = await loadLanguage(lang);
  const parser = new Parser();
  parser.setLanguage(language);
  parserCache.set(lang, parser);
  return parser;
}

function signatureForDeclaration(
  node: TreeSitterNode,
  source: string,
  options: { prefix?: string } = {},
): string {
  const prefix = options.prefix ?? "";

  const body =
    node.childForFieldName("body") ??
    node.namedChildren.find(
      (c) =>
        c.type === "statement_block" ||
        c.type === "class_body" ||
        c.type === "enum_body" ||
        c.type === "trait_item" ||
        c.type === "declaration_list",
    ) ??
    null;

  const end = body ? Math.max(node.startIndex, body.startIndex) : node.endIndex;
  const raw = source.slice(node.startIndex, end);
  const line = truncateOneLine(normalizeOneLine(raw));
  return `${prefix}${line}`.trim();
}

function kindForNodeType(type: string): string {
  if (type.includes("function")) return "function";
  if (type.includes("class")) return "class";
  if (type.includes("interface")) return "interface";
  if (type.includes("type")) return "type";
  if (type.includes("enum")) return "enum";
  if (type.includes("struct")) return "struct";
  if (type.includes("trait")) return "trait";
  if (type.includes("impl")) return "impl";
  if (type.includes("mod")) return "module";
  if (type.includes("const")) return "const";
  if (type.includes("static")) return "static";
  return type;
}

function nameFromNode(node: TreeSitterNode, source: string): string | null {
  const n = node.childForFieldName("name");
  if (!n) return null;
  return normalizeOneLine(source.slice(n.startIndex, n.endIndex)) || null;
}

function extractJsTsItems(root: TreeSitterNode, source: string): CodemapItem[] {
  const items: CodemapItem[] = [];

  for (const stmt of root.namedChildren) {
    if (
      stmt.type === "export_statement" ||
      stmt.type === "export_default_declaration"
    ) {
      const isDefault = stmt.type === "export_default_declaration";
      const inner =
        stmt.namedChildren.find((c) =>
          [
            "function_declaration",
            "class_declaration",
            "interface_declaration",
            "type_alias_declaration",
            "enum_declaration",
            "lexical_declaration",
            "variable_declaration",
          ].includes(c.type),
        ) ?? stmt.namedChildren[0];

      const name = inner ? nameFromNode(inner, source) : null;
      const signature = inner
        ? signatureForDeclaration(inner, source, {
            prefix: isDefault ? "export default " : "export ",
          })
        : truncateOneLine(
            normalizeOneLine(source.slice(stmt.startIndex, stmt.endIndex)),
          );

      items.push({
        kind: kindForNodeType(inner?.type ?? stmt.type),
        name,
        exported: true,
        signature,
      });
      continue;
    }

    if (
      stmt.type === "function_declaration" ||
      stmt.type === "class_declaration" ||
      stmt.type === "interface_declaration" ||
      stmt.type === "type_alias_declaration" ||
      stmt.type === "enum_declaration"
    ) {
      items.push({
        kind: kindForNodeType(stmt.type),
        name: nameFromNode(stmt, source),
        exported: false,
        signature: signatureForDeclaration(stmt, source),
      });
    }
  }

  return items;
}

function extractRustItems(root: TreeSitterNode, source: string): CodemapItem[] {
  const items: CodemapItem[] = [];

  for (const stmt of root.namedChildren) {
    if (
      stmt.type !== "function_item" &&
      stmt.type !== "struct_item" &&
      stmt.type !== "enum_item" &&
      stmt.type !== "trait_item" &&
      stmt.type !== "impl_item" &&
      stmt.type !== "type_item" &&
      stmt.type !== "mod_item" &&
      stmt.type !== "const_item" &&
      stmt.type !== "static_item"
    ) {
      continue;
    }

    const header = signatureForDeclaration(stmt, source);
    const exported = header.startsWith("pub ");
    items.push({
      kind: kindForNodeType(stmt.type),
      name: nameFromNode(stmt, source),
      exported,
      signature: header,
    });
  }

  return items;
}

function renderCodemap(lang: CodemapLanguage, items: CodemapItem[]): string {
  const lines: string[] = [];
  lines.push(`# Codemap (${languageLabel(lang)})`);

  const exports = items.filter((i) => i.exported);
  const others = items.filter((i) => !i.exported);

  if (exports.length > 0) {
    lines.push("", "## Exports");
    for (const item of exports) {
      lines.push(item.signature);
    }
  }

  if (others.length > 0) {
    lines.push("", "## Top-level");
    for (const item of others) {
      lines.push(item.signature);
    }
  }

  if (exports.length === 0 && others.length === 0) {
    lines.push("", "(no top-level declarations found)");
  }

  return `${lines.join("\n")}\n`;
}

export async function buildCodemapFromText(
  filePath: string,
  text: string,
): Promise<string> {
  const lang = detectCodemapLanguage(filePath);
  if (!lang) {
    return "# Codemap\n(not supported for this file type)\n";
  }

  const key = `${CODEMAP_VERSION}:${lang}:${hashText(text)}`;
  const cached = codemapCache.get(key);
  if (cached) {
    return cached;
  }

  const parser = await getParser(lang);
  const tree = parser.parse(text);
  const root = tree.rootNode;

  const items =
    lang === "rust"
      ? extractRustItems(root, text)
      : extractJsTsItems(root, text);

  const rendered = renderCodemap(lang, items);
  codemapCache.set(key, rendered);
  return rendered;
}
