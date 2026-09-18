use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, bail};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use directories::ProjectDirs;
use rand::Rng;
use serde::{Deserialize, Serialize};

pub const NATIVE_HOST_NAME: &str = "io.browser_connector.native";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ConnectorConfig {
    pub host_id: String,
    pub pairing_secret: String,
    #[serde(default)]
    pub extension_id: Option<String>,
}

impl ConnectorConfig {
    pub fn load_or_create(host_id: &str) -> Result<Self> {
        validate_host_id(host_id)?;
        let path = config_path(host_id)?;
        if path.exists() {
            let bytes = fs::read(&path).with_context(|| format!("read {}", path.display()))?;
            return serde_json::from_slice(&bytes).context("parse connector config");
        }

        let mut secret = [0_u8; 32];
        rand::rng().fill_bytes(&mut secret);
        let config = Self {
            host_id: host_id.to_owned(),
            pairing_secret: URL_SAFE_NO_PAD.encode(secret),
            extension_id: None,
        };
        config.save()?;
        Ok(config)
    }

    pub fn save(&self) -> Result<()> {
        let path = config_path(&self.host_id)?;
        write_private_json(&path, self)
    }
}

#[derive(Debug, Serialize)]
struct NativeMessagingManifest<'a> {
    name: &'a str,
    description: &'a str,
    path: &'a str,
    #[serde(rename = "type")]
    kind: &'a str,
    allowed_origins: Vec<String>,
}

pub fn install(extension_id: &str, host_id: &str, executable: &Path) -> Result<PathBuf> {
    validate_extension_id(extension_id)?;
    let mut config = ConnectorConfig::load_or_create(host_id)?;
    config.host_id = host_id.to_owned();
    config.extension_id = Some(extension_id.to_owned());
    config.save()?;

    let executable = executable
        .to_str()
        .context("browser-connector executable path is not UTF-8")?;
    let manifest = NativeMessagingManifest {
        name: NATIVE_HOST_NAME,
        description: "Local native bridge for Browser Connector",
        path: executable,
        kind: "stdio",
        allowed_origins: vec![format!("chrome-extension://{extension_id}/")],
    };
    let path = chrome_native_manifest_path()?;
    write_private_json(&path, &manifest)?;
    Ok(path)
}

pub fn config_path(host_id: &str) -> Result<PathBuf> {
    validate_host_id(host_id)?;
    Ok(project_dirs()?
        .config_dir()
        .join("hosts")
        .join(format!("{host_id}.json")))
}

pub fn runtime_dir() -> Result<PathBuf> {
    let path = project_dirs()?.data_local_dir().join("runtime");
    fs::create_dir_all(&path).with_context(|| format!("create {}", path.display()))?;
    set_owner_only(&path)?;
    Ok(path)
}

#[cfg(unix)]
pub fn broker_socket_path() -> Result<PathBuf> {
    use std::os::unix::fs::MetadataExt;

    let runtime = runtime_dir()?;
    let owner = fs::metadata(&runtime)?.uid();
    let directory = PathBuf::from("/tmp").join(format!("browser-connector-{owner}"));

    match fs::symlink_metadata(&directory) {
        Ok(metadata) => {
            if !metadata.file_type().is_dir() || metadata.uid() != owner {
                bail!("refusing unsafe broker directory {}", directory.display());
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            use std::os::unix::fs::DirBuilderExt;
            let mut builder = fs::DirBuilder::new();
            builder.mode(0o700);
            builder
                .create(&directory)
                .with_context(|| format!("create {}", directory.display()))?;
        }
        Err(error) => {
            return Err(error).with_context(|| format!("inspect {}", directory.display()));
        }
    }
    set_owner_only(&directory)?;
    Ok(directory.join("native.sock"))
}

#[cfg(not(unix))]
pub fn broker_socket_path() -> Result<PathBuf> {
    bail!("the local broker currently requires a Unix-domain socket")
}

pub fn chrome_native_manifest_path() -> Result<PathBuf> {
    let home = std::env::var_os("HOME").context("HOME is not set")?;
    Ok(PathBuf::from(home)
        .join("Library/Application Support/Google/Chrome/NativeMessagingHosts")
        .join(format!("{NATIVE_HOST_NAME}.json")))
}

fn project_dirs() -> Result<ProjectDirs> {
    ProjectDirs::from("io", "BrowserConnector", "Browser Connector")
        .context("cannot determine Browser Connector directories")
}

fn validate_extension_id(value: &str) -> Result<()> {
    if value.len() != 32 || !value.bytes().all(|byte| (b'a'..=b'p').contains(&byte)) {
        bail!("Chrome extension ID must be 32 lowercase letters in the range a-p");
    }
    Ok(())
}

fn validate_host_id(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 64
        || !value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'_' | b'.')
        })
    {
        bail!("host ID must be 1-64 lowercase letters, digits, dots, dashes, or underscores");
    }
    Ok(())
}

fn write_private_json(path: &Path, value: &impl Serialize) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
        set_owner_only(parent)?;
    }
    let bytes = serde_json::to_vec_pretty(value)?;
    let mut options = fs::OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .with_context(|| format!("write {}", path.display()))?;
    file.write_all(&bytes)?;
    file.write_all(b"\n")?;
    set_owner_only(path)?;
    Ok(())
}

#[cfg(unix)]
fn set_owner_only(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mode = if path.is_dir() { 0o700 } else { 0o600 };
    fs::set_permissions(path, fs::Permissions::from_mode(mode))?;
    Ok(())
}

#[cfg(not(unix))]
fn set_owner_only(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_chrome_extension_ids() {
        assert!(validate_extension_id("abcdefghijklmnopabcdefghijklmnop").is_ok());
        assert!(validate_extension_id("too-short").is_err());
        assert!(validate_extension_id("zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz").is_err());
    }

    #[test]
    fn validates_host_ids_as_safe_file_names() {
        assert!(validate_host_id("codex").is_ok());
        assert!(validate_host_id("generic-host_1").is_ok());
        assert!(validate_host_id("../escape").is_err());
        assert!(validate_host_id("Uppercase").is_err());
    }
}
