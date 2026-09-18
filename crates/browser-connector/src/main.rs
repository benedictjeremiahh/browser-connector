mod config;
mod native_host;
mod relay;
mod tools;

use std::path::PathBuf;

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

#[derive(Debug, Subcommand)]
enum Command {
    /// Run the provider-agnostic MCP server over STDIO.
    Mcp {
        #[arg(long, default_value = "generic-mcp")]
        host_id: String,
    },
    /// Run Chrome native-messaging forwarding explicitly (normally auto-detected).
    NativeHost,
    /// Pair an unpacked/installed extension and write Chrome's native-host manifest.
    Install {
        #[arg(long)]
        extension_id: String,
        #[arg(long, default_value = "codex")]
        host_id: String,
        /// Override the executable path stored in Chrome's manifest.
        #[arg(long)]
        executable: Option<PathBuf>,
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
        } => {
            let executable =
                executable.unwrap_or(std::env::current_exe().context("locate current executable")?);
            let path = config::install(&extension_id, &host_id, &executable)?;
            println!(
                "Installed Chrome native-messaging manifest: {}",
                path.display()
            );
            println!(
                "Restart Chrome, open the Browser Connector side panel, and approve Host Pairing."
            );
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

async fn run_mcp(host_id: &str) -> Result<()> {
    let config = ConnectorConfig::load_or_create(host_id)?;
    let relay = BrowserRelay::start(config).await?;
    let service = BrowserService::new(relay.clone()).serve(stdio()).await?;
    let result = service.waiting().await;
    relay.shutdown().await;
    result.context("MCP server stopped")?;
    Ok(())
}
