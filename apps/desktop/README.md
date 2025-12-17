# PromptKit Desktop (Tauri + React)

This is the PromptKit desktop UI. It talks to the local `apps/daemon` JSON-RPC server.

## Dev

From the repo root:

```sh
pnpm install
pnpm build
pnpm --filter @prompt-kit/desktop tauri dev
```

In the app, click **Start daemon** (or run it yourself with `pnpm --filter @prompt-kit/daemon dev`) and then **Open folder…**.
