mod capture;
mod gui;
mod input;
mod net;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

fn main() {
    let agent_id = "849302".to_string();
    let server_url = "ws://localhost:8080/ws".to_string();

    let is_running = Arc::new(AtomicBool::new(true));
    let is_running_clone = is_running.clone();
    let server_url_clone = server_url.clone();
    let agent_id_clone = agent_id.clone();

    // Iniciar el loop de red y captura en un thread de Tokio en background
    std::thread::spawn(move || {
        let rt = match tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
        {
            Ok(runtime) => runtime,
            Err(_) => return,
        };

        rt.block_on(async {
            net::run_agent_loop(server_url_clone, agent_id_clone, is_running_clone).await;
        });
    });

    // Iniciar GUI nativa Win32 en el thread principal
    #[cfg(windows)]
    unsafe {
        gui::win_gui::run_gui(&agent_id);
    }

    is_running.store(false, Ordering::Relaxed);
}
