Got it - I've updated the task accordingly.

## Implementation status (this repo)

* Implemented: Milestones 0–6 (Compose, presets, slices, git diff inclusion, codemaps, Apply + Review)
* Implemented: Milestone 7 “Discovery” (tool-calling loop: search/read/codemap + token budget) and a fast **Suggest files** helper
* Implemented: CLI providers (Codex CLI + Claude Code), and browser handoff (copy prompt + open ChatGPT/Claude)
* Implemented: In-repo content search in the desktop UI (daemon-backed)
* Implemented: Unit + integration test suite (Vitest) + dev scripts (`pnpm check`, `pnpm test:coverage`)
* Implemented: “bundle-first” desktop packaging (no PATH / pnpm required)


Below is a concrete, buildable plan for **PromptKit** (Repo Prompt style app) using **Tauri + React** for the desktop UI and a **Node.js MCP server**. I’ll ground this in what Repo Prompt emphasizes (discovery first, token-efficient context, reviewable diffs) plus what you can reuse from **PasteMax** (file tree, token counting, search, watcher, exclusions). ([Repo Prompt][1])

## 1) What PromptKit should do first (scope aligned to the 4 core features)

Repo Prompt’s core idea is: spend effort curating the right context up front, then plan/execute with fewer iterations because the model is not “orienting” itself inside the expensive context window. ([Repo Prompt][1])

For PromptKit, define these as your “non-negotiable” pillars:

### A. Building context (overview)

* Open one or more folders into a workspace (multi-root)
* Show a file tree + search
* Let the user select files into a “context set”
* Control representation per file:

  * Full content
  * Line slices (selected ranges)
  * Codemap-only (API surface)
* Show token estimates (per file and total)
* Generate a single “copy prompt” blob with:

  * Instructions
  * File tree (configurable)
  * Codemaps (configurable)
  * Selected file contents or slices
  * Optional git diffs

### B. Presets (most important UX accelerator)

A preset should restore a complete “context configuration”:

* Selection set + per-file modes
* Prompt system text + user instructions
* Tree mode (auto/full/selected/none)
* Codemap mode (none/auto/complete)
* Git diff inclusion rules
* Output format (Standard, Plan, XML Edit, Diff Follow-up, MCP presets)

### C. Workflows (overview)

PromptKit should make the “right way” the easy way:

* Manual selection workflow (quick tasks)
* Discovery workflow (Context Builder) for anything non-trivial
* Plan workflow (architectural plan)
* Edit workflow (XML output) + Apply + review diffs

### D. Discovery (Context Builder)

Implement an agent that:

* explores the repo
* selects relevant files
* uses codemaps and slices to fit a token budget
* produces a factual “handoff prompt” that clarifies scope and relationships
  Repo Prompt’s blog calls out why this is important (effective context windows vs advertised, and the “agent orientation” cost). ([Repo Prompt][1])

Everything else (delegate agents, benchmarks, etc.) can come after these.

## 2) Architecture that fits Tauri + React + Node MCP server

The cleanest architecture (and easiest to evolve) is a 3-part system:

### 2.1 Desktop app (Tauri + React)

* **React UI**: Compose, Context Builder, Apply, Review, Settings
* **Tauri Rust layer**: OS integration only (open dialogs, safe file permissions, packaging, auto-update later)
* Starts and supervises a local Node “daemon” process on launch

### 2.2 Node “daemon” (local backend)

A long-running local service that owns the heavy lifting:

* repository scanning, ignore handling, file watchers
* indexing (paths, sizes, language detection)
* token counting + prompt assembly
* codemap generation (tree-sitter)
* git diff extraction
* XML parsing + patch/diff generation + apply with checkpointing
* persistent state (workspaces, presets, prompts)

Expose an internal RPC interface to the UI:

* recommended: **Unix domain socket RPC** or **localhost HTTP + WebSocket**
* Use WebSocket for events (file watcher updates, discovery progress)

### 2.3 Node MCP “bridge” CLI

External tools (Claude Code, Cursor, etc.) need a stdio-launched MCP server.
Following MCP conventions, your MCP entrypoint should be a CLI executable that speaks JSON-RPC over stdio. The MCP docs explicitly warn not to log to stdout for stdio servers. ([Model Context Protocol][2])

So:

* `promptkit-mcp` (Node CLI) runs as the MCP server
* it connects to the running daemon (unix socket)
* it proxies MCP tool calls into daemon operations
* the daemon then manipulates PromptKit state

This mirrors Repo Prompt’s “app + MCP server” shape, but in your chosen stack.

## 3) Reuse plan from PasteMax (what you can lift almost directly)

PasteMax already gives you a lot of the “Compose” foundation:

* file tree navigation, search, sorting, preview pane
* token counting + model context limit selection
* smart exclusions (.gitignore-like patterns), binary detection
* watcher-based refresh
* workspace manager concept
  It’s built with Electron + React + TS, and uses libraries you can keep (tiktoken, ignore, chokidar). ([GitHub][3])

### What to reuse with minimal rewrite

* Most **React components** for:

  * file tree UI, preview UI, selection list, token count display
* Most **backend logic concepts**:

  * ignore patterns, excluded-file rules, watcher logic, token counter logic
* Most **data models** (workspace, selected files, settings)

### What you will rewrite or adapt

* Electron IPC becomes:

  * UI <-> Node daemon RPC (socket/HTTP)
* Packaging and app lifecycle becomes Tauri
* Add Repo Prompt-specific features:

  * per-file modes (full/codemap/slices)
  * codemap generation
  * presets that include more than “workspace”
  * Apply/Review workflow for edits
  * MCP server toolset

Think of PasteMax as “PromptKit Compose MVP seed”.

## 4) Step-by-step build plan (milestones with clear deliverables)

### Milestone 0: Repo + workspace scaffolding

**Goal:** set up a monorepo that supports shared types, local daemon, MCP CLI, and Tauri UI.

**Deliverables**

* Monorepo (pnpm workspaces or npm workspaces):

  * `apps/desktop` (Tauri + React)
  * `apps/daemon` (Node service)
  * `apps/mcp` (Node MCP CLI)
  * `packages/core` (shared TS logic)
  * `packages/protocol` (shared types + zod schemas)
* Shared lint/format config, CI, release scripts

### Milestone 1: PromptKit “Compose” vertical slice (manual selection)

**Goal:** user can open a folder, select files, see token count, copy prompt.

**UI**

* Left: workspace picker + file tree + search
* Main: Instructions box + Selected Files panel
* Bottom bar: token counter + “Copy Prompt”

**Backend**

* Scan workspace:

  * respect `.gitignore` + additional “smart exclusions”
  * detect binaries
* Build prompt output:

  * include `<file_map>` + `<file_contents>` style sections (your own format)
* Token counting:

  * accurate-ish tokens for the exact output format (not raw file text)

**Acceptance checks**

* Selecting files updates total token estimate immediately
* Copy prompt matches exactly what token counter counted
* One-click handoff to web UIs (copy + open ChatGPT/Claude)
* Works on large-ish repos without UI freezing (use virtualization)

This is where PasteMax reuse pays off most. ([GitHub][3])

### Milestone 2: Presets (core feature)

**Goal:** “Presets” fully restore context configuration, not just files.

**Data model**

* `Preset` includes:

  * `name`, `description`
  * `systemPromptId` (optional)
  * `userInstructions`
  * `treeMode` (auto/full/selected/none)
  * `gitDiffMode` (none/selected/all changed)
  * `codemapMode` (none/auto/complete)
  * `selection` (paths + mode + slices)
  * `outputFormat` (standard/plan/xml_edit/diff_followup/mcp_pair/mcp_discover)
* Store presets:

  * global presets
  * workspace presets

**UI**

* Presets dropdown (like Repo Prompt)
* Save current as preset
* Update preset

**Acceptance checks**

* Loading a preset restores selection + instructions + formatting toggles exactly
* Presets are stable across app restarts

### Milestone 3: File modes: Full vs Slices (and basic slicing UX)

**Goal:** per-file “mode” is real and survives prompts/presets.

**Backend**

* `SelectionEntry` supports:

  * `mode: "full" | "slices" | "codemap_only"`
  * `slices: [{startLine, endLine, description?}]`
* Prompt builder renders:

  * Full file content if mode is full
  * Only those line ranges if slices

**UI**

* Selected file row shows:

  * mode tag
  * slice ranges if present
* Add “Create slice” flow:

  * MVP: in file preview, user highlights lines and clicks “Add slice”
  * Later: slices created by Context Builder and MCP tools

**Acceptance checks**

* Slice output includes line numbers and only slice content
* Clearing slices returns file to full mode (or codemap-only)

### Milestone 4: Git diff inclusion (because it powers “review” workflows)

**Goal:** optionally include diffs to give models context on recent changes.

**Backend**

* Use git CLI or a library to compute:

  * changed files
  * unified diff against HEAD or chosen base
* Support:

  * include diffs for selected files
  * include diffs for all changed files

**UI**

* “Git” button in bottom bar
* Shows changed files and inclusion toggle

**Acceptance checks**

* Prompt includes diffs when configured
* Token count reflects diff inclusion

### Milestone 5: Codemaps (tree-sitter) + “codemap-only” mode

**Goal:** include structural API surfaces without full implementations.

This is one of Repo Prompt’s main token-saving levers, so implement it early.

**Backend**

* Tree-sitter integration:

  * language detection by extension
  * parse and extract:

    * function signatures
    * classes/interfaces/types
    * exports
* Cache codemap per file (hash by file contents + parser version)

**Codemap modes**

* `none`: do not include
* `complete`: codemap everything in scope
* `auto`: heuristics:

  * if file selected in full/slices, codemap referenced files (imports)
  * cap by token budget

**UI**

* In file tree, show “codemap available” indicator
* File context menu:

  * “Show as API only” (codemap-only)

**Acceptance checks**

* Codemap-only selection is an order of magnitude smaller than full file for typical code
* Cached codemaps make repeated operations fast

### Milestone 6: Apply + Review (XML edits with diffs)

**Goal:** you can paste model output, review diffs, and apply safely.

Repo Prompt’s “controlled changes with reviewable diffs” is central.

**Backend**

* Define a strict XML schema PromptKit expects, for example:

  * `<edit file="path">` with either:

    * `<replace search="...">...</replace>`
    * `<rewrite><![CDATA[...]]></rewrite>`
    * `<patch><![CDATA[unified diff]]></patch>`
* Parse XML, convert into edit operations
* Generate diffs against working tree
* Checkpoint files before apply so “undo” is possible

**UI**

* Apply tab: paste box + “Process”
* Review view: per-file cards + diff viewer
* Buttons:

  * Apply all
  * Apply selected
  * Reject

**Acceptance checks**

* No disk writes happen before user review
* Apply is atomic per file (either fully applied or not)
* Undo restores checkpoint

### Milestone 7: Discovery (Context Builder agent)

**Goal:** the app can “research” the repo and select relevant context within a budget, then generate a handoff prompt.

Repo Prompt explicitly frames discovery as separate from planning/implementation, and calls out that the discovery output should be factual and non-opinionated. ([Repo Prompt][1])

**Agent design**

* A tool-calling loop that can call your own internal “repo tools”:

  * `get_file_tree`
  * `file_search`
  * `read_file`
  * `get_code_structure` (codemaps)
  * `manage_selection` (add files, add slices, set modes)
  * `workspace_context` (token totals, selection snapshot)
* Add a token budget controller:

  * The agent should iterate: select -> measure -> compress via codemaps/slices -> measure again
* Output:

  * Clarified task statement
  * Open questions
  * Selected files with reasoning about relevance (factual)
  * A “handoff prompt” ready for Plan or XML Edit

Repo Prompt’s blog mentions a default 60k-ish budget for pasting into certain chat contexts and using slices to fit budget. ([Repo Prompt][1])

**UI**

* Context Builder tab:

  * task input
  * token budget input
  * live progress log (what it’s searching, selecting)
  * “Result” panel: handoff prompt + selection summary

**Acceptance checks**

* Discovery produces a coherent selection with a stable token total under budget
* It uses slices automatically for huge files when needed

### Milestone 8: Providers (CLI-first; API later)

**Goal:** PromptKit can run Context Builder using:

* local CLI providers (Codex CLI, Claude Code, Gemini CLI) by spawning processes
* API keys (OpenAI/Anthropic/Gemini) (optional, later)

You need at least one provider path for discovery.

**Backend**

* Provider interface:

  * `complete(messages, tools?)` for agent loops
  * streaming optional later
* CLI providers:

  * call child_process, capture stdout/stderr
  * implement robust timeouts and retries

### Milestone 9: MCP server (Node) with a minimal but powerful toolset

**Goal:** external agents can drive selection and read context, and you can expand to edits later.

MCP basics: servers expose tools/resources/prompts, and stdio servers must not write logs to stdout. ([Model Context Protocol][2])

**Start with read-only + selection tools**
Implement these first:

* `get_file_tree`
* `file_search`
* `read_file`
* `get_code_structure`
* `workspace_context`
* `manage_selection` (add/remove/set, including slices)
* `prompt` (get/set instructions)

Then add write tools:

* `apply_edits`
* `file_actions`

Then advanced tools:

* `discover_context` (run Context Builder via MCP)

**Security model**

* Local-only transport
* Connection approval in UI (Allow once / Always allow)
* Per-tool enable/disable
* High-risk operations (delete/move) require explicit approval

**Installation UX**

* “Copy MCP JSON config” button that outputs a standard `mcpServers` block (like MCP docs show). ([Model Context Protocol][2])

**Acceptance checks**

* Cursor/Claude Desktop can list tools and call them successfully
* Calls update PromptKit UI state (selection changes visibly)
* No stdout logging breaks the MCP protocol

## 5) Implementation details that will save you pain later

### 5.1 State model: treat “tab” as the unit of context

Repo Prompt uses compose tabs heavily. Your internal model should too:

* Workspace: roots + index
* Tab: selection + instructions + preset config + discovery runs + apply queue
* MCP connections should bind to a tab to avoid “user switched tabs” bugs

### 5.2 Token counting must count the final formatted output

PasteMax’s releases mention improving token counting precision by counting the formatted copy output, not just raw file text. ([GitHub][4])
Do the same in PromptKit:

* Render prompt string
* Tokenize that exact string
* Cache per-section token counts (tree, codemaps, file contents, diffs, instructions)

### 5.3 Performance: large repos require virtualization and incremental indexing

* Virtualize file tree rendering
* Index in background (daemon)
* UI should request slices of the tree, not “everything”

### 5.4 Diff/patch strategy

Support both:

* Unified diff (human-readable, git-friendly)
* Structured edits (search/replace blocks with validation)
  You will need both because models vary in reliability.

## 6) Suggested repo layout for PromptKit (concrete)

A layout that keeps reuse and testing clean:

* `packages/protocol`

  * zod schemas for:

    * selection entries
    * presets
    * MCP tool args/returns
    * prompt formats
* `packages/core`

  * ignore + scanning
  * token counting
  * prompt builder
  * codemap engine
  * diff engine
  * XML parsing
* `apps/daemon`

  * RPC server
  * file watcher + indexer
  * persistence (SQLite or JSON in app data)
* `apps/mcp`

  * MCP stdio server
  * proxies tool calls to daemon
* `apps/desktop`

  * Tauri shell
  * React UI

## 7) If you want an “MVP that feels like Repo Prompt” fastest

Ship in this order:

1. Compose (manual selection) + token count + copy prompt
2. Presets
3. Apply XML + Review diffs + Apply to disk
4. Codemaps
5. Discovery (Context Builder)
6. MCP server read-only + selection tools
7. MCP server write tools + discover_context

That ordering gets you the core loop: curate context -> get model output -> review -> apply, plus the two big multipliers (presets and discovery) that make it scale. ([Repo Prompt][1])

If you want, I can turn this into a tight GitHub issue plan (epics -> stories -> acceptance criteria) tailored to PromptKit’s exact UI and the pieces you’ll port from PasteMax first.

[1]: https://repoprompt.com/blog/context-over-convenience/ "Context Over Convenience – Repo Prompt Blog"
[2]: https://modelcontextprotocol.io/docs/develop/build-server "Build an MCP server - Model Context Protocol"
[3]: https://github.com/kleneway/pastemax "GitHub - kleneway/pastemax: A simple tool to select files from a repository to copy/paste into an LLM"
[4]: https://github.com/kleneway/pastemax/releases "Releases · kleneway/pastemax · GitHub"
