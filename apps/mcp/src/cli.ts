import { randomUUID } from "node:crypto";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const DAEMON_URL =
  process.env.PROMPTKIT_DAEMON_URL ?? "http://127.0.0.1:31337/rpc";

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

async function callDaemon(method: string, params: unknown): Promise<unknown> {
  const res = await fetch(DAEMON_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }),
  });

  if (!res.ok) {
    throw new Error(`Daemon HTTP ${res.status}`);
  }

  const data = (await res.json()) as JsonRpcResponse;
  if (data.error) {
    throw new Error(data.error.message);
  }
  return data.result;
}

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

let currentWorkspaceId: string | null = null;

const server = new Server(
  { name: "promptkit-mcp", version: "0.0.0" },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "open_workspace",
        description:
          "Open a local folder as the active workspace (daemon-backed).",
        inputSchema: {
          type: "object",
          properties: {
            root: {
              type: "string",
              description: "Absolute path to workspace root.",
            },
            roots: {
              type: "array",
              items: { type: "string" },
              description:
                "Absolute paths to workspace roots (multi-root workspace).",
            },
          },
          additionalProperties: false,
        },
      },
      {
        name: "get_file_tree",
        description: "List files in the active workspace.",
        inputSchema: {
          type: "object",
          properties: {
            workspaceId: {
              type: "string",
              description: "Optional override workspace id.",
            },
          },
          additionalProperties: false,
        },
      },
      {
        name: "read_file",
        description: "Read a file (optionally with line slices).",
        inputSchema: {
          type: "object",
          properties: {
            workspaceId: {
              type: "string",
              description: "Optional override workspace id.",
            },
            path: {
              type: "string",
              description:
                "Path relative to the workspace root (prefix with root folder name when multiple roots are open).",
            },
            slices: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  startLine: { type: "integer" },
                  endLine: { type: "integer" },
                  description: { type: "string" },
                },
                required: ["startLine", "endLine"],
                additionalProperties: false,
              },
            },
          },
          required: ["path"],
          additionalProperties: false,
        },
      },
      {
        name: "file_search",
        description: "Search for a string in workspace text files.",
        inputSchema: {
          type: "object",
          properties: {
            workspaceId: {
              type: "string",
              description: "Optional override workspace id.",
            },
            query: { type: "string" },
            limit: { type: "integer" },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
      {
        name: "get_code_structure",
        description: "Get a codemap/API surface summary for a file.",
        inputSchema: {
          type: "object",
          properties: {
            workspaceId: {
              type: "string",
              description: "Optional override workspace id.",
            },
            path: {
              type: "string",
              description:
                "Path relative to the workspace root (prefix with root folder name when multiple roots are open).",
            },
          },
          required: ["path"],
          additionalProperties: false,
        },
      },
      {
        name: "manage_selection",
        description:
          "Manage the daemon's selection set for the active workspace (set/add/remove/clear).",
        inputSchema: {
          type: "object",
          properties: {
            workspaceId: {
              type: "string",
              description: "Optional override workspace id.",
            },
            operation: {
              type: "string",
              enum: ["set", "add", "remove", "clear"],
            },
            entries: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  path: {
                    type: "string",
                    description:
                      "Path relative to the workspace root (prefix with root folder name when multiple roots are open).",
                  },
                  mode: {
                    type: "string",
                    enum: ["full", "slices", "codemap_only"],
                  },
                  slices: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        startLine: { type: "integer" },
                        endLine: { type: "integer" },
                        description: { type: "string" },
                      },
                      required: ["startLine", "endLine"],
                      additionalProperties: false,
                    },
                  },
                },
                required: ["path"],
                additionalProperties: false,
              },
            },
          },
          required: ["operation"],
          additionalProperties: false,
        },
      },
      {
        name: "workspace_context",
        description:
          "Get the daemon's current workspace context (file count, selection, root).",
        inputSchema: {
          type: "object",
          properties: {
            workspaceId: {
              type: "string",
              description: "Optional override workspace id.",
            },
          },
          additionalProperties: false,
        },
      },
      {
        name: "build_prompt",
        description: "Build a copy/paste prompt from the current selection.",
        inputSchema: {
          type: "object",
          properties: {
            workspaceId: {
              type: "string",
              description: "Optional override workspace id.",
            },
            selection: {
              description:
                "Optional override selection (otherwise uses daemon state).",
              type: "array",
              items: {
                type: "object",
                properties: {
                  path: { type: "string" },
                  mode: {
                    type: "string",
                    enum: ["full", "slices", "codemap_only"],
                  },
                  slices: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        startLine: { type: "integer" },
                        endLine: { type: "integer" },
                        description: { type: "string" },
                      },
                      required: ["startLine", "endLine"],
                      additionalProperties: false,
                    },
                  },
                },
                required: ["path"],
                additionalProperties: false,
              },
            },
            instructions: { type: "string" },
            includeFileMap: { type: "boolean" },
            gitDiffMode: {
              type: "string",
              enum: ["none", "selected", "all_changed"],
            },
            codemapMode: {
              type: "string",
              enum: ["none", "auto", "complete"],
            },
          },
          additionalProperties: false,
        },
      },
      {
        name: "discover_context",
        description:
          "Run the PromptKit discovery agent (search/read/codemap + token budget) to produce a ready-to-paste prompt and selection.",
        inputSchema: {
          type: "object",
          properties: {
            workspaceId: {
              type: "string",
              description: "Optional override workspace id.",
            },
            task: { type: "string", description: "What you want to do." },
            provider: {
              type: "string",
              enum: ["claude_code_cli", "codex_cli"],
              description:
                "Which local CLI subscription to use for the discovery loop.",
            },
            model: { type: "string", description: "Optional model override." },
            maxSteps: { type: "integer" },
            maxFiles: { type: "integer" },
            tokenBudget: { type: "integer" },
          },
          required: ["task"],
          additionalProperties: false,
        },
      },
      {
        name: "get_git_status",
        description:
          "Get git status for the active workspace (isRepo + changed files).",
        inputSchema: {
          type: "object",
          properties: {
            workspaceId: {
              type: "string",
              description: "Optional override workspace id.",
            },
          },
          additionalProperties: false,
        },
      },
      {
        name: "preview_edits",
        description:
          "Preview XML edits (no writes): parses edits and returns unified diffs.",
        inputSchema: {
          type: "object",
          properties: {
            workspaceId: {
              type: "string",
              description: "Optional override workspace id.",
            },
            xml: {
              type: "string",
              description: "XML edits payload (<edits>...</edits>).",
            },
          },
          required: ["xml"],
          additionalProperties: false,
        },
      },
      {
        name: "apply_edits",
        description:
          "Apply XML edits to the workspace (writes files, creates a checkpoint).",
        inputSchema: {
          type: "object",
          properties: {
            workspaceId: {
              type: "string",
              description: "Optional override workspace id.",
            },
            xml: {
              type: "string",
              description: "XML edits payload (<edits>...</edits>).",
            },
            files: {
              type: "array",
              items: { type: "string" },
              description:
                "Optional subset of edit file paths to apply (defaults to all edits).",
            },
          },
          required: ["xml"],
          additionalProperties: false,
        },
      },
      {
        name: "undo_edits",
        description:
          "Undo the last applied edits by restoring from the latest checkpoint (or a specific checkpointId).",
        inputSchema: {
          type: "object",
          properties: {
            workspaceId: {
              type: "string",
              description: "Optional override workspace id.",
            },
            checkpointId: {
              type: "string",
              description: "Optional checkpoint id to restore.",
            },
          },
          additionalProperties: false,
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: rawArgs } = request.params;
  const args = asObject(rawArgs);

  const workspaceId =
    typeof args.workspaceId === "string"
      ? args.workspaceId
      : (currentWorkspaceId ?? undefined);

  function requireWorkspaceId(): string {
    if (!workspaceId) {
      throw new Error("No workspace open. Call open_workspace first.");
    }
    return workspaceId;
  }

  try {
    switch (name) {
      case "open_workspace": {
        const root =
          typeof args.root === "string" ? args.root.trim() : "";
        const roots = Array.isArray(args.roots)
          ? args.roots
              .filter((r) => typeof r === "string")
              .map((r) => r.trim())
              .filter((r) => r.length > 0)
          : [];
        if (!root && roots.length === 0) {
          throw new Error("Provide root or roots.");
        }
        const result = await callDaemon(
          "workspace.open",
          roots.length > 0 ? { roots } : { root },
        );
        const parsed = asObject(result);
        const id = parsed.workspaceId;
        if (typeof id !== "string" || id.length === 0) {
          throw new Error("Daemon returned invalid workspaceId");
        }
        currentWorkspaceId = id;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ workspaceId: id }, null, 2),
            },
          ],
        };
      }

      case "get_file_tree": {
        const result = await callDaemon("workspace.getFileTree", {
          workspaceId: requireWorkspaceId(),
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "read_file": {
        const p = args.path;
        if (typeof p !== "string" || p.trim().length === 0) {
          throw new Error("path must be a non-empty string");
        }
        const slices = Array.isArray(args.slices) ? args.slices : undefined;
        const result = await callDaemon("workspace.readFile", {
          workspaceId: requireWorkspaceId(),
          path: p,
          ...(slices ? { slices } : {}),
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "file_search": {
        const q = args.query;
        if (typeof q !== "string" || q.trim().length === 0) {
          throw new Error("query must be a non-empty string");
        }
        const limit = typeof args.limit === "number" ? args.limit : undefined;
        const result = await callDaemon("workspace.search", {
          workspaceId: requireWorkspaceId(),
          query: q,
          ...(limit ? { limit } : {}),
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "get_code_structure": {
        const p = args.path;
        if (typeof p !== "string" || p.trim().length === 0) {
          throw new Error("path must be a non-empty string");
        }
        const result = await callDaemon("workspace.getCodeStructure", {
          workspaceId: requireWorkspaceId(),
          path: p,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "manage_selection": {
        const op = args.operation;
        if (op !== "set" && op !== "add" && op !== "remove" && op !== "clear") {
          throw new Error("operation must be one of: set, add, remove, clear");
        }

        const entries = Array.isArray(args.entries)
          ? args.entries.map((e) => asObject(e))
          : undefined;

        const workspaceId = requireWorkspaceId();

        if (op === "clear") {
          const result = await callDaemon("workspace.setSelection", {
            workspaceId,
            selection: [],
          });
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        }

        if (!entries || entries.length === 0) {
          throw new Error("entries is required for set/add/remove");
        }

        if (op === "set") {
          const result = await callDaemon("workspace.setSelection", {
            workspaceId,
            selection: entries,
          });
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        }

        const current = asObject(
          await callDaemon("workspace.getSelection", { workspaceId }),
        );
        const currentSelection = Array.isArray(current.selection)
          ? current.selection
          : [];

        const byPath = new Map<string, unknown>();
        for (const e of currentSelection) {
          const obj = asObject(e);
          const p = obj.path;
          if (typeof p === "string" && p.length > 0) {
            byPath.set(p, obj);
          }
        }

        if (op === "add") {
          for (const e of entries) {
            const p = e.path;
            if (typeof p === "string" && p.length > 0) {
              byPath.set(p, e);
            }
          }
        }

        if (op === "remove") {
          for (const e of entries) {
            const p = e.path;
            if (typeof p === "string" && p.length > 0) {
              byPath.delete(p);
            }
          }
        }

        const nextSelection = [...byPath.values()];
        const result = await callDaemon("workspace.setSelection", {
          workspaceId,
          selection: nextSelection,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { result, selectionCount: nextSelection.length },
                null,
                2,
              ),
            },
          ],
        };
      }

      case "workspace_context": {
        const result = await callDaemon("workspace.getContext", {
          workspaceId: requireWorkspaceId(),
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "build_prompt": {
        const selection = Array.isArray(args.selection)
          ? args.selection.map((e) => asObject(e))
          : undefined;
        const instructions =
          typeof args.instructions === "string" ? args.instructions : undefined;
        const includeFileMap =
          typeof args.includeFileMap === "boolean"
            ? args.includeFileMap
            : undefined;
        const gitDiffMode =
          args.gitDiffMode === "none" ||
          args.gitDiffMode === "selected" ||
          args.gitDiffMode === "all_changed"
            ? args.gitDiffMode
            : undefined;
        const codemapMode =
          args.codemapMode === "none" ||
          args.codemapMode === "auto" ||
          args.codemapMode === "complete"
            ? args.codemapMode
            : undefined;

        const result = await callDaemon("workspace.buildPrompt", {
          workspaceId: requireWorkspaceId(),
          ...(selection ? { selection } : {}),
          ...(instructions === undefined ? {} : { instructions }),
          ...(includeFileMap === undefined ? {} : { includeFileMap }),
          ...(gitDiffMode === undefined ? {} : { gitDiffMode }),
          ...(codemapMode === undefined ? {} : { codemapMode }),
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "discover_context": {
        const task = args.task;
        if (typeof task !== "string" || task.trim().length === 0) {
          throw new Error("task must be a non-empty string");
        }
        const provider =
          args.provider === "codex_cli" || args.provider === "claude_code_cli"
            ? args.provider
            : "claude_code_cli";
        const model = typeof args.model === "string" ? args.model : undefined;
        const maxSteps =
          typeof args.maxSteps === "number" ? args.maxSteps : undefined;
        const maxFiles =
          typeof args.maxFiles === "number" ? args.maxFiles : undefined;
        const tokenBudget =
          typeof args.tokenBudget === "number" ? args.tokenBudget : undefined;

        const result = await callDaemon("workspace.discover", {
          workspaceId: requireWorkspaceId(),
          task: task.trim(),
          provider,
          ...(model?.trim() ? { model: model.trim() } : {}),
          ...(maxSteps === undefined ? {} : { maxSteps }),
          ...(maxFiles === undefined ? {} : { maxFiles }),
          ...(tokenBudget === undefined ? {} : { tokenBudget }),
        });

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "get_git_status": {
        const result = await callDaemon("workspace.getGitStatus", {
          workspaceId: requireWorkspaceId(),
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "preview_edits": {
        const xml = args.xml;
        if (typeof xml !== "string" || xml.trim().length === 0) {
          throw new Error("xml must be a non-empty string");
        }
        const result = await callDaemon("workspace.previewEdits", {
          workspaceId: requireWorkspaceId(),
          xml,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "apply_edits": {
        const xml = args.xml;
        if (typeof xml !== "string" || xml.trim().length === 0) {
          throw new Error("xml must be a non-empty string");
        }
        const files = Array.isArray(args.files) ? args.files : undefined;
        const result = await callDaemon("workspace.applyEdits", {
          workspaceId: requireWorkspaceId(),
          xml,
          ...(files ? { files } : {}),
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "undo_edits": {
        const checkpointId =
          typeof args.checkpointId === "string" &&
          args.checkpointId.trim().length > 0
            ? args.checkpointId.trim()
            : undefined;
        const result = await callDaemon("workspace.undoEdits", {
          workspaceId: requireWorkspaceId(),
          ...(checkpointId ? { checkpointId } : {}),
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return {
      content: [
        { type: "text", text: JSON.stringify({ error: message }, null, 2) },
      ],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
