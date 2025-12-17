import { describe, expect, it } from "vitest";

import {
  DaemonMethodSchema,
  DiscoverParamsSchema,
  GetCodeStructureParamsSchema,
  ProviderIdSchema,
  SelectionEntrySchema,
} from "../src/index.js";

describe("protocol schemas", () => {
  it("rejects slices mode without slices", () => {
    const parsed = SelectionEntrySchema.safeParse({
      path: "a.txt",
      mode: "slices",
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts provider ids", () => {
    expect(ProviderIdSchema.parse("codex_cli")).toBe("codex_cli");
    expect(ProviderIdSchema.parse("claude_code_cli")).toBe("claude_code_cli");
  });

  it("includes key daemon methods", () => {
    expect(DaemonMethodSchema.parse("workspace.discover")).toBe(
      "workspace.discover",
    );
    expect(DaemonMethodSchema.parse("workspace.getCodeStructure")).toBe(
      "workspace.getCodeStructure",
    );
  });

  it("validates discover params", () => {
    const parsed = DiscoverParamsSchema.parse({
      workspaceId: "w1",
      task: "do thing",
      provider: "codex_cli",
      maxSteps: 3,
      maxFiles: 10,
      tokenBudget: 1000,
    });
    expect(parsed.workspaceId).toBe("w1");
  });

  it("validates code structure params", () => {
    const parsed = GetCodeStructureParamsSchema.parse({
      workspaceId: "w1",
      path: "src/main.ts",
    });
    expect(parsed.path).toBe("src/main.ts");
  });
});
