use axum::{
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    extract::State,
    response::IntoResponse,
    routing::get,
    Router,
};
use futures_util::{SinkExt, StreamExt};
use remote_common::SignalMessage;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio::sync::mpsc;
use tower_http::cors::CorsLayer;

type Tx = mpsc::UnboundedSender<Message>;
type PeerMap = Arc<Mutex<HashMap<String, Tx>>>;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    let peers: PeerMap = Arc::new(Mutex::new(HashMap::new()));

    let app = Router::new()
        .route("/ws", get(ws_handler))
        .layer(CorsLayer::permissive())
        .with_state(peers);

    let addr = "0.0.0.0:8080";
    println!("=== Custom Remote Signaling Server ===");
    println!("Listening on ws://{}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(peers): State<PeerMap>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, peers))
}

async fn handle_socket(socket: WebSocket, peers: PeerMap) {
    let (mut sender, mut receiver) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();

    let mut current_peer_id: Option<String> = None;

    tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            let _ = sender.send(msg).await;
        }
    });

    while let Some(Ok(msg)) = receiver.next().await {
        if let Message::Text(text) = msg {
            if let Ok(signal) = serde_json::from_str::<SignalMessage>(&text) {
                match signal {
                    SignalMessage::RegisterAgent { peer_id } => {
                        println!("Agent registered with ID: {}", peer_id);
                        current_peer_id = Some(peer_id.clone());
                        peers.lock().unwrap().insert(peer_id.clone(), tx.clone());

                        let response = SignalMessage::AgentRegistered { peer_id };
                        let _ = tx.send(Message::Text(serde_json::to_string(&response).unwrap().into()));
                    }
                    SignalMessage::ConnectToAgent { peer_id } => {
                        let peers_guard = peers.lock().unwrap();
                        if !peers_guard.contains_key(&peer_id) {
                            let err = SignalMessage::PeerNotFound { peer_id: peer_id.clone() };
                            let _ = tx.send(Message::Text(serde_json::to_string(&err).unwrap().into()));
                        }
                    }
                    SignalMessage::SdpOffer { target_peer_id, sdp } => {
                        let peers_guard = peers.lock().unwrap();
                        if let Some(target_tx) = peers_guard.get(&target_peer_id) {
                            let forward = SignalMessage::SdpOffer {
                                target_peer_id: current_peer_id.clone().unwrap_or_default(),
                                sdp,
                            };
                            let _ = target_tx.send(Message::Text(serde_json::to_string(&forward).unwrap().into()));
                        }
                    }
                    SignalMessage::SdpAnswer { target_peer_id, sdp } => {
                        let peers_guard = peers.lock().unwrap();
                        if let Some(target_tx) = peers_guard.get(&target_peer_id) {
                            let forward = SignalMessage::SdpAnswer {
                                target_peer_id: current_peer_id.clone().unwrap_or_default(),
                                sdp,
                            };
                            let _ = target_tx.send(Message::Text(serde_json::to_string(&forward).unwrap().into()));
                        }
                    }
                    SignalMessage::IceCandidate { target_peer_id, candidate } => {
                        let peers_guard = peers.lock().unwrap();
                        if let Some(target_tx) = peers_guard.get(&target_peer_id) {
                            let forward = SignalMessage::IceCandidate {
                                target_peer_id: current_peer_id.clone().unwrap_or_default(),
                                candidate,
                            };
                            let _ = target_tx.send(Message::Text(serde_json::to_string(&forward).unwrap().into()));
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    if let Some(peer_id) = current_peer_id {
        println!("Peer disconnected: {}", peer_id);
        peers.lock().unwrap().remove(&peer_id);
    }
}
