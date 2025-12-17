import { spawn } from "node:child_process";

function run(cmd, args) {
  const child = spawn(cmd, args, {
    stdio: "inherit",
    env: process.env,
  });
  return child;
}

const children = [];
let shuttingDown = false;

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    try {
      child.kill("SIGINT");
    } catch {
      // ignore
    }
  }
  setTimeout(() => process.exit(code), 250).unref();
}

process.on("SIGINT", () => shutdown(130));
process.on("SIGTERM", () => shutdown(143));

children.push(run("pnpm", ["--filter", "@prompt-kit/daemon", "dev"]));
children.push(run("pnpm", ["--filter", "@prompt-kit/desktop", "tauri", "dev"]));

for (const child of children) {
  child.on("exit", (code) => {
    shutdown(typeof code === "number" ? code : 0);
  });
}
