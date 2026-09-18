use std::{
    fmt,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use anyhow::{Context, Result, anyhow, bail};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufStream},
    net::UnixStream,
    sync::Mutex,
    time::{sleep, timeout},
};
use uuid::Uuid;

use crate::config::{ConnectorConfig, broker_socket_path};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const CONNECT_RETRY_INTERVAL: Duration = Duration::from_millis(250);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Clone)]
pub struct BrowserRelay {
    inner: Arc<RelayInner>,
}

struct RelayInner {
    connection: Mutex<Option<BufStream<UnixStream>>>,
    next_request_id: AtomicU64,
    socket_path: PathBuf,
    session_id: String,
    host_id: String,
    pairing_secret: String,
}

#[derive(Debug)]
pub struct BrowserCallError {
    pub payload: Value,
}

impl fmt::Display for BrowserCallError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}", self.payload)
    }
}

impl std::error::Error for BrowserCallError {}

#[derive(Debug, Deserialize)]
struct BrokerHandshake {
    kind: String,
}

impl BrowserRelay {
    pub async fn start(config: ConnectorConfig) -> Result<Self> {
        Self::start_at(config, broker_socket_path()?).await
    }

    async fn start_at(config: ConnectorConfig, socket_path: PathBuf) -> Result<Self> {
        Ok(Self {
            inner: Arc::new(RelayInner {
                connection: Mutex::new(None),
                next_request_id: AtomicU64::new(1),
                socket_path,
                session_id: Uuid::new_v4().to_string(),
                host_id: config.host_id,
                pairing_secret: config.pairing_secret,
            }),
        })
    }

    pub async fn call(&self, method: &str, params: Value) -> Result<Value> {
        let id = self.inner.next_request_id.fetch_add(1, Ordering::Relaxed);
        let request = json!({
            "kind": "request",
            "id": id,
            "method": method,
            "params": params,
            "hostId": self.inner.host_id,
            "sessionId": self.inner.session_id,
            "pairingProof": self.inner.pairing_secret,
        });
        let encoded = serde_json::to_vec(&request)?;

        let mut guard = self.inner.connection.lock().await;
        if guard.is_none() {
            *guard = Some(self.connect().await?);
        }
        let stream = guard.as_mut().context("browser extension disconnected")?;
        if let Err(error) = async {
            stream.write_all(&encoded).await?;
            stream.write_all(b"\n").await?;
            stream.flush().await
        }
        .await
        {
            *guard = None;
            return Err(anyhow!(
                "browser request transport failed after dispatch; outcome may be unknown: {error}"
            ));
        }

        let response = timeout(REQUEST_TIMEOUT, async {
            loop {
                let mut line = String::new();
                let count = stream.read_line(&mut line).await?;
                if count == 0 {
                    bail!("browser extension disconnected before replying");
                }
                let value: Value = serde_json::from_str(&line)?;
                if value.get("kind").and_then(Value::as_str) == Some("response")
                    && value.get("id").and_then(Value::as_u64) == Some(id)
                {
                    if let Some(error) = value.get("error") {
                        return Err(anyhow::Error::new(BrowserCallError {
                            payload: error.clone(),
                        }));
                    }
                    return Ok(value.get("result").cloned().unwrap_or(Value::Null));
                }
            }
        })
        .await;

        match response {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(error)) if error.downcast_ref::<BrowserCallError>().is_some() => Err(error),
            Ok(Err(error)) => {
                *guard = None;
                Err(anyhow!(
                    "browser request failed after dispatch; outcome may be unknown: {error}"
                ))
            }
            Err(_) => {
                *guard = None;
                Err(anyhow!(
                    "browser request timed out; mutation outcome may be unknown"
                ))
            }
        }
    }

    async fn connect(&self) -> Result<BufStream<UnixStream>> {
        timeout(CONNECT_TIMEOUT, async {
            loop {
                match UnixStream::connect(&self.inner.socket_path).await {
                    Ok(stream) => return self.authenticate(stream).await,
                    Err(_) => sleep(CONNECT_RETRY_INTERVAL).await,
                }
            }
        })
        .await
        .with_context(
            || "browser extension is not connected; open Chrome and the Connector Panel",
        )?
    }

    async fn authenticate(&self, stream: UnixStream) -> Result<BufStream<UnixStream>> {
        let mut stream = BufStream::new(stream);
        let handshake = json!({
            "kind": "mcp_connect",
            "session_id": self.inner.session_id,
            "host_id": self.inner.host_id,
        });
        stream
            .write_all(serde_json::to_string(&handshake)?.as_bytes())
            .await?;
        stream.write_all(b"\n").await?;
        stream.flush().await?;

        let mut line = String::new();
        let count = timeout(Duration::from_secs(5), stream.read_line(&mut line))
            .await
            .context("native broker handshake timed out")??;
        if count == 0 {
            bail!("native broker closed during handshake");
        }
        let response: BrokerHandshake = serde_json::from_str(&line)?;
        if response.kind != "mcp_connected" {
            bail!("native broker rejected the MCP session");
        }
        Ok(stream)
    }

    pub async fn shutdown(&self) {
        *self.inner.connection.lock().await = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncBufReadExt, AsyncWriteExt, BufStream},
        net::UnixListener,
    };

    fn test_config() -> ConnectorConfig {
        ConnectorConfig {
            host_id: "codex".to_owned(),
            pairing_secret: "test-secret".to_owned(),
            extension_id: None,
        }
    }

    async fn serve_one(listener: &UnixListener, error_first: bool) {
        let (stream, _) = listener.accept().await.unwrap();
        let mut stream = BufStream::new(stream);
        let mut hello = String::new();
        stream.read_line(&mut hello).await.unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&hello).unwrap()["kind"],
            "mcp_connect"
        );
        stream
            .write_all(b"{\"kind\":\"mcp_connected\"}\n")
            .await
            .unwrap();
        stream.flush().await.unwrap();

        let mut first = String::new();
        stream.read_line(&mut first).await.unwrap();
        let first: Value = serde_json::from_str(&first).unwrap();
        let response = if error_first {
            json!({"kind":"response","id":first["id"],"error":{"code":"browser_busy","message":"busy"}})
        } else {
            json!({"kind":"response","id":first["id"],"result":{"tabs":[]}})
        };
        stream
            .write_all(serde_json::to_string(&response).unwrap().as_bytes())
            .await
            .unwrap();
        stream.write_all(b"\n").await.unwrap();
        stream.flush().await.unwrap();

        if error_first {
            let mut second = String::new();
            stream.read_line(&mut second).await.unwrap();
            let second: Value = serde_json::from_str(&second).unwrap();
            let success = json!({"kind":"response","id":second["id"],"result":{"tabs":[]}});
            stream
                .write_all(serde_json::to_string(&success).unwrap().as_bytes())
                .await
                .unwrap();
            stream.write_all(b"\n").await.unwrap();
            stream.flush().await.unwrap();
        }
    }

    #[tokio::test]
    async fn authenticates_and_relays_a_browser_request() {
        let temp = tempfile::tempdir().unwrap();
        let socket_path = temp.path().join("native.sock");
        let listener = UnixListener::bind(&socket_path).unwrap();
        let relay = BrowserRelay::start_at(test_config(), socket_path)
            .await
            .unwrap();
        let server = tokio::spawn(async move { serve_one(&listener, false).await });

        let result = relay.call("tabs_context", json!({})).await.unwrap();
        assert_eq!(result, json!({"tabs":[]}));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn browser_error_does_not_drop_the_authenticated_connection() {
        let temp = tempfile::tempdir().unwrap();
        let socket_path = temp.path().join("native.sock");
        let listener = UnixListener::bind(&socket_path).unwrap();
        let relay = BrowserRelay::start_at(test_config(), socket_path)
            .await
            .unwrap();
        let server = tokio::spawn(async move { serve_one(&listener, true).await });

        assert!(relay.call("tabs_context", json!({})).await.is_err());
        let second = tokio::time::timeout(
            Duration::from_millis(250),
            relay.call("tabs_context", json!({})),
        )
        .await
        .expect("browser error must not drop the relay connection")
        .unwrap();
        assert_eq!(second, json!({"tabs":[]}));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn new_mcp_sessions_reuse_the_same_native_broker() {
        let temp = tempfile::tempdir().unwrap();
        let socket_path = temp.path().join("native.sock");
        let listener = UnixListener::bind(&socket_path).unwrap();
        let server = tokio::spawn(async move {
            serve_one(&listener, false).await;
            serve_one(&listener, false).await;
        });

        for _ in 0..2 {
            let relay = BrowserRelay::start_at(test_config(), socket_path.clone())
                .await
                .unwrap();
            assert_eq!(
                relay.call("tabs_context", json!({})).await.unwrap(),
                json!({"tabs":[]})
            );
            relay.shutdown().await;
        }
        server.await.unwrap();
    }
}
