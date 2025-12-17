import { normalizeRelativePath } from "./path.js";

export type XmlEdit =
  | { file: string; kind: "rewrite"; content: string }
  | { file: string; kind: "replace"; search: string; replacement: string };

export type PreviewEdit = {
  file: string;
  kind: XmlEdit["kind"];
  oldText: string;
  newText: string;
  unifiedDiff: string;
};

type ParsedXml = Record<string, unknown>;

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function getTextNode(value: unknown): string {
  if (typeof value === "string") return value;
  const obj = asRecord(value);
  const cdata = obj["#cdata"];
  if (typeof cdata === "string") return cdata;
  const text = obj["#text"];
  if (typeof text === "string") return text;
  return "";
}

async function parseXml(xml: string): Promise<ParsedXml> {
  const mod = (await import("fast-xml-parser")) as unknown as {
    XMLParser?: new (
      opts: Record<string, unknown>,
    ) => { parse: (x: string) => unknown };
    default?: unknown;
  };

  const XMLParser =
    mod.XMLParser ??
    (asRecord(mod.default).XMLParser as
      | (new (
          opts: Record<string, unknown>,
        ) => { parse: (x: string) => unknown })
      | undefined);

  if (!XMLParser) {
    throw new Error("fast-xml-parser unavailable");
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    textNodeName: "#text",
    cdataPropName: "#cdata",
    parseTagValue: false,
    trimValues: false,
    processEntities: false,
  });

  const result = parser.parse(xml);
  return asRecord(result);
}

export async function parseEditsXml(xml: string): Promise<XmlEdit[]> {
  const doc = await parseXml(xml);
  const root = asRecord(doc.edits ?? doc);
  const editsRaw = root.edit;
  const edits = asArray(editsRaw);
  if (edits.length === 0) {
    throw new Error(
      "No <edit> entries found (expected <edits><edit .../></edits>).",
    );
  }

  const parsed: XmlEdit[] = [];
  for (const item of edits) {
    const edit = asRecord(item);
    const fileRaw = edit["@_file"];
    const file =
      typeof fileRaw === "string" && fileRaw.trim().length > 0
        ? normalizeRelativePath(fileRaw.trim())
        : "";
    if (!file) {
      throw new Error("Each <edit> must include a non-empty file attribute.");
    }

    if (edit.rewrite !== undefined) {
      parsed.push({
        file,
        kind: "rewrite",
        content: getTextNode(edit.rewrite),
      });
      continue;
    }

    if (edit.replace !== undefined) {
      const replace = asRecord(edit.replace);
      const searchRaw = replace["@_search"];
      const search =
        typeof searchRaw === "string" && searchRaw.length > 0 ? searchRaw : "";
      if (!search) {
        throw new Error(`Missing search attribute for <replace> in ${file}.`);
      }
      parsed.push({
        file,
        kind: "replace",
        search,
        replacement: getTextNode(replace),
      });
      continue;
    }

    throw new Error(
      `Edit for ${file} must include exactly one of: <rewrite> or <replace>.`,
    );
  }

  return parsed;
}

export function applyEditToText(edit: XmlEdit, oldText: string): string {
  if (edit.kind === "rewrite") {
    return edit.content;
  }

  const search = edit.search;
  if (!search) {
    throw new Error("replace.search must be non-empty");
  }

  const firstIdx = oldText.indexOf(search);
  if (firstIdx < 0) {
    throw new Error(`Search string not found in ${edit.file}`);
  }
  const secondIdx = oldText.indexOf(search, firstIdx + search.length);
  if (secondIdx >= 0) {
    throw new Error(`Search string is not unique in ${edit.file}`);
  }

  return `${oldText.slice(0, firstIdx)}${edit.replacement}${oldText.slice(
    firstIdx + search.length,
  )}`;
}

export async function toUnifiedDiff(
  filePath: string,
  oldText: string,
  newText: string,
): Promise<string> {
  const mod = (await import("diff")) as unknown as {
    createTwoFilesPatch?: (
      oldFileName: string,
      newFileName: string,
      oldStr: string,
      newStr: string,
      oldHeader?: string,
      newHeader?: string,
      options?: { context?: number },
    ) => string;
    default?: unknown;
  };

  const createTwoFilesPatch =
    mod.createTwoFilesPatch ??
    (asRecord(mod.default).createTwoFilesPatch as
      | ((
          oldFileName: string,
          newFileName: string,
          oldStr: string,
          newStr: string,
          oldHeader?: string,
          newHeader?: string,
          options?: { context?: number },
        ) => string)
      | undefined);

  if (!createTwoFilesPatch) {
    throw new Error("diff unavailable");
  }

  return createTwoFilesPatch(filePath, filePath, oldText, newText, "", "", {
    context: 3,
  });
}
