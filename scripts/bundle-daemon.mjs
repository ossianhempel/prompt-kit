import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);

const bundleRoot = path.join(
  repoRoot,
  "apps",
  "desktop",
  "src-tauri",
  "resources",
  "daemon",
);
const bundleNodeModules = path.join(bundleRoot, "node_modules");
const bundleNodeDir = path.join(
  repoRoot,
  "apps",
  "desktop",
  "src-tauri",
  "resources",
  "node",
);

const daemonDist = path.join(
  repoRoot,
  "apps",
  "daemon",
  "dist",
  "index.js",
);

const workspacePackages = [
  "@prompt-kit/core",
  "@prompt-kit/protocol",
];

function ensureExists(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} not found: ${filePath}`);
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function copyDir(src, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true, dereference: true });
}

function resolvePackageDir(name) {
  const pkgJson = require.resolve(`${name}/package.json`, { paths: [repoRoot] });
  return { pkgJson, dir: path.dirname(pkgJson) };
}

function collectDeps(pkgJsonPath) {
  const pkg = readJson(pkgJsonPath);
  return Object.keys({
    ...(pkg.dependencies ?? {}),
    ...(pkg.optionalDependencies ?? {}),
    ...(pkg.peerDependencies ?? {}),
  });
}

function copyPackage(name, queue, seen) {
  if (seen.has(name)) return;
  seen.add(name);

  const { pkgJson, dir } = resolvePackageDir(name);
  const dest = path.join(bundleNodeModules, name);
  copyDir(dir, dest);

  const deps = collectDeps(pkgJson);
  for (const dep of deps) {
    if (!seen.has(dep)) {
      queue.push(dep);
    }
  }
}

function bundleDaemon() {
  ensureExists(daemonDist, "Daemon dist");

  fs.rmSync(bundleRoot, { recursive: true, force: true });
  fs.mkdirSync(bundleNodeModules, { recursive: true });

  fs.copyFileSync(daemonDist, path.join(bundleRoot, "index.js"));

  const queue = [...workspacePackages];
  const seen = new Set();

  while (queue.length > 0) {
    const name = queue.shift();
    if (!name) continue;
    copyPackage(name, queue, seen);
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    workspacePackages,
    dependencies: [...seen].sort(),
  };
  fs.writeFileSync(
    path.join(bundleRoot, "bundle-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  const shouldBundleNode = process.env.PROMPTKIT_BUNDLE_NODE !== "0";
  if (shouldBundleNode) {
    const nodeName = process.platform === "win32" ? "node.exe" : "node";
    const dest = path.join(bundleNodeDir, nodeName);
    fs.rmSync(bundleNodeDir, { recursive: true, force: true });
    fs.mkdirSync(bundleNodeDir, { recursive: true });
    fs.copyFileSync(process.execPath, dest);
    if (process.platform !== "win32") {
      fs.chmodSync(dest, 0o755);
    }
  }
}

try {
  bundleDaemon();
  console.log("Bundle complete.");
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
