use std::{
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Mutex,
};

use serde::Serialize;
use tauri::Manager;

fn command_from_env(var: &str, fallback: &str) -> String {
    match std::env::var(var) {
        Ok(value) if !value.trim().is_empty() => value,
        _ => fallback.to_string(),
    }
}

fn config_dir() -> Option<PathBuf> {
    if let Ok(override_dir) = std::env::var("PROMPTKIT_CONFIG_DIR") {
        if !override_dir.trim().is_empty() {
            return Some(PathBuf::from(override_dir));
        }
    }

    std::env::var("HOME")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .map(|home| PathBuf::from(home).join(".promptkit"))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DaemonInfo {
    port: u16,
    rpc_url: String,
    health_url: String,
}

struct DaemonProcess {
    child: Child,
    port: u16,
}

impl Drop for DaemonProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

#[derive(Default)]
struct DaemonState(Mutex<Option<DaemonProcess>>);

fn daemon_info(port: u16) -> DaemonInfo {
    DaemonInfo {
        port,
        rpc_url: format!("http://127.0.0.1:{port}/rpc"),
        health_url: format!("http://127.0.0.1:{port}/health"),
    }
}

fn repo_root() -> Result<PathBuf, String> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let root = manifest_dir
        .parent()
        .and_then(|p| p.parent())
        .and_then(|p| p.parent())
        .ok_or_else(|| "Failed to resolve repo root".to_string())?;
    Ok(root.to_path_buf())
}

fn ensure_daemon_dist(root: &PathBuf) -> Result<PathBuf, String> {
    let daemon_dist = root.join("apps/daemon/dist/index.js");
    let core_dist = root.join("packages/core/dist/index.js");
    let protocol_dist = root.join("packages/protocol/dist/index.js");

    if daemon_dist.exists() && core_dist.exists() && protocol_dist.exists() {
        return Ok(daemon_dist);
    }

    let pnpm_cmd = command_from_env("PROMPTKIT_PNPM", "pnpm");

    let output = Command::new(&pnpm_cmd)
        .arg("-C")
        .arg(root)
        .arg("--filter")
        .arg("@prompt-kit/core")
        .arg("--filter")
        .arg("@prompt-kit/protocol")
        .arg("--filter")
        .arg("@prompt-kit/daemon")
        .arg("build")
        .output()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                return format!(
                    "Command not found: {pnpm_cmd}. Install pnpm, or set PROMPTKIT_PNPM to the full path of your pnpm binary.\n\nIf you launched PromptKit from Finder, try launching it from a terminal so it inherits your shell PATH."
                );
            }
            format!("Failed to run pnpm build: {e}")
        })?;

    if !output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "Failed to build daemon.\n\nstdout:\n{stdout}\n\nstderr:\n{stderr}"
        ));
    }

    if !daemon_dist.exists() {
        return Err("Daemon build succeeded but dist script was not found.".to_string());
    }

    Ok(daemon_dist)
}

fn bundled_daemon_entry(app: &tauri::AppHandle) -> Option<PathBuf> {
    let resource_dir = app.path().resource_dir().ok()?;
    let entry = resource_dir.join("daemon").join("index.js");
    if entry.exists() {
        Some(entry)
    } else {
        None
    }
}

fn bundled_node_binary(app: &tauri::AppHandle) -> Option<PathBuf> {
    let resource_dir = app.path().resource_dir().ok()?;
    let node_name = if cfg!(windows) { "node.exe" } else { "node" };
    let candidate = resource_dir.join("node").join(node_name);
    if candidate.exists() {
        Some(candidate)
    } else {
        None
    }
}

fn resolve_node_command(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(env) = std::env::var("PROMPTKIT_NODE") {
        if !env.trim().is_empty() {
            return PathBuf::from(env);
        }
    }

    if let Some(node) = bundled_node_binary(app) {
        return node;
    }

    PathBuf::from("node")
}

#[tauri::command]
fn daemon_status(state: tauri::State<'_, DaemonState>) -> Option<DaemonInfo> {
    let mut guard = state.0.lock().ok()?;
    let Some(proc) = guard.as_mut() else {
        return None;
    };

    match proc.child.try_wait() {
        Ok(Some(_)) => {
            *guard = None;
            None
        }
        Ok(None) => Some(daemon_info(proc.port)),
        Err(_) => Some(daemon_info(proc.port)),
    }
}

#[tauri::command]
fn start_daemon(
    app: tauri::AppHandle,
    state: tauri::State<'_, DaemonState>,
    port: Option<u16>,
) -> Result<DaemonInfo, String> {
    let port = port.unwrap_or(31337);

    let mut guard = state
        .0
        .lock()
        .map_err(|_| "Daemon state lock poisoned".to_string())?;

    if let Some(proc) = guard.as_mut() {
        if proc.child.try_wait().ok().flatten().is_none() {
            return Ok(daemon_info(proc.port));
        }
        *guard = None;
    }

    let (dist_script, daemon_cwd) = match bundled_daemon_entry(&app) {
        Some(entry) => {
            let cwd = entry.parent().map(|p| p.to_path_buf());
            (entry, cwd)
        }
        None => {
            let root = repo_root()?;
            let dist = ensure_daemon_dist(&root)?;
            (dist, Some(root))
        }
    };

    let node_cmd = resolve_node_command(&app);
    let mut command = Command::new(&node_cmd);
    command
        .arg(dist_script)
        .arg(format!("--port={port}"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    if let Some(cwd) = daemon_cwd {
        command.current_dir(cwd);
    }

    if let Some(dir) = config_dir() {
        let _ = std::fs::create_dir_all(&dir);
        let log_path = dir.join("daemon.log");
        if let Ok(log_file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
        {
            if let Ok(log_err) = log_file.try_clone() {
                command.stdout(Stdio::from(log_file));
                command.stderr(Stdio::from(log_err));
            }
        }
    }

    let child = command
        .spawn()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                return format!(
                    "Command not found: {node_cmd}. Install Node.js, or set PROMPTKIT_NODE to the full path of your node binary.\n\nIf you launched PromptKit from Finder, try launching it from a terminal so it inherits your shell PATH. Packaged builds can bundle Node by placing it at resources/node."
                );
            }
            format!("Failed to start daemon: {e}")
        })?;

    *guard = Some(DaemonProcess { child, port });
    Ok(daemon_info(port))
}

#[tauri::command]
fn stop_daemon(state: tauri::State<'_, DaemonState>) -> Result<bool, String> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "Daemon state lock poisoned".to_string())?;

    let Some(mut proc) = guard.take() else {
        return Ok(false);
    };

    let _ = proc.child.kill();
    let _ = proc.child.wait();
    Ok(true)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(DaemonState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            daemon_status,
            start_daemon,
            stop_daemon
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
