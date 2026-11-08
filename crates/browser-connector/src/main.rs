mod config;
mod native_host;
mod relay;
mod tools;

use std::{
    fs,
    path::PathBuf,
};

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use rmcp::{ServiceExt, transport::stdio};
use tracing_subscriber::EnvFilter;

use crate::{config::ConnectorConfig, relay::BrowserRelay, tools::BrowserService};

#[derive(Debug, Parser)]
#[command(name = "browser-connector", version, about)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

/// The Chrome Web Store assigns this id; it is public and cannot be spoofed.
const STORE_EXTENSION_ID: &str = "joapggeojinhbnphdainoiinicnaaieo";

#[derive(Debug, Subcommand)]
enum Command {
    /// Run the provider-agnostic MCP server over STDIO.
    Mcp {
        #[arg(long, default_value = "generic-mcp")]
        host_id: String,
    },
    /// Run Chrome native-messaging forwarding explicitly (normally auto-detected).
    NativeHost,
    /// Register the extension and write Chrome's native-host manifest.
    Install {
        /// Add another extension id; the published Store id is registered by default.
        #[arg(long)]
        extension_id: Option<String>,
        #[arg(long, default_value = "codex")]
        host_id: String,
        /// Use this executable instead of copying to a stable path (package managers).
        #[arg(long)]
        executable: Option<PathBuf>,
        /// Where to copy the binary when --executable is not given (default ~/.local/bin).
        #[arg(long)]
        install_dir: Option<PathBuf>,
    },
    /// Remove the native-host manifest and the stable binary.
    Uninstall {
        #[arg(long)]
        install_dir: Option<PathBuf>,
        /// Leave the copied binary in place.
        #[arg(long)]
        keep_binary: bool,
    },
    /// Print local pairing and native-manifest status without secrets.
    Status {
        #[arg(long, default_value = "codex")]
        host_id: String,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::from_default_env().add_directive("browser_connector=info".parse()?),
        )
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .init();

    if std::env::args()
        .nth(1)
        .is_some_and(|arg| arg.starts_with("chrome-extension://"))
    {
        return native_host::run().await;
    }

    match Cli::parse().command.unwrap_or(Command::Mcp {
        host_id: "generic-mcp".to_owned(),
    }) {
        Command::Mcp { host_id } => run_mcp(&host_id).await,
        Command::NativeHost => native_host::run().await,
        Command::Install {
            extension_id,
            host_id,
            executable,
            install_dir,
        } => {
            let mut extension_ids = vec![STORE_EXTENSION_ID.to_owned()];
            if let Some(id) = extension_id {
                if !extension_ids.contains(&id) {
                    extension_ids.push(id);
                }
            }
            let executable = match executable {
                Some(path) => path,
                None => install_stable_copy(install_dir)?,
            };
            let installed = config::install(&extension_ids, &host_id, &executable)?;
            println!("Executable: {}", executable.display());
            println!(
                "Installed Chrome native-messaging manifest: {}",
                installed.path.display()
            );
            /* Said out loud because registering a second id (the store's, next to the
               unpacked install's) must not read as having replaced the first. */
            println!(
                "  allowed extension ids ({}): {}",
                installed.allowed_origins.len(),
                installed
                    .allowed_origins
                    .iter()
                    .map(|origin| origin
                        .trim_start_matches("chrome-extension://")
                        .trim_end_matches('/'))
                    .collect::<Vec<_>>()
                    .join(", ")
            );
            println!(
                "Restart Chrome, open the Browser Connector side panel, and approve Host Pairing."
            );
            Ok(())
        }
        Command::Uninstall { install_dir, keep_binary } => {
            let removed = config::uninstall_manifest()?;
            let binary = stable_binary_path(install_dir);
            if !keep_binary && binary.exists() {
                fs::remove_file(&binary)
                    .with_context(|| format!("remove {}", binary.display()))?;
                println!("Removed executable: {}", binary.display());
            }
            match removed {
                Some(path) => println!("Removed Chrome native-messaging manifest: {}", path.display()),
                None => println!("No Chrome native-messaging manifest was installed."),
            }
            Ok(())
        }
        Command::Status { host_id } => {
            let config = ConnectorConfig::load_or_create(&host_id)?;
            let manifest = config::chrome_native_manifest_path()?;
            println!("host_id: {}", config.host_id);
            println!(
                "extension_id: {}",
                config.extension_id.as_deref().unwrap_or("not paired")
            );
            println!(
                "native_manifest: {} ({})",
                manifest.display(),
                if manifest.exists() {
                    "installed"
                } else {
                    "missing"
                }
            );
            Ok(())
        }
    }
}

/* Chrome launches the path written in its manifest forever, so the manifest must not
   point into an npm cache, node_modules or a versioned package directory. Copy the
   running binary to a stable per-user path first. */
fn install_stable_copy(install_dir: Option<PathBuf>) -> Result<PathBuf> {
    let current = std::env::current_exe().context("locate current executable")?;
    let target = stable_binary_path(install_dir);
    let directory = target.parent().context("install directory has no parent")?;
    fs::create_dir_all(directory)
        .with_context(|| format!("create {}", directory.display()))?;
    let current = current.canonicalize().unwrap_or(current);
    let existing = target.canonicalize().unwrap_or_else(|_| target.clone());
    if current == existing {
        return Ok(target);
    }
    let temporary = directory.join(format!(".browser-connector.{}", std::process::id()));
    fs::copy(&current, &temporary)
        .with_context(|| format!("copy {} to {}", current.display(), temporary.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(&temporary)?.permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&temporary, permissions)?;
    }
    fs::rename(&temporary, &target)
        .with_context(|| format!("replace {}", target.display()))?;
    Ok(target)
}

fn stable_binary_path(install_dir: Option<PathBuf>) -> PathBuf {
    let directory = install_dir.unwrap_or_else(|| {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_default()
            .join(".local/bin")
    });
    directory.join("browser-connector")
}

async fn run_mcp(host_id: &str) -> Result<()> {
    let config = ConnectorConfig::load_or_create(host_id)?;
    let relay = BrowserRelay::start(config).await?;
    let service = BrowserService::new(relay.clone()).serve(stdio()).await?;
    let result = service.waiting().await;
    relay.shutdown().await;
    result.context("MCP server stopped")?;
    Ok(())
}
