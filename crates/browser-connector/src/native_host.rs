use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use anyhow::{Context, Result, bail};
use serde::Deserialize;
use serde_json::Value;
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufStream},
    net::{UnixListener, UnixStream},
    sync::{Mutex, mpsc},
    time::timeout,
};

use crate::config::broker_socket_path;

const MAX_NATIVE_MESSAGE: usize = 16 * 1024 * 1024;
const CLIENT_QUEUE_SIZE: usize = 32;
const BROWSER_QUEUE_SIZE: usize = 128;

type PendingMap = Arc<Mutex<HashMap<u64, PendingResponse>>>;

struct PendingResponse {
    client_id: u64,
    original_id: u64,
    responses: mpsc::Sender<Value>,
}

#[derive(Deserialize)]
struct ClientHandshake {
    kind: String,
    session_id: String,
    host_id: String,
}

struct SocketCleanup(PathBuf);

impl Drop for SocketCleanup {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

pub async fn run() -> Result<()> {
    let socket_path = broker_socket_path()?;
    let listener = bind_broker_socket(&socket_path).await?;
    let _cleanup = SocketCleanup(socket_path);
    serve_native_io(listener, tokio::io::stdin(), tokio::io::stdout()).await
}

async fn bind_broker_socket(path: &Path) -> Result<UnixListener> {
    if let Ok(metadata) = tokio::fs::symlink_metadata(path).await {
        #[cfg(unix)]
        {
            use std::os::unix::fs::{FileTypeExt, MetadataExt};

            let parent = path.parent().context("broker socket has no parent")?;
            let expected_owner = tokio::fs::metadata(parent).await?.uid();
            if !metadata.file_type().is_socket() || metadata.uid() != expected_owner {
                bail!("refusing unsafe broker socket at {}", path.display());
            }
        }

        if UnixStream::connect(path).await.is_ok() {
            bail!("another Browser Connector native host is already running");
        }
        tokio::fs::remove_file(path)
            .await
            .with_context(|| format!("remove stale broker socket {}", path.display()))?;
    }

    let listener = UnixListener::bind(path)
        .with_context(|| format!("bind native broker at {}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).await?;
    }
    Ok(listener)
}

async fn serve_native_io<R, W>(
    listener: UnixListener,
    mut browser_read: R,
    mut browser_write: W,
) -> Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let pending = Arc::new(Mutex::new(HashMap::new()));
    let next_broker_id = Arc::new(AtomicU64::new(1));
    let next_client_id = Arc::new(AtomicU64::new(1));
    let (browser_tx, mut browser_rx) = mpsc::channel::<Vec<u8>>(BROWSER_QUEUE_SIZE);

    let accept = accept_clients(
        listener,
        browser_tx,
        pending.clone(),
        next_broker_id,
        next_client_id,
    );
    let from_browser = async {
        loop {
            let message = read_native_message(&mut browser_read).await?;
            route_browser_response(&pending, &message).await?;
        }
        #[allow(unreachable_code)]
        Ok::<(), anyhow::Error>(())
    };
    let to_browser = async {
        while let Some(message) = browser_rx.recv().await {
            write_native_message(&mut browser_write, &message).await?;
        }
        Ok::<(), anyhow::Error>(())
    };

    tokio::select! {
        result = accept => result,
        result = from_browser => result,
        result = to_browser => result,
    }
}

async fn accept_clients(
    listener: UnixListener,
    browser_tx: mpsc::Sender<Vec<u8>>,
    pending: PendingMap,
    next_broker_id: Arc<AtomicU64>,
    next_client_id: Arc<AtomicU64>,
) -> Result<()> {
    loop {
        let (stream, _) = listener.accept().await?;
        let browser_tx = browser_tx.clone();
        let pending = pending.clone();
        let next_broker_id = next_broker_id.clone();
        let client_id = next_client_id.fetch_add(1, Ordering::Relaxed);
        tokio::spawn(async move {
            if let Err(error) =
                serve_client(client_id, stream, browser_tx, pending, next_broker_id).await
            {
                tracing::debug!(client_id, %error, "native broker client disconnected");
            }
        });
    }
}

async fn serve_client(
    client_id: u64,
    stream: UnixStream,
    browser_tx: mpsc::Sender<Vec<u8>>,
    pending: PendingMap,
    next_broker_id: Arc<AtomicU64>,
) -> Result<()> {
    let result = serve_client_inner(
        client_id,
        stream,
        browser_tx,
        pending.clone(),
        next_broker_id,
    )
    .await;
    pending
        .lock()
        .await
        .retain(|_, response| response.client_id != client_id);
    result
}

async fn serve_client_inner(
    client_id: u64,
    stream: UnixStream,
    browser_tx: mpsc::Sender<Vec<u8>>,
    pending: PendingMap,
    next_broker_id: Arc<AtomicU64>,
) -> Result<()> {
    let mut stream = BufStream::new(stream);
    let mut line = String::new();
    let count = timeout(Duration::from_secs(5), stream.read_line(&mut line))
        .await
        .context("MCP broker handshake timed out")??;
    if count == 0 {
        bail!("MCP client closed during handshake");
    }
    let handshake: ClientHandshake = serde_json::from_str(&line)?;
    if handshake.kind != "mcp_connect"
        || handshake.session_id.is_empty()
        || handshake.host_id.is_empty()
    {
        bail!("invalid MCP broker handshake");
    }
    stream.write_all(b"{\"kind\":\"mcp_connected\"}\n").await?;
    stream.flush().await?;

    let (responses, mut response_rx) = mpsc::channel::<Value>(CLIENT_QUEUE_SIZE);
    loop {
        line.clear();
        tokio::select! {
            read = stream.read_line(&mut line) => {
                if read? == 0 {
                    return Ok(());
                }
                let mut request: Value = serde_json::from_str(&line)?;
                let object = request.as_object_mut().context("browser request must be an object")?;
                if object.get("kind").and_then(Value::as_str) != Some("request") {
                    bail!("unexpected MCP broker message");
                }
                let original_id = object
                    .get("id")
                    .and_then(Value::as_u64)
                    .context("browser request is missing a numeric id")?;
                let broker_id = next_broker_id.fetch_add(1, Ordering::Relaxed);
                object.insert("id".to_owned(), Value::from(broker_id));
                pending.lock().await.insert(
                    broker_id,
                    PendingResponse {
                        client_id,
                        original_id,
                        responses: responses.clone(),
                    },
                );
                if browser_tx.send(serde_json::to_vec(&request)?).await.is_err() {
                    pending.lock().await.remove(&broker_id);
                    bail!("Chrome native channel closed");
                }
            }
            response = response_rx.recv() => {
                let response = response.context("browser response channel closed")?;
                stream.write_all(serde_json::to_string(&response)?.as_bytes()).await?;
                stream.write_all(b"\n").await?;
                stream.flush().await?;
            }
        }
    }
}

async fn route_browser_response(pending: &PendingMap, message: &[u8]) -> Result<()> {
    let mut response: Value = serde_json::from_slice(message)?;
    let object = response
        .as_object_mut()
        .context("browser response must be an object")?;
    if object.get("kind").and_then(Value::as_str) != Some("response") {
        return Ok(());
    }
    let broker_id = object
        .get("id")
        .and_then(Value::as_u64)
        .context("browser response is missing a numeric id")?;
    let Some(route) = pending.lock().await.remove(&broker_id) else {
        return Ok(());
    };
    object.insert("id".to_owned(), Value::from(route.original_id));
    let _ = route.responses.send(response).await;
    Ok(())
}

async fn read_native_message(reader: &mut (impl AsyncRead + Unpin)) -> Result<Vec<u8>> {
    let mut length = [0_u8; 4];
    reader.read_exact(&mut length).await?;
    let length = u32::from_le_bytes(length) as usize;
    if length > MAX_NATIVE_MESSAGE {
        bail!("native message exceeds {MAX_NATIVE_MESSAGE} bytes");
    }
    let mut message = vec![0_u8; length];
    reader.read_exact(&mut message).await?;
    serde_json::from_slice::<Value>(&message).context("invalid JSON from extension")?;
    Ok(message)
}

async fn write_native_message(
    writer: &mut (impl AsyncWrite + Unpin),
    message: &[u8],
) -> Result<()> {
    if message.len() > MAX_NATIVE_MESSAGE {
        bail!("native message exceeds {MAX_NATIVE_MESSAGE} bytes");
    }
    writer
        .write_all(&(message.len() as u32).to_le_bytes())
        .await?;
    writer.write_all(message).await?;
    writer.flush().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufStream};

    #[tokio::test]
    async fn native_message_round_trip() {
        let mut bytes = Vec::new();
        write_native_message(&mut bytes, br#"{"ok":true}"#)
            .await
            .unwrap();
        let mut input = bytes.as_slice();
        let decoded = read_native_message(&mut input).await.unwrap();
        assert_eq!(decoded, br#"{"ok":true}"#);
    }

    #[tokio::test]
    async fn multiplexes_mcp_sessions_with_colliding_request_ids() {
        let temp = tempfile::tempdir().unwrap();
        let socket_path = temp.path().join("native.sock");
        let listener = UnixListener::bind(&socket_path).unwrap();
        let (mut extension_to_host, host_input) = tokio::io::duplex(64 * 1024);
        let (host_output, mut host_to_extension) = tokio::io::duplex(64 * 1024);
        let broker =
            tokio::spawn(async move { serve_native_io(listener, host_input, host_output).await });

        let browser = tokio::spawn(async move {
            let mut requests = Vec::new();
            for _ in 0..2 {
                let message = read_native_message(&mut host_to_extension).await.unwrap();
                requests.push(serde_json::from_slice::<Value>(&message).unwrap());
            }
            for request in requests.into_iter().rev() {
                let response = json!({
                    "kind": "response",
                    "id": request["id"],
                    "result": {"marker": request["params"]["marker"]},
                });
                write_native_message(
                    &mut extension_to_host,
                    serde_json::to_string(&response).unwrap().as_bytes(),
                )
                .await
                .unwrap();
            }
        });

        async fn client(socket_path: PathBuf, marker: &str) -> Value {
            let stream = UnixStream::connect(socket_path).await.unwrap();
            let mut stream = BufStream::new(stream);
            let handshake = json!({
                "kind": "mcp_connect",
                "session_id": marker,
                "host_id": "codex",
            });
            stream
                .write_all(serde_json::to_string(&handshake).unwrap().as_bytes())
                .await
                .unwrap();
            stream.write_all(b"\n").await.unwrap();
            stream.flush().await.unwrap();
            let mut ack = String::new();
            stream.read_line(&mut ack).await.unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&ack).unwrap()["kind"],
                "mcp_connected"
            );

            let request = json!({
                "kind": "request",
                "id": 1,
                "method": "tabs_context",
                "params": {"marker": marker},
            });
            stream
                .write_all(serde_json::to_string(&request).unwrap().as_bytes())
                .await
                .unwrap();
            stream.write_all(b"\n").await.unwrap();
            stream.flush().await.unwrap();
            let mut response = String::new();
            stream.read_line(&mut response).await.unwrap();
            serde_json::from_str(&response).unwrap()
        }

        let (first, second) = tokio::join!(
            client(socket_path.clone(), "first"),
            client(socket_path, "second")
        );
        assert_eq!(first["id"], 1);
        assert_eq!(first["result"]["marker"], "first");
        assert_eq!(second["id"], 1);
        assert_eq!(second["result"]["marker"], "second");
        browser.await.unwrap();
        broker.abort();
    }
}
