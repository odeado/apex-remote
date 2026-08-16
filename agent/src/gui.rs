#[cfg(windows)]
pub mod win_gui {
    use windows::core::*;
    use windows::Win32::Foundation::*;
    use windows::Win32::Graphics::Gdi::*;
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::*;

    static mut AGENT_ID_UTF16: [u16; 32] = [0; 32];

    pub unsafe fn run_gui(id: &str) {
        // Copiar ID de forma 100% segura sin asignaciones dinámicas estáticas (evita crash 0xc0000005)
        let formatted = format!("ID: {}\0", id);
        let utf16: Vec<u16> = formatted.encode_utf16().collect();
        let copy_len = utf16.len().min(31);
        AGENT_ID_UTF16[..copy_len].copy_from_slice(&utf16[..copy_len]);

        let instance = match GetModuleHandleW(None) {
            Ok(inst) => inst,
            Err(_) => return,
        };

        let class_name = w!("ApexRemoteAgentClass");

        let wnd_class = WNDCLASSW {
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(wnd_proc),
            hInstance: instance.into(),
            hbrBackground: HBRUSH(GetStockObject(BLACK_BRUSH).0),
            lpszClassName: class_name,
            ..Default::default()
        };

        RegisterClassW(&wnd_class);

        let hwnd = match CreateWindowExW(
            WINDOW_EX_STYLE(0),
            class_name,
            w!("ApexRemote - Agente Remoto"),
            WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            460,
            240,
            HWND::default(),
            HMENU::default(),
            instance,
            None,
        ) {
            Ok(h) => h,
            Err(_) => return,
        };

        let _ = ShowWindow(hwnd, SW_SHOW);
        let _ = UpdateWindow(hwnd);

        let mut msg = MSG::default();
        while GetMessageW(&mut msg, HWND::default(), 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }

    unsafe extern "system" fn wnd_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match msg {
            WM_PAINT => {
                let mut ps = PAINTSTRUCT::default();
                let hdc = BeginPaint(hwnd, &mut ps);

                SetBkMode(hdc, TRANSPARENT);

                // Dibujar Fondo Oscuro #0a0d12
                let rect = RECT { left: 0, top: 0, right: 460, bottom: 240 };
                let bg_brush = CreateSolidBrush(COLORREF(0x00120d0a));
                FillRect(hdc, &rect, bg_brush);
                let _ = DeleteObject(bg_brush);

                // Título
                SetTextColor(hdc, COLORREF(0x00FEF200)); // Cyan
                let title = w!("⚡ ApexRemote - Agente Remoto");
                let _ = TextOutW(hdc, 20, 20, title.as_wide());

                // Subtítulo
                SetTextColor(hdc, COLORREF(0x00AD998A)); // Gris
                let sub = w!("Dile a quien te va a controlar este ID:");
                let _ = TextOutW(hdc, 20, 50, sub.as_wide());

                // ID Grande de 6 dígitos
                SetTextColor(hdc, COLORREF(0x00FFFFFF)); // Blanco
                let _ = TextOutW(hdc, 20, 85, &AGENT_ID_UTF16);

                // Estado Conectado
                SetTextColor(hdc, COLORREF(0x0076E600)); // Verde #00e676
                let status = w!("● Conectado a Servidor Relay (Listo)");
                let _ = TextOutW(hdc, 20, 135, status.as_wide());

                let _ = EndPaint(hwnd, &ps);
                LRESULT(0)
            }
            WM_DESTROY => {
                PostQuitMessage(0);
                LRESULT(0)
            }
            _ => DefWindowProcW(hwnd, msg, wparam, lparam),
        }
    }
}
