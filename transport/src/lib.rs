//! Browser iroh relay transport. Pair once with a secret from the QR code, then
//! carry audio only in QUIC datagrams (at most 1000 bytes each).

use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};

use futures_util::future::{AbortHandle, Abortable};
use iroh::{
    Endpoint, EndpointAddr,
    endpoint::{Connection, presets::N0},
};
use js_sys::Uint8Array;
use n0_future::time::{Duration, timeout};
use serde::{Deserialize, Serialize};
use wasm_bindgen::{JsError, prelude::wasm_bindgen};
use wasm_bindgen_futures::spawn_local;

const ALPN: &[u8] = b"webmic/audio/1";
const MAX_DATAGRAM: usize = 1000;
const MAX_HANDSHAKE: usize = 1024;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const ONLINE_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Hello {
    token: String,
    label: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Welcome {
    label: String,
}

fn validate_token(token: &str) -> Result<(), JsError> {
    if !(16..=256).contains(&token.len()) || !token.bytes().all(|b| b.is_ascii_graphic()) {
        return Err(JsError::new(
            "Pairing token must be 16-256 printable ASCII bytes",
        ));
    }
    Ok(())
}

fn validate_label(label: &str) -> Result<(), JsError> {
    if label.trim().is_empty()
        || label.len() > 256
        || label.chars().count() > 80
        || label.chars().any(char::is_control)
    {
        return Err(JsError::new(
            "Device label must be 1-80 characters, at most 256 bytes, without control characters",
        ));
    }
    Ok(())
}

fn tokens_match(expected: &str, actual: &str) -> bool {
    // No early exit on a matching prefix of the pairing secret.
    let mut difference = expected.len() ^ actual.len();
    for i in 0..256 {
        difference |= usize::from(
            expected.as_bytes().get(i).copied().unwrap_or(0)
                ^ actual.as_bytes().get(i).copied().unwrap_or(0),
        );
    }
    difference == 0
}

fn transport_error(context: &str, error: impl std::fmt::Display) -> JsError {
    JsError::new(&format!("{context}: {error}"))
}

struct State {
    endpoint: Endpoint,
    closed: Cell<bool>,
    paired: Cell<bool>,
    pending: RefCell<Option<AbortHandle>>,
    active: RefCell<Option<Connection>>,
}

impl State {
    fn close(&self) {
        if self.closed.replace(true) {
            return;
        }
        if let Some(pending) = self.pending.borrow_mut().take() {
            pending.abort();
        }
        if let Some(connection) = self.active.borrow_mut().take() {
            connection.close(0u8.into(), b"session ended");
        }
        let endpoint = self.endpoint.clone();
        spawn_local(async move { endpoint.close().await });
    }

    fn begin(
        self: &Rc<Self>,
    ) -> Result<(Pending, futures_util::future::AbortRegistration), JsError> {
        if self.closed.get() {
            return Err(JsError::new("Audio endpoint is closed"));
        }
        if self.paired.get() || self.pending.borrow().is_some() {
            return Err(JsError::new("Audio endpoint already has a pairing session"));
        }
        let (handle, registration) = AbortHandle::new_pair();
        *self.pending.borrow_mut() = Some(handle);
        Ok((Pending(self.clone()), registration))
    }

    fn finish(&self, mut candidate: Candidate, label: String) -> Result<AudioConnection, JsError> {
        if self.closed.get() {
            return Err(JsError::new("Audio endpoint was closed during pairing"));
        }
        let connection = candidate.0.take().expect("candidate connection is present");
        self.paired.set(true);
        *self.active.borrow_mut() = Some(connection.clone());
        // No further peers may consume resources after this session is paired.
        let endpoint = self.endpoint.clone();
        spawn_local(async move {
            while let Some(incoming) = endpoint.accept().await {
                incoming.refuse();
            }
        });
        Ok(AudioConnection { connection, label })
    }
}

struct Pending(Rc<State>);

impl Drop for Pending {
    fn drop(&mut self) {
        self.0.pending.borrow_mut().take();
    }
}

// Authentication errors, timeouts and cancelled futures all close the candidate.
struct Candidate(Option<Connection>);

impl Drop for Candidate {
    fn drop(&mut self) {
        if let Some(connection) = self.0.take() {
            connection.close(1u8.into(), b"pairing failed");
        }
    }
}

#[wasm_bindgen]
pub struct AudioEndpoint {
    state: Rc<State>,
}

#[wasm_bindgen]
impl AudioEndpoint {
    /// Resolves only after the official iroh relay is reachable.
    pub async fn create() -> Result<AudioEndpoint, JsError> {
        let endpoint = Endpoint::builder(N0)
            .alpns(vec![ALPN.to_vec()])
            .bind()
            .await
            .map_err(|e| transport_error("Could not start iroh", e))?;
        let this = Self {
            state: Rc::new(State {
                endpoint,
                closed: Cell::new(false),
                paired: Cell::new(false),
                pending: RefCell::new(None),
                active: RefCell::new(None),
            }),
        };
        timeout(ONLINE_TIMEOUT, this.state.endpoint.online())
            .await
            .map_err(|_| {
                JsError::new("Timed out contacting an iroh relay; check your internet connection")
            })?;
        if this.state.endpoint.addr().relay_urls().next().is_none() {
            return Err(JsError::new("Iroh did not provide a relay address"));
        }
        Ok(this)
    }

    /// JSON of the full EndpointAddr, including explicit relay addressing.
    pub fn address(&self) -> Result<String, JsError> {
        if self.state.closed.get() {
            return Err(JsError::new("Audio endpoint is closed"));
        }
        let address = self.state.endpoint.addr();
        if address.relay_urls().next().is_none() {
            return Err(JsError::new("Iroh relay address is unavailable"));
        }
        serde_json::to_string(&address)
            .map_err(|e| transport_error("Could not encode endpoint address", e))
    }

    /// Rejects invalid peers and continues waiting for the matching QR secret.
    pub async fn accept(&self, token: String, label: String) -> Result<AudioConnection, JsError> {
        validate_token(&token)?;
        validate_label(&label)?;
        let (_pending, registration) = self.state.begin()?;
        let operation = async {
            loop {
                let incoming =
                    self.state.endpoint.accept().await.ok_or_else(|| {
                        JsError::new("Audio endpoint stopped accepting connections")
                    })?;
                let connection = match timeout(CONNECT_TIMEOUT, async { incoming.await }).await {
                    Ok(Ok(connection)) => connection,
                    _ => continue,
                };
                let candidate = Candidate(Some(connection.clone()));
                let handshake = async {
                    let (mut send, mut recv) = connection
                        .accept_bi()
                        .await
                        .map_err(|e| transport_error("Could not accept pairing stream", e))?;
                    let bytes = recv
                        .read_to_end(MAX_HANDSHAKE)
                        .await
                        .map_err(|_| JsError::new("Invalid or oversized pairing request"))?;
                    let hello: Hello = serde_json::from_slice(&bytes)
                        .map_err(|_| JsError::new("Invalid pairing request"))?;
                    validate_token(&hello.token)?;
                    validate_label(&hello.label)?;
                    if !tokens_match(&token, &hello.token) {
                        return Err(JsError::new("Pairing token does not match"));
                    }
                    let reply = serde_json::to_vec(&Welcome {
                        label: label.clone(),
                    })
                    .map_err(|e| transport_error("Could not encode pairing response", e))?;
                    send.write_all(&reply)
                        .await
                        .map_err(|e| transport_error("Could not send pairing response", e))?;
                    send.finish()
                        .map_err(|e| transport_error("Could not finish pairing response", e))?;
                    Ok(hello.label)
                };
                if let Ok(Ok(remote_label)) = timeout(HANDSHAKE_TIMEOUT, handshake).await {
                    return self.state.finish(candidate, remote_label);
                }
            }
        };
        Abortable::new(operation, registration)
            .await
            .map_err(|_| JsError::new("Audio pairing was cancelled"))?
    }

    pub async fn connect(
        &self,
        address: String,
        token: String,
        label: String,
    ) -> Result<AudioConnection, JsError> {
        validate_token(&token)?;
        validate_label(&label)?;
        if address.len() > 8192 {
            return Err(JsError::new("Endpoint address is too large"));
        }
        let address: EndpointAddr =
            serde_json::from_str(&address).map_err(|_| JsError::new("Invalid endpoint address"))?;
        if address.relay_urls().next().is_none() {
            return Err(JsError::new("Endpoint address must include an iroh relay"));
        }
        let (_pending, registration) = self.state.begin()?;
        let operation = async {
            let connection = timeout(CONNECT_TIMEOUT, self.state.endpoint.connect(address, ALPN))
                .await
                .map_err(|_| JsError::new("Timed out connecting to the remote endpoint"))?
                .map_err(|e| transport_error("Could not connect to remote endpoint", e))?;
            let candidate = Candidate(Some(connection.clone()));
            let handshake = async {
                let (mut send, mut recv) = connection
                    .open_bi()
                    .await
                    .map_err(|e| transport_error("Could not open pairing stream", e))?;
                let request = serde_json::to_vec(&Hello { token, label })
                    .map_err(|e| transport_error("Could not encode pairing request", e))?;
                if request.len() > MAX_HANDSHAKE {
                    return Err(JsError::new("Pairing request is too large"));
                }
                send.write_all(&request)
                    .await
                    .map_err(|e| transport_error("Could not send pairing request", e))?;
                send.finish()
                    .map_err(|e| transport_error("Could not finish pairing request", e))?;
                let bytes = recv
                    .read_to_end(MAX_HANDSHAKE)
                    .await
                    .map_err(|_| JsError::new("Pairing rejected or invalid response"))?;
                let welcome: Welcome = serde_json::from_slice(&bytes)
                    .map_err(|_| JsError::new("Invalid pairing response"))?;
                validate_label(&welcome.label)?;
                Ok(welcome.label)
            };
            let remote_label = timeout(HANDSHAKE_TIMEOUT, handshake)
                .await
                .map_err(|_| JsError::new("Timed out authenticating the remote endpoint"))??;
            self.state.finish(candidate, remote_label)
        };
        Abortable::new(operation, registration)
            .await
            .map_err(|_| JsError::new("Audio pairing was cancelled"))?
    }

    pub fn close(&self) {
        self.state.close();
    }
}

impl Drop for AudioEndpoint {
    fn drop(&mut self) {
        self.state.close();
    }
}

#[wasm_bindgen]
pub struct AudioConnection {
    connection: Connection,
    label: String,
}

#[wasm_bindgen]
impl AudioConnection {
    #[wasm_bindgen(getter)]
    pub fn label(&self) -> String {
        self.label.clone()
    }

    pub fn send(&self, data: Vec<u8>) -> Result<(), JsError> {
        if data.is_empty() || data.len() > MAX_DATAGRAM {
            return Err(JsError::new("Audio datagram must contain 1-1000 bytes"));
        }
        self.connection
            .send_datagram(data.into())
            .map_err(|e| transport_error("Could not send audio datagram", e))
    }

    pub async fn receive(&self) -> Result<Uint8Array, JsError> {
        let bytes = self
            .connection
            .read_datagram()
            .await
            .map_err(|e| transport_error("Could not receive audio datagram", e))?;
        if bytes.is_empty() || bytes.len() > MAX_DATAGRAM {
            self.close();
            return Err(JsError::new("Remote peer sent an invalid audio datagram"));
        }
        Ok(Uint8Array::from(bytes.as_ref()))
    }

    pub fn close(&self) {
        self.connection.close(0u8.into(), b"audio stopped");
    }
}

impl Drop for AudioConnection {
    fn drop(&mut self) {
        self.close();
    }
}
