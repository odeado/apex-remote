use serde::{Deserialize, Serialize};

/// Mensajes de señalización entre clientes y servidor de señalización
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SignalMessage {
    RegisterAgent { peer_id: String },
    AgentRegistered { peer_id: String },
    ConnectToAgent { peer_id: String },
    SdpOffer { target_peer_id: String, sdp: String },
    SdpAnswer { target_peer_id: String, sdp: String },
    IceCandidate { target_peer_id: String, candidate: String },
    PeerNotFound { peer_id: String },
    Error { message: String },
}

/// Comandos de control e inyección de entrada (Ratón y Teclado)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum InputEvent {
    MouseMove { x: u32, y: u32 },
    MouseDown { button: MouseButton },
    MouseUp { button: MouseButton },
    MouseScroll { delta_x: i32, delta_y: i32 },
    KeyDown { key_code: u16 },
    KeyUp { key_code: u16 },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum MouseButton {
    Left,
    Right,
    Middle,
}

/// Encabezado de frame de video enviado del agente al cliente
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FrameHeader {
    pub width: u32,
    pub height: u32,
    pub frame_number: u64,
    pub timestamp_ms: u64,
    pub codec: VideoCodec,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum VideoCodec {
    RawBgra,
    Jpeg,
    H264,
    Av1,
}
