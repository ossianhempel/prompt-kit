# prompt-kit
Open source Repo Prompt-style “context builder” tooling.

This repo currently implements **Milestones 0–7** from `plan.md`: monorepo scaffold + Compose UI (manual selection), presets, slices, optional git diff inclusion, codemap generation (API surface summaries), an Apply + Review flow for XML edits, and Discovery (fast “Suggest files” + a multi-step search/read/codemap loop under a token budget) driven by local CLI providers.

Key features (MVP):

- Open a folder as a workspace, browse/filter files, select a context set
- Discover: suggest relevant files (fast) or run a multi-step discovery loop (search/read/codemap + token budget) via CLI providers
- Per-file mode: `full` / `slices` / `codemap_only` (API only)
- Slice UX: click line numbers or enter ranges to add slices
- In-repo content search (daemon-backed)
- Presets: global + workspace scope (stored in `~/.promptkit/presets.json`, override with `PROMPTKIT_CONFIG_DIR`)
- Prompt builder options: file map, codemaps (`none|auto|complete`), git diffs (`none|selected|all_changed`)
- Apply + Review: paste XML edits, preview unified diffs, apply with checkpoints and undo (`~/.promptkit/checkpoints`)
- Providers (CLI): run the built prompt via `claude` (Claude Code) or `codex` (OpenAI Codex CLI)
- Browser handoff: copy prompt and open ChatGPT / Claude in your browser

## Repo layout

- `packages/core`: repo scanning / reading / search / prompt building helpers
- `packages/protocol`: shared zod schemas + JSON-RPC shapes
- `apps/daemon`: local HTTP JSON-RPC service (`/rpc`)
- `apps/mcp`: MCP stdio server (`promptkit-mcp`) that calls the daemon
- `apps/desktop`: Tauri + React desktop UI

## Getting started

```sh
pnpm install
pnpm build
pnpm typecheck
```

## Tests

```sh
pnpm test
pnpm test:unit
pnpm test:integration
pnpm test:coverage
```

## Run the daemon

```sh
pnpm --filter @prompt-kit/daemon dev
# or: node apps/daemon/dist/index.js --port=31337
```

RPC endpoint: `http://127.0.0.1:31337/rpc`

## Run the MCP server

Start the daemon first, then:

```sh
pnpm --filter @prompt-kit/mcp build
PROMPTKIT_DAEMON_URL=http://127.0.0.1:31337/rpc node apps/mcp/dist/cli.js
```

Tools exposed (MVP):

- `open_workspace`
- `get_file_tree`
- `read_file`
- `file_search`
- `get_code_structure`
- `manage_selection`
- `workspace_context`
- `get_git_status`
- `build_prompt`
- `discover_context`
- `preview_edits`
- `apply_edits`
- `undo_edits`

## Run the desktop app

Rust toolchain is required.

```sh
pnpm desktop
# or: pnpm --filter @prompt-kit/desktop tauri dev
```

To run the desktop app + daemon together in dev:

```sh
pnpm dev:desktop
```

The app will best-effort auto-start the daemon on launch. If it’s down, click **Start daemon** (it will build + launch the local Node daemon; requires `pnpm` + `node` in your PATH).

The **Discover** tab can either:
- Suggest files quickly (paths-only)
- Run a multi-step discovery agent that can search/read/codemap before producing a ready-to-paste prompt under a token budget

## Run prompts via CLI subscriptions (no API key copy/paste)

PromptKit can run the built prompt via your existing **Codex CLI** / **Claude Code** subscriptions by spawning the local CLIs.

- Codex CLI: authenticate with ChatGPT via `codex --login` (or `codex login`) and follow the Sign in with ChatGPT flow.
- Claude Code: ensure `claude` works in your terminal (you may need `claude setup-token`).
- If you launch the app from Finder and the provider buttons can’t find `codex`/`claude`, launch the app from a terminal so it inherits your shell `PATH`.
- Debugging: the desktop app writes daemon logs to `~/.promptkit/daemon.log` (override with `PROMPTKIT_CONFIG_DIR`). You can also override binaries via `PROMPTKIT_NODE`, `PROMPTKIT_PNPM`, `PROMPTKIT_CODEX_BIN`, `PROMPTKIT_CLAUDE_BIN`.
