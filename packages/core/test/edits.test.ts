import { describe, expect, it } from "vitest";

import { applyEditToText, parseEditsXml, toUnifiedDiff } from "../src/edits.js";

describe("XML edits", () => {
  it("parses rewrite and replace edits", async () => {
    const xml = [
      "<edits>",
      '  <edit file="src/a.ts">',
      "    <rewrite><![CDATA[console.log('hi');]]></rewrite>",
      "  </edit>",
      '  <edit file="src/b.ts">',
      '    <replace search="OLD"><![CDATA[NEW]]></replace>',
      "  </edit>",
      "</edits>",
    ].join("\n");

    const edits = await parseEditsXml(xml);
    expect(edits).toEqual([
      { file: "src/a.ts", kind: "rewrite", content: "console.log('hi');" },
      { file: "src/b.ts", kind: "replace", search: "OLD", replacement: "NEW" },
    ]);
  });

  it("applyEditToText replace requires a unique match", () => {
    expect(() =>
      applyEditToText(
        { file: "x.txt", kind: "replace", search: "A", replacement: "B" },
        "A A",
      ),
    ).toThrow(/not unique/i);
  });

  it("toUnifiedDiff produces a patch", async () => {
    const diff = await toUnifiedDiff("a.txt", "hello\n", "hello world\n");
    expect(diff).toContain("--- a.txt");
    expect(diff).toContain("+++ a.txt");
    expect(diff).toContain("+hello world");
  });
});
