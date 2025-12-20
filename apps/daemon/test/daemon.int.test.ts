import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

type JsonRpcResponse<T> = {
  jsonrpc: "2.0";
  id: string;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
};

function binPath(name: string): string {
  const ext = process.platform === "win32" ? ".cmd" : "";
  return path.join(process.cwd(), "node_modules", ".bin", `${name}${ext}`);
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      server.close(() => {
        if (!addr || typeof addr === "string") {
          reject(new Error("Failed to allocate port"));
          return;
        }
        resolve(addr.port);
      });
    });
  });
}

async function waitForHealth(url: string, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (true) {
    try {
      const res = await fetch(url, { method: "GET" });
      if (res.ok) {
        return;
      }
    } catch {
      // ignore
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for health: ${url}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

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
    throw new Error(`HTTP ${res.status}`);
  }
  const data = (await res.json()) as JsonRpcResponse<T>;
  if (data.error) {
    throw new Error(data.error.message);
  }
  if (data.result === undefined) {
    throw new Error("No result");
  }
  return data.result;
}

function writeExecutable(filePath: string, content: string): void {
  writeFileSync(filePath, content, { encoding: "utf8", mode: 0o755 });
}

function setupStubProviders(binDir: string, stateFile: string): void {
  mkdirSync(binDir, { recursive: true });

  const stubJs = path.join(binDir, "provider-stub.js");
  writeFileSync(
    stubJs,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "",
      "function readAllStdin() {",
      "  return new Promise((resolve) => {",
      "    let input = '';",
      "    process.stdin.setEncoding('utf8');",
      "    process.stdin.on('data', (c) => (input += c));",
      "    process.stdin.on('end', () => resolve(input));",
      "  });",
      "}",
      "",
      "function loadState(file) {",
      "  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }",
      "}",
      "function saveState(file, state) {",
      "  fs.mkdirSync(path.dirname(file), { recursive: true });",
      "  fs.writeFileSync(file, JSON.stringify(state), 'utf8');",
      "}",
      "",
      "function parseArgValue(args, flag) {",
      "  const idx = args.indexOf(flag);",
      "  if (idx < 0) return null;",
      "  return args[idx + 1] ?? null;",
      "}",
      "",
      "(async () => {",
      "  const argv = process.argv.slice(2);",
      "  const maybeCmd = argv[0];",
      "  const self = path.basename(process.argv[1] || '');",
      "  const cmd = (maybeCmd === 'codex' || maybeCmd === 'claude')",
      "    ? maybeCmd",
      "    : (self.startsWith('codex') ? 'codex' : self.startsWith('claude') ? 'claude' : '');",
      "  const args = (maybeCmd === 'codex' || maybeCmd === 'claude') ? argv.slice(1) : argv;",
      "  const isCodex = cmd === 'codex';",
      "  const isClaude = cmd === 'claude';",
      "  const input = await readAllStdin();",
      "  const stateFile = process.env.PROMPTKIT_STUB_STATE_FILE;",
      "  const state = stateFile ? loadState(stateFile) : {};",
      "",
      "  let output = '';",
      "  if (input.includes('You are PromptKit Discovery')) {",
      "    state.discoverCalls = (state.discoverCalls || 0) + 1;",
      "    if (state.discoverCalls === 1) {",
      "      output = JSON.stringify({ tool: 'get_code_structure', args: { path: 'src/main.ts' } });",
      "    } else {",
      "      output = JSON.stringify({ final: { instructions: 'Implement the task', selection: [{ path: 'src/main.ts', mode: 'full' }] } });",
      "    }",
      "  } else {",
      "    output = 'stub provider ok';",
      "  }",
      "",
      "  if (stateFile) saveState(stateFile, state);",
      "",
      "  if (isCodex) {",
      "    const outFile = parseArgValue(args, '--output-last-message');",
      "    if (outFile) {",
      "      fs.mkdirSync(path.dirname(outFile), { recursive: true });",
      "      fs.writeFileSync(outFile, output + '\\n', 'utf8');",
      "    } else {",
      "      process.stdout.write(output + '\\n');",
      "    }",
      "    process.exit(0);",
      "  }",
      "",
      "  if (isClaude) {",
      "    process.stdout.write(output + '\\n');",
      "    process.exit(0);",
      "  }",
      "",
      "  process.stderr.write('unknown stub command\\n');",
      "  process.exit(2);",
      "})();",
    ].join("\n"),
    { encoding: "utf8" },
  );

  if (process.platform === "win32") {
    writeFileSync(
      path.join(binDir, "codex.cmd"),
      `@echo off\r\nnode "${stubJs}" codex %*\r\n`,
      "utf8",
    );
    writeFileSync(
      path.join(binDir, "claude.cmd"),
      `@echo off\r\nnode "${stubJs}" claude %*\r\n`,
      "utf8",
    );
  } else {
    writeExecutable(
      path.join(binDir, "codex"),
      `#!/usr/bin/env node\nrequire(${JSON.stringify(stubJs)})\n`,
    );
    writeExecutable(
      path.join(binDir, "claude"),
      `#!/usr/bin/env node\nrequire(${JSON.stringify(stubJs)})\n`,
    );
  }
}

describe.sequential("daemon RPC (integration)", () => {
  let port = 0;
  let rpcUrl = "";
  let healthUrl = "";
  let proc: ReturnType<typeof spawn> | null = null;
  let workspaceRoot = "";
  let workspaceRoot2 = "";
  let configDir = "";
  let binDir = "";
  let stateFile = "";
  let workspaceId = "";
  let workspaceIdMulti = "";

  beforeAll(async () => {
    port = await getFreePort();
    rpcUrl = `http://127.0.0.1:${port}/rpc`;
    healthUrl = `http://127.0.0.1:${port}/health`;

    const base = path.join(
      os.tmpdir(),
      `promptkit-daemon-int-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    workspaceRoot = path.join(base, "workspace");
    workspaceRoot2 = path.join(base, "workspace2");
    configDir = path.join(base, "config");
    binDir = path.join(base, "bin");
    stateFile = path.join(base, "state.json");

    mkdirSync(workspaceRoot, { recursive: true });
    mkdirSync(path.join(workspaceRoot, "src"), { recursive: true });
    writeFileSync(
      path.join(workspaceRoot, "src", "main.ts"),
      "export function greet(name: string) { return `hi ${name}` }\n",
      "utf8",
    );
    writeFileSync(
      path.join(workspaceRoot, "hello.txt"),
      "one\ntwo\nneedle here\n",
      "utf8",
    );

    mkdirSync(workspaceRoot2, { recursive: true });
    mkdirSync(path.join(workspaceRoot2, "lib"), { recursive: true });
    writeFileSync(
      path.join(workspaceRoot2, "lib", "util.ts"),
      "export const answer = 42;\n",
      "utf8",
    );
    writeFileSync(
      path.join(workspaceRoot2, "notes.md"),
      "multi-root needle\n",
      "utf8",
    );

    setupStubProviders(binDir, stateFile);

    const env = {
      ...process.env,
      PROMPTKIT_CONFIG_DIR: configDir,
      PROMPTKIT_STUB_STATE_FILE: stateFile,
      PATH:
        process.platform === "win32"
          ? `${binDir};${process.env.PATH ?? ""}`
          : `${binDir}:${process.env.PATH ?? ""}`,
    };

    proc = spawn(
      binPath("tsx"),
      ["apps/daemon/src/index.ts", `--port=${port}`],
      {
        cwd: process.cwd(),
        env,
        stdio: "pipe",
      },
    );

    await waitForHealth(healthUrl);
  });

  afterAll(async () => {
    if (proc && proc.exitCode === null) {
      proc.kill();
      await new Promise((r) => setTimeout(r, 250));
    }
    try {
      rmSync(path.dirname(workspaceRoot), { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("opens a workspace and reads/searches files", async () => {
    const opened = await rpc<{ workspaceId: string }>(
      rpcUrl,
      "workspace.open",
      {
        root: workspaceRoot,
      },
    );
    workspaceId = opened.workspaceId;
    expect(workspaceId.length).toBeGreaterThan(0);

    const tree = await rpc<{ files: { path: string }[] }>(
      rpcUrl,
      "workspace.getFileTree",
      { workspaceId },
    );
    const paths = tree.files.map((f) => f.path);
    expect(paths).toContain("hello.txt");
    expect(paths).toContain("src/main.ts");

    const file = await rpc<{ path: string; content: string }>(
      rpcUrl,
      "workspace.readFile",
      { workspaceId, path: "hello.txt" },
    );
    expect(file.content).toContain("needle here");

    const search = await rpc<{ matches: { path: string; line: number }[] }>(
      rpcUrl,
      "workspace.search",
      { workspaceId, query: "needle", limit: 10 },
    );
    expect(search.matches.length).toBeGreaterThan(0);
    expect(search.matches[0]?.path).toBe("hello.txt");
    expect(search.matches[0]?.line).toBe(3);
  });

  it("builds codemaps via workspace.getCodeStructure", async () => {
    const result = await rpc<{ path: string; codemap: string }>(
      rpcUrl,
      "workspace.getCodeStructure",
      { workspaceId, path: "src/main.ts" },
    );
    expect(result.path).toBe("src/main.ts");
    expect(result.codemap.toLowerCase()).toContain("function");
  });

  it("runs providers.run via stubbed Codex CLI", async () => {
    const result = await rpc<{
      output: string;
      exitCode: number;
      stderr?: string;
    }>(rpcUrl, "providers.run", {
      workspaceId,
      provider: "codex_cli",
      prompt: "hello from test",
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("stub provider ok");
    expect(result.stderr).toBeUndefined();
  });

  it("runs workspace.discover and updates selection", async () => {
    const result = await rpc<{
      selection: { path: string; mode: string }[];
      tokenEstimate: number;
      handoff: string;
      log: string[];
    }>(rpcUrl, "workspace.discover", {
      workspaceId,
      task: "understand the repo and pick relevant files",
      provider: "codex_cli",
      maxSteps: 6,
      maxFiles: 10,
      tokenBudget: 10_000,
    });

    expect(result.selection).toEqual([{ path: "src/main.ts", mode: "full" }]);
    expect(result.tokenEstimate).toBeGreaterThan(10);
    expect(result.handoff).toContain("<file_contents>");
    expect(result.log.join("\n")).toContain("tool call");

    const selection = await rpc<{ selection: { path: string }[] }>(
      rpcUrl,
      "workspace.getSelection",
      { workspaceId },
    );
    expect(selection.selection.map((s) => s.path)).toContain("src/main.ts");
  });

  it("streams discovery progress via discoverStart/discoverStatus", async () => {
    const start = await rpc<{ runId: string; status: string; log: string[] }>(
      rpcUrl,
      "workspace.discoverStart",
      {
        workspaceId,
        task: "understand the repo and pick relevant files",
        provider: "codex_cli",
        maxSteps: 6,
        maxFiles: 10,
        tokenBudget: 10_000,
      },
    );
    expect(start.status).toBe("running");
    expect(start.runId.length).toBeGreaterThan(0);

    let status: {
      status: string;
      log: string[];
      selection?: { path: string; mode: string }[];
      tokenEstimate?: number;
      handoff?: string;
    } | null = null;

    for (let i = 0; i < 20; i++) {
      status = await rpc<{
        status: string;
        log: string[];
        selection?: { path: string; mode: string }[];
        tokenEstimate?: number;
        handoff?: string;
      }>(rpcUrl, "workspace.discoverStatus", { runId: start.runId });

      if (status.status !== "running") {
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(status?.status).toBe("complete");
    expect(status?.selection).toEqual([
      { path: "src/main.ts", mode: "full" },
    ]);
    expect(status?.tokenEstimate ?? 0).toBeGreaterThan(10);
    expect(status?.handoff ?? "").toContain("<file_contents>");
    expect(status?.log.join("\n") ?? "").toContain("step");
  });

  it("applies and undoes edits with checkpoints", async () => {
    const xml = [
      "<edits>",
      '  <edit file="hello.txt">',
      "    <rewrite><![CDATA[changed]]></rewrite>",
      "  </edit>",
      "</edits>",
    ].join("\n");

    const applied = await rpc<{ ok: true; checkpointId: string }>(
      rpcUrl,
      "workspace.applyEdits",
      { workspaceId, xml },
    );
    expect(applied.ok).toBe(true);

    const changed = await rpc<{ content: string }>(
      rpcUrl,
      "workspace.readFile",
      {
        workspaceId,
        path: "hello.txt",
      },
    );
    expect(changed.content).toBe("changed");

    const undone = await rpc<{ ok: true }>(rpcUrl, "workspace.undoEdits", {
      workspaceId,
      checkpointId: applied.checkpointId,
    });
    expect(undone.ok).toBe(true);

    const restored = await rpc<{ content: string }>(
      rpcUrl,
      "workspace.readFile",
      { workspaceId, path: "hello.txt" },
    );
    expect(restored.content).toContain("needle here");
  });

  it("supports multi-root workspaces", async () => {
    const opened = await rpc<{ workspaceId: string }>(
      rpcUrl,
      "workspace.open",
      {
        roots: [workspaceRoot, workspaceRoot2],
      },
    );
    workspaceIdMulti = opened.workspaceId;
    expect(workspaceIdMulti.length).toBeGreaterThan(0);

    const tree = await rpc<{ files: { path: string }[] }>(
      rpcUrl,
      "workspace.getFileTree",
      { workspaceId: workspaceIdMulti },
    );
    const paths = tree.files.map((f) => f.path);
    expect(paths).toContain("workspace/hello.txt");
    expect(paths).toContain("workspace/src/main.ts");
    expect(paths).toContain("workspace2/notes.md");
    expect(paths).toContain("workspace2/lib/util.ts");

    const file = await rpc<{ path: string; content: string }>(
      rpcUrl,
      "workspace.readFile",
      { workspaceId: workspaceIdMulti, path: "workspace2/notes.md" },
    );
    expect(file.content).toContain("multi-root needle");

    const search = await rpc<{ matches: { path: string; line: number }[] }>(
      rpcUrl,
      "workspace.search",
      { workspaceId: workspaceIdMulti, query: "needle", limit: 10 },
    );
    const searchPaths = search.matches.map((m) => m.path);
    expect(searchPaths).toContain("workspace/hello.txt");
    expect(searchPaths).toContain("workspace2/notes.md");

    const codemap = await rpc<{ path: string; codemap: string }>(
      rpcUrl,
      "workspace.getCodeStructure",
      { workspaceId: workspaceIdMulti, path: "workspace2/lib/util.ts" },
    );
    expect(codemap.path).toBe("workspace2/lib/util.ts");
    expect(codemap.codemap.toLowerCase()).toContain("const");

    const prompt = await rpc<{ prompt: string }>(
      rpcUrl,
      "workspace.buildPrompt",
      {
        workspaceId: workspaceIdMulti,
        selection: [{ path: "workspace2/lib/util.ts", mode: "full" }],
        includeFileMap: true,
      },
    );
    expect(prompt.prompt).toContain("workspace2/lib/util.ts");
  });
});
