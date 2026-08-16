use crate::capture::capture_engine::ScreenCapturer;
use crate::input::injector::inject_input;
use futures_util::{SinkExt, StreamExt};
use image::{ImageBuffer, Rgb};
use remote_common::InputEvent;
use serde_json::json;
use std::io::Cursor;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio_tungstenite::{connect_async, tungstenite::protocol::Message};

pub async fn run_agent_loop(server_url: String, agent_id: String, is_running: Arc<AtomicBool>) {
    println!("[Net] Conectando agente a {}", server_url);

    loop {
        if !is_running.load(Ordering::Relaxed) {
            break;
        }

        match connect_async(&server_url).await {
            Ok((ws_stream, _)) => {
                println!("[Net] ✅ Conectado exitosamente al Servidor Relay");
                let (mut write, mut read) = ws_stream.split();

                // Registrar agente en el servidor relay
                let reg_msg = json!({
                    "type": "register",
                    "id": agent_id,
                    "hostname": "PC Remoto (ApexRemote Native)",
                    "os": "Windows"
                });

                if let Err(e) = write.send(Message::Text(reg_msg.to_string().into())).await {
                    eprintln!("[Net] Error al enviar registro: {:?}", e);
                    tokio::time::sleep(Duration::from_secs(3)).await;
                    continue;
                }

                let mut capturer = ScreenCapturer::new();
                let mut has_viewers = false;
                let frame_interval = Duration::from_millis(40); // ~25 FPS

                let mut last_frame_time = Instant::now();

                loop {
                    tokio::select! {
                        msg = read.next() => {
                            match msg {
                                Some(Ok(Message::Text(text))) => {
                                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                                        let msg_type = v["type"].as_str().unwrap_or("");
                                        match msg_type {
                                            "registered" => {
                                                println!("[Net] ✅ Registrado OK con ID: {}", agent_id);
                                            }
                                            "viewer_connected" => {
                                                println!("[Net] 👁  Controlador conectado!");
                                                has_viewers = true;
                                            }
                                            "viewer_disconnected" => {
                                                let count = v["count"].as_u64().unwrap_or(0);
                                                if count == 0 {
                                                    println!("[Net] 👁  Todos los controladores se desconectaron");
                                                    has_viewers = false;
                                                }
                                            }
                                            "input" => {
                                                if let Ok(input_evt) = serde_json::from_value::<InputEvent>(v["event"].clone()) {
                                                    inject_input(&input_evt);
                                                }
                                            }
                                            _ => {}
                                        }
                                    }
                                }
                                Some(Ok(Message::Close(_))) | None => {
                                    println!("[Net] Conexión cerrada por el servidor");
                                    break;
                                }
                                _ => {}
                            }
                        }

                        _ = tokio::time::sleep(frame_interval) => {
                            if has_viewers && last_frame_time.elapsed() >= frame_interval {
                                last_frame_time = Instant::now();
                                if let Some(raw_bgra) = capturer.capture_frame() {
                                    if let Some(jpeg_bytes) = compress_bgra_to_jpeg(&raw_bgra, capturer.width, capturer.height) {
                                        if let Err(_) = write.send(Message::Binary(jpeg_bytes.into())).await {
                                            break;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            Err(e) => {
                eprintln!("[Net] Error de conexión: {:?}. Reintentando en 3s...", e);
            }
        }

        tokio::time::sleep(Duration::from_secs(3)).await;
    }
}

fn compress_bgra_to_jpeg(bgra: &[u8], width: u32, height: u32) -> Option<Vec<u8>> {
    let mut rgb_buf = vec![0u8; (width * height * 3) as usize];
    let total_pixels = (width * height) as usize;

    for i in 0..total_pixels {
        let b = bgra[i * 4];
        let g = bgra[i * 4 + 1];
        let r = bgra[i * 4 + 2];

        rgb_buf[i * 3] = r;
        rgb_buf[i * 3 + 1] = g;
        rgb_buf[i * 3 + 2] = b;
    }

    let img: ImageBuffer<Rgb<u8>, Vec<u8>> = ImageBuffer::from_raw(width, height, rgb_buf)?;
    let mut jpeg_bytes = Vec::new();
    let mut cursor = Cursor::new(&mut jpeg_bytes);

    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, 65);
    encoder.encode_image(&img).ok()?;

    Some(jpeg_bytes)
}
