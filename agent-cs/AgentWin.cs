using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.Authentication;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

/*
 * ApexRemote Agent v3.0 – WebSocket nativo (sin ClientWebSocket)
 * ─────────────────────────────────────────────────────────────
 * Implementa el cliente WebSocket manualmente sobre TcpClient + SslStream
 * para máxima compatibilidad (Windows 7 SP1 .NET 4.0+).
 *
 * Flujo:
 *   1. Conectar TCP → SslStream TLS 1.2 → WebSocket handshake
 *   2. Enviar {"type":"register","id":"..."} al relay
 *   3. Hilo RECV: leer mensajes de texto (inputs) y procesarlos
 *   4. Hilo SEND: capturar pantalla a 25 FPS y enviar binario JPEG
 *   5. Si WS falla → fallback HTTP polling (modo legacy)
 */

namespace ApexRemote
{
    static class Program
    {
        [STAThread]
        static void Main(string[] args)
        {
            try {
                ServicePointManager.SecurityProtocol =
                    (SecurityProtocolType)3072 |    // TLS 1.2
                    (SecurityProtocolType)768  |    // TLS 1.1
                    SecurityProtocolType.Tls;
                ServicePointManager.ServerCertificateValidationCallback = (s, c, ch, e) => true;
                ServicePointManager.DefaultConnectionLimit = 16;
            } catch {}

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            string host = args.Length > 0 ? args[0] : "apex-remote-production.up.railway.app";
            string id   = args.Length > 1 ? args[1] : new Random().Next(100000, 999999).ToString();

            Application.Run(new AgentForm(host, id));
        }
    }

    // Tipo simple para reemplazar tuplas (C# 5 no soporta ValueTuple)
    class WsFrame { public int Opcode; public byte[] Data; }

    // ─────────────────────────────────────────────────────────────────────────
    //  Cliente WebSocket mínimo para .NET 4.0+ / Windows 7+
    // ─────────────────────────────────────────────────────────────────────────
    class MinWsClient : IDisposable
    {
        TcpClient _tcp;
        Stream    _net;
        readonly object _wlock = new object();
        public bool Connected;

        public bool Connect(string host, int port, bool tls, string path)
        {
            try {
                _tcp         = new TcpClient();
                _tcp.NoDelay = true;
                _tcp.Connect(host, port);

                Stream raw = _tcp.GetStream();
                if (tls) {
                    var ssl = new SslStream(raw, false, (s, c, ch, e) => true);
                    ssl.AuthenticateAsClient(host, null,
                        (SslProtocols)3072 | (SslProtocols)768,  // TLS 1.2 + 1.1
                        false);
                    _net = ssl;
                } else {
                    _net = raw;
                }

                string key = Convert.ToBase64String(Guid.NewGuid().ToByteArray());
                byte[] hs  = Encoding.ASCII.GetBytes(
                    "GET " + path + " HTTP/1.1\r\n" +
                    "Host: " + host + "\r\n" +
                    "Upgrade: websocket\r\n" +
                    "Connection: Upgrade\r\n" +
                    "Sec-WebSocket-Key: " + key + "\r\n" +
                    "Sec-WebSocket-Version: 13\r\n\r\n");
                _net.Write(hs, 0, hs.Length);

                byte[] rb = new byte[2048];
                int    n  = _net.Read(rb, 0, rb.Length);
                string r  = Encoding.ASCII.GetString(rb, 0, n);
                Connected = r.Contains("101");
                return Connected;
            }
            catch { return false; }
        }

        // Enviar frame de texto (JSON), enmascarado como cliente WebSocket
        public void SendText(string text)
        {
            SendFrame(0x81, Encoding.UTF8.GetBytes(text));
        }

        // Enviar frame binario (JPEG), enmascarado
        public void SendBinary(byte[] data)
        {
            SendFrame(0x82, data);
        }

        void SendFrame(byte opcode, byte[] payload)
        {
            var ms = new MemoryStream();
            ms.WriteByte((byte)(opcode | 0x80)); // FIN + opcode

            byte[] mask = new byte[4];
            new Random().NextBytes(mask);

            long len = payload.Length;
            if (len < 126) {
                ms.WriteByte((byte)(0x80 | len));
            } else if (len < 65536) {
                ms.WriteByte(0x80 | 126);
                ms.WriteByte((byte)(len >> 8));
                ms.WriteByte((byte)(len & 0xFF));
            } else {
                ms.WriteByte(0x80 | 127);
                for (int i = 7; i >= 0; i--)
                    ms.WriteByte((byte)((len >> (i * 8)) & 0xFF));
            }
            ms.Write(mask, 0, 4);

            byte[] masked = new byte[payload.Length];
            for (int i = 0; i < payload.Length; i++)
                masked[i] = (byte)(payload[i] ^ mask[i % 4]);
            ms.Write(masked, 0, masked.Length);

            byte[] frame = ms.ToArray();
            lock (_wlock) { _net.Write(frame, 0, frame.Length); }
        }

        // Leer un frame completo (bloquea hasta que llegue)
        // Devuelve: opcode y payload sin máscara
        public WsFrame ReadFrame()
        {
            byte b0 = ReadByte();
            byte b1 = ReadByte();

            int  opcode = b0 & 0x0F;
            bool masked = (b1 & 0x80) != 0;
            long len    = b1 & 0x7F;

            if (len == 126) {
                len = (ReadByte() << 8) | ReadByte();
            } else if (len == 127) {
                len = 0;
                for (int i = 0; i < 8; i++) len = (len << 8) | ReadByte();
            }

            byte[] maskBytes = null;
            if (masked) {
                maskBytes = new byte[] { ReadByte(), ReadByte(), ReadByte(), ReadByte() };
            }

            byte[] data = new byte[len];
            int totalRead = 0;
            while (totalRead < len) {
                int r = _net.Read(data, totalRead, (int)len - totalRead);
                if (r <= 0) throw new EndOfStreamException("WebSocket cerrado");
                totalRead += r;
            }

            if (masked) {
                for (int i = 0; i < len; i++) data[i] ^= maskBytes[i % 4];
            }

            return new WsFrame { Opcode = opcode, Data = data };
        }

        byte ReadByte()
        {
            int b = _net.ReadByte();
            if (b < 0) throw new EndOfStreamException("WebSocket cerrado");
            return (byte)b;
        }

        public void Dispose() { try { _tcp.Close(); } catch {} }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Formulario principal del Agente
    // ─────────────────────────────────────────────────────────────────────────
    public class AgentForm : Form
    {
        [DllImport("shell32.dll")]
        static extern void SHChangeNotify(int wEventId, uint uFlags, IntPtr dwItem1, IntPtr dwItem2);
        [DllImport("user32.dll", SetLastError = true)]
        static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
        [DllImport("user32.dll")] static extern bool DrawIconEx(IntPtr hdc, int x, int y, IntPtr hIcon, int cx, int cy, uint step, IntPtr br, uint di);
        [DllImport("user32.dll")] static extern bool GetCursorInfo(out CURSORINFO pci);

        const int  INPUT_MOUSE    = 0;
        const int  INPUT_KEYBOARD = 1;
        const uint MOUSEEVENTF_MOVE       = 0x0001;
        const uint MOUSEEVENTF_LEFTDOWN   = 0x0002;
        const uint MOUSEEVENTF_LEFTUP     = 0x0004;
        const uint MOUSEEVENTF_RIGHTDOWN  = 0x0008;
        const uint MOUSEEVENTF_RIGHTUP    = 0x0010;
        const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
        const uint MOUSEEVENTF_MIDDLEUP   = 0x0040;
        const uint MOUSEEVENTF_WHEEL      = 0x0800;
        const uint KEYEVENTF_KEYUP        = 0x0002;
        const uint CURSOR_SHOWING         = 0x00000001;
        const uint DI_NORMAL              = 0x0003;

        [StructLayout(LayoutKind.Sequential)] struct PT         { public int x, y; }
        [StructLayout(LayoutKind.Sequential)] struct CURSORINFO { public int cbSize, flags; public IntPtr hCursor; public PT ptScreenPos; }

        [StructLayout(LayoutKind.Sequential)]
        struct MOUSEINPUT  { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Sequential)]
        struct KEYBDINPUT  { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Sequential)]
        struct HARDWAREINPUT { public uint uMsg; public ushort wParamL, wParamH; }
        [StructLayout(LayoutKind.Explicit)]
        struct INPUT_UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public HARDWAREINPUT hi; }
        [StructLayout(LayoutKind.Sequential)]
        struct INPUT { public int type; public INPUT_UNION u; }

        void Click(uint downFlag, uint upFlag)
        {
            var inputs = new INPUT[2];
            inputs[0].type = INPUT_MOUSE; inputs[0].u.mi.dwFlags = downFlag;
            inputs[1].type = INPUT_MOUSE; inputs[1].u.mi.dwFlags = upFlag;
            SendInput(2, inputs, System.Runtime.InteropServices.Marshal.SizeOf(typeof(INPUT)));
        }

        void SendMouseButton(uint flag)
        {
            var inputs = new INPUT[1];
            inputs[0].type = INPUT_MOUSE; inputs[0].u.mi.dwFlags = flag;
            SendInput(1, inputs, System.Runtime.InteropServices.Marshal.SizeOf(typeof(INPUT)));
        }

        void SendKey(ushort vk, bool keyUp)
        {
            var inputs = new INPUT[1];
            inputs[0].type = INPUT_KEYBOARD;
            inputs[0].u.ki.wVk   = vk;
            inputs[0].u.ki.dwFlags = keyUp ? KEYEVENTF_KEYUP : 0;
            SendInput(1, inputs, System.Runtime.InteropServices.Marshal.SizeOf(typeof(INPUT)));
        }

        void SendWheel(int delta)
        {
            var inputs = new INPUT[1];
            inputs[0].type = INPUT_MOUSE;
            inputs[0].u.mi.dwFlags    = MOUSEEVENTF_WHEEL;
            inputs[0].u.mi.mouseData  = (uint)delta;
            SendInput(1, inputs, System.Runtime.InteropServices.Marshal.SizeOf(typeof(INPUT)));
        }


        readonly string _host;
        readonly string _id;
        readonly string _pin;
        readonly CancellationTokenSource _cts = new CancellationTokenSource();

        volatile bool _hasViewers = false;
        MinWsClient   _ws         = null;
        bool          _wsMode     = false;

        Label lblStatus;
        Label lblFps;

        // ── Portapapeles y calidad ──────────────────────────────────────────
        string _lastClipboardText = "";
        volatile int _screenW = 1280;
        volatile int _screenH = 720;
        volatile int _jpegQ   = 45;

        public AgentForm(string host, string id)
        {
            _host = host;
            _id   = id;
            _pin  = new Random().Next(1000, 9999).ToString();
            BuildUI();
            StartAgent();
            StartClipboardLoop();
        }

        void BuildUI()
        {
            Text        = "ApexRemote";
            Size        = new Size(440, 210);
            MinimumSize = Size;
            MaximumSize = Size;
            StartPosition = FormStartPosition.CenterScreen;
            BackColor   = Color.FromArgb(10, 13, 20);

            var panel = new Panel { Location = new Point(14, 10), Size = new Size(408, 160), BackColor = Color.FromArgb(17, 22, 32) };

            var t = new Label { Text = "⚡ ApexRemote", Font = new Font("Segoe UI", 15, FontStyle.Bold),
                ForeColor = Color.FromArgb(0, 229, 255), Location = new Point(14, 10), AutoSize = true };

            var s = new Label { Text = "ID y PIN para conexión remota:",
                Font = new Font("Segoe UI", 9), ForeColor = Color.FromArgb(90, 106, 128),
                Location = new Point(16, 40), AutoSize = true };

            var idLbl = new Label { Text = _id, Font = new Font("Consolas", 22, FontStyle.Bold),
                ForeColor = Color.White, Location = new Point(14, 60), AutoSize = true };

            var pinLbl = new Label { Text = "PIN: " + _pin, Font = new Font("Consolas", 14, FontStyle.Bold),
                ForeColor = Color.FromArgb(0, 229, 255), Location = new Point(165, 66), AutoSize = true };

            var btn = new Button { Text = "Copiar ID", Font = new Font("Segoe UI", 9, FontStyle.Bold),
                ForeColor = Color.Black, BackColor = Color.FromArgb(0, 229, 255), FlatStyle = FlatStyle.Flat,
                Location = new Point(282, 63), Size = new Size(108, 34), Cursor = Cursors.Hand };
            btn.FlatAppearance.BorderSize = 0;
            btn.Click += (o, e) => {
                Clipboard.SetText(_id);
                btn.Text = "✓ Copiado";
                Task.Delay(1500).ContinueWith(_ => Invoke((Action)(() => btn.Text = "Copiar ID")));
            };

            lblStatus = new Label { Text = "🟡 Conectando...", Font = new Font("Segoe UI", 9),
                ForeColor = Color.FromArgb(200, 160, 0), Location = new Point(16, 112), AutoSize = true };

            lblFps = new Label { Text = "", Font = new Font("Consolas", 8),
                ForeColor = Color.FromArgb(60, 80, 100), Location = new Point(16, 132), AutoSize = true };

            panel.Controls.AddRange(new Control[] { t, s, idLbl, pinLbl, btn, lblStatus, lblFps });
            Controls.Add(panel);
        }

        // ══════════════════════════════════════════════════════════════════════
        //  Inicio del agente: intentar WebSocket → fallback a HTTP
        // ══════════════════════════════════════════════════════════════════════
        void StartAgent()
        {
            SetStatus("🟡 Conectando al servidor...", Color.FromArgb(200, 160, 0));

            new Thread(() => {
                // Intentar WebSocket
                bool local = _host == "localhost" || _host == "127.0.0.1" || _host.StartsWith("192.168.");
                _ws = new MinWsClient();
                bool ok = local
                    ? _ws.Connect(_host, 8080, false, "/ws")
                    : _ws.Connect(_host, 443, true, "/ws");

                if (ok) {
                    _wsMode = true;
                    // Registrar
                    _ws.SendText("{\"type\":\"register\",\"id\":\"" + _id + "\",\"hostname\":\"" + Environment.MachineName + "\"}");
                    SetStatus("🟢 Conectado WebSocket – esperando controlador", Color.FromArgb(0, 220, 100));
                    StartWsReceiveLoop();
                    StartWsFrameLoop();
                } else {
                    _ws = null;
                    _wsMode = false;
                    SetStatus("🟠 WebSocket no disponible, usando HTTP...", Color.Orange);
                    // Fallback HTTP
                    StartHttpInputLoop();
                    StartHttpFrameLoop();
                }
            }) { IsBackground = true }.Start();
        }

        // ══════════════════════════════════════════════════════════════════════
        //  MODO WEBSOCKET
        // ══════════════════════════════════════════════════════════════════════

        // Hilo RECV: lee mensajes entrantes del relay (inputs de mouse/teclado)
        void StartWsReceiveLoop()
        {
            new Thread(() => {
                while (!_cts.IsCancellationRequested && _ws != null)
                {
                    try {
                        WsFrame frame = _ws.ReadFrame();
                        int opcode = frame.Opcode;
                        byte[] data = frame.Data;

                        if (opcode == 8) break; // Close frame

                        if (opcode == 1) // Text frame = JSON
                        {
                            string msg = Encoding.UTF8.GetString(data);

                            if (msg.Contains("\"viewer_connected\""))
                            {
                                _hasViewers = true;
                                SetStatus("🔵 Transmitiendo – controlador conectado", Color.FromArgb(0, 180, 255));
                            }
                            else if (msg.Contains("\"viewer_disconnected\"") || msg.Contains("\"count\":0"))
                            {
                                _hasViewers = false;
                                SetStatus("🟢 Conectado – esperando controlador", Color.FromArgb(0, 220, 100));
                            }
                            else if (msg.Contains("\"type\":\"file_chunk\""))
                            {
                                HandleFileChunk(msg);
                            }
                            else if (msg.Contains("\"type\":\"input\""))
                            {
                                // Extraer el objeto event
                                int ei = msg.IndexOf("\"event\":");
                                if (ei >= 0)
                                {
                                    int es = msg.IndexOf("{", ei);
                                    int ee = msg.LastIndexOf("}");
                                    if (es >= 0 && ee > es)
                                        ExecEvent(msg.Substring(es, ee - es + 1));
                                }
                            }
                            else if (msg.Contains("\"type\":\"fs_list\""))
                            {
                                string p = GetStr(msg, "path");
                                new Thread(() => HandleFsList(string.IsNullOrEmpty(p) ? @"C:\Users" : p)) { IsBackground = true }.Start();
                            }
                            else if (msg.Contains("\"type\":\"fs_delete\""))
                            {
                                string p = GetStr(msg, "path");
                                if (!string.IsNullOrEmpty(p)) new Thread(() => HandleFsDelete(p)) { IsBackground = true }.Start();
                            }
                            else if (msg.Contains("\"type\":\"fs_mkdir\""))
                            {
                                string p = GetStr(msg, "path");
                                if (!string.IsNullOrEmpty(p)) new Thread(() => HandleFsMkdir(p)) { IsBackground = true }.Start();
                            }
                            else if (msg.Contains("\"type\":\"fs_download\""))
                            {
                                string p = GetStr(msg, "path");
                                if (!string.IsNullOrEmpty(p)) new Thread(() => HandleFsDownload(p)) { IsBackground = true }.Start();
                            }
                        }
                    }
                    catch { break; }
                }

                // Si el hilo recv muere, reconectar
                if (!_cts.IsCancellationRequested)
                {
                    _ws = null;
                    _wsMode = false;
                    Thread.Sleep(2000);
                    SetStatus("🟠 Reconectando...", Color.Orange);
                    StartAgent();
                }
            }) { IsBackground = true }.Start();
        }

        // Hilo SEND: captura pantalla y envía frames binarios JPEG vía WS
        // ── Buffer compartido entre captura y envio ───────────────────────────
        volatile byte[] _latestFrame = null;
        readonly AutoResetEvent _frameReady = new AutoResetEvent(false);

        void StartWsFrameLoop()
        {
            // HILO 1 - Captura + codifica JPEG sin esperar al envio (producer)
            new Thread(() => {
                while (!_cts.IsCancellationRequested && _wsMode)
                {
                    if (_hasViewers)
                    {
                        byte[] jpeg = CaptureScreen();
                        if (jpeg.Length > 0) { _latestFrame = jpeg; _frameReady.Set(); }
                        Thread.Sleep(1);
                    }
                    else { Thread.Sleep(100); }
                }
            }) { IsBackground = true, Priority = ThreadPriority.AboveNormal }.Start();

            // HILO 2 - Envia el ultimo frame disponible (consumer)
            new Thread(() => {
                int frames = 0; long tsBase = DateTime.UtcNow.Ticks;
                while (!_cts.IsCancellationRequested && _ws != null && _wsMode)
                {
                    _frameReady.WaitOne(200);
                    byte[] frame = _latestFrame;
                    _latestFrame = null;
                    if (frame == null || !_hasViewers) continue;
                    try { _ws.SendBinary(frame); } catch { break; }
                    frames++;
                    long diff = DateTime.UtcNow.Ticks - tsBase;
                    if (diff >= 10000000) {
                        double fps = frames * 10000000.0 / diff;
                        SetFps(string.Format("{0:0.0} FPS  {1}x{2}  {3}KB  [WS]", fps, _screenW, _screenH, frame.Length / 1024));
                        frames = 0; tsBase = DateTime.UtcNow.Ticks;
                    }
                }
            }) { IsBackground = true, Priority = ThreadPriority.Highest }.Start();
        }

        // ══════════════════════════════════════════════════════════════════════
        //  MODO HTTP (Fallback) – Long-Poll inputs + HTTP frame POST
        // ══════════════════════════════════════════════════════════════════════
        async void StartHttpInputLoop()
        {
            string baseUrl = BuildBaseUrl();
            string pollUrl = baseUrl + "/api/agent/poll?id=" + _id;

            while (!_cts.IsCancellationRequested)
            {
                bool hadError = false;
                try {
                    var req = MakeReq(pollUrl);
                    req.Method  = "GET";
                    req.Timeout = 10000;
                    using (var resp   = (HttpWebResponse)req.GetResponse())
                    using (var reader = new StreamReader(resp.GetResponseStream()))
                    {
                        string body = reader.ReadToEnd();
                        if (body.Contains("\"inputs\":[{")) ProcessInputJson(body);
                    }
                }
                catch { hadError = true; }

                if (hadError) await Task.Delay(300);
            }
        }

        async void StartHttpFrameLoop()
        {
            string baseUrl  = BuildBaseUrl();
            string frameUrl = baseUrl + "/api/agent/frame?id=" + _id;
            int    frames   = 0;
            long   tsBase   = DateTime.UtcNow.Ticks;

            try {
                var reg = MakeReq(baseUrl + "/api/agent/register");
                reg.Method = "POST"; reg.ContentType = "application/json";
                byte[] rb = Encoding.UTF8.GetBytes("{\"id\":\"" + _id + "\",\"hostname\":\"" + Environment.MachineName + "\"}");
                reg.ContentLength = rb.Length;
                using (var s = reg.GetRequestStream()) s.Write(rb, 0, rb.Length);
                using (reg.GetResponse()) {}
                SetStatus("🟢 Conectado HTTP – esperando controlador", Color.FromArgb(0, 220, 100));
            } catch {}

            while (!_cts.IsCancellationRequested)
            {
                bool hadError = false;
                try {
                    byte[] jpeg = _hasViewers ? CaptureScreen() : new byte[0];
                    var req = MakeReq(frameUrl);
                    req.Method = "POST"; req.ContentType = "image/jpeg";
                    req.ContentLength = jpeg.Length; req.Timeout = 4000;
                    if (jpeg.Length > 0)
                        using (var s = req.GetRequestStream()) s.Write(jpeg, 0, jpeg.Length);

                    using (var resp   = (HttpWebResponse)req.GetResponse())
                    using (var reader = new StreamReader(resp.GetResponseStream()))
                    {
                        string body = reader.ReadToEnd();
                        bool v = body.Contains("\"hasViewers\":true");
                        if (v && !_hasViewers) SetStatus("🔵 Transmitiendo – controlador conectado", Color.FromArgb(0, 180, 255));
                        if (!v && _hasViewers) SetStatus("🟢 Conectado HTTP – esperando controlador", Color.FromArgb(0, 220, 100));
                        _hasViewers = v;
                    }

                    if (_hasViewers) {
                        frames++;
                        long diff = DateTime.UtcNow.Ticks - tsBase;
                        if (diff >= 10000000) {
                            double fps = frames * 10000000.0 / diff;
                            SetFps(string.Format("{0:0.0} FPS  ·  {1}×{2}  [HTTP]", fps, _screenW, _screenH));
                            frames = 0; tsBase = DateTime.UtcNow.Ticks;
                        }
                    }
                }
                catch { hadError = true; }

                if (hadError) await Task.Delay(500);
                else          await Task.Delay(_hasViewers ? 40 : 1000);
            }
        }

        // ══════════════════════════════════════════════════════════════════════
        //  Parseo de inputs y ejecución Win32
        // ══════════════════════════════════════════════════════════════════════
        void ProcessInputJson(string json)
        {
            try {
                int s1 = json.IndexOf("[{");
                int s2 = json.LastIndexOf("}]");
                if (s1 < 0 || s2 < 0) return;
                string arr = json.Substring(s1 + 1, s2 - s1);
                int depth = 0, start = 0;
                for (int i = 0; i <= arr.Length; i++) {
                    char c = i < arr.Length ? arr[i] : ',';
                    if      (c == '{') depth++;
                    else if (c == '}') { depth--; if (depth == 0) { ExecEvent(arr.Substring(start, i - start + 1)); start = i + 2; } }
                }
            } catch {}
        }

        void ExecEvent(string ev)
        {
            try {
                if (ev.Contains("MouseMoveDelta")) {
                    int dx = (int)GetNum(ev, "dx");
                    int dy = (int)GetNum(ev, "dy");
                    if (dx != 0 || dy != 0) {
                        var inputs = new INPUT[1];
                        inputs[0].type = INPUT_MOUSE;
                        inputs[0].u.mi.dx = dx;
                        inputs[0].u.mi.dy = dy;
                        inputs[0].u.mi.dwFlags = MOUSEEVENTF_MOVE;
                        SendInput(1, inputs, System.Runtime.InteropServices.Marshal.SizeOf(typeof(INPUT)));
                    }
                }
                else if (ev.Contains("MouseMove")) {
                    double rx = GetNum(ev, "rx"), ry = GetNum(ev, "ry");
                    var b = Screen.PrimaryScreen.Bounds;
                    int x = b.X + (int)(rx * b.Width), y = b.Y + (int)(ry * b.Height);
                    if (Math.Abs(Cursor.Position.X - x) > 1 || Math.Abs(Cursor.Position.Y - y) > 1)
                        Cursor.Position = new Point(x, y);
                }
                else if (ev.Contains("MouseDown")) {
                    if (ev.Contains("Left"))   SendMouseButton(MOUSEEVENTF_LEFTDOWN);
                    if (ev.Contains("Right"))  SendMouseButton(MOUSEEVENTF_RIGHTDOWN);
                    if (ev.Contains("Middle")) SendMouseButton(MOUSEEVENTF_MIDDLEDOWN);
                }
                else if (ev.Contains("MouseUp")) {
                    if (ev.Contains("Left"))   SendMouseButton(MOUSEEVENTF_LEFTUP);
                    if (ev.Contains("Right"))  SendMouseButton(MOUSEEVENTF_RIGHTUP);
                    if (ev.Contains("Middle")) SendMouseButton(MOUSEEVENTF_MIDDLEUP);
                }
                else if (ev.Contains("MouseScroll")) {
                    SendWheel(-(int)GetNum(ev, "delta_y") * 120);
                }
                else if (ev.Contains("KeyDown")) {
                    SendKey((ushort)GetNum(ev, "key_code"), false);
                }
                else if (ev.Contains("KeyUp")) {
                    SendKey((ushort)GetNum(ev, "key_code"), true);
                }
                else if (ev.Contains("SetQuality")) {
                    int w = (int)GetNum(ev, "w");
                    int h = (int)GetNum(ev, "h");
                    int q = (int)GetNum(ev, "q");
                    if (w > 0 && h > 0 && q > 0) {
                        _screenW = w;
                        _screenH = h;
                        _jpegQ   = q;
                    }
                }
                else if (ev.Contains("FileChunk") || ev.Contains("file_chunk")) {
                    HandleFileChunk(ev);
                }
                else if (ev.Contains("ClipboardSync") || ev.Contains("clipboard_sync")) {
                    string txt = GetStr(ev, "text");
                    if (!string.IsNullOrEmpty(txt)) {
                        _lastClipboardText = txt;
                        STA(() => Clipboard.SetText(txt));
                        SetStatus("📋 Portapapeles sincronizado", Color.FromArgb(0, 220, 100));
                        Task.Delay(3000).ContinueWith(_ => SetStatus("🔵 Transmitiendo – controlador conectado", Color.FromArgb(0, 180, 255)));
                    }
                }
                else if (ev.Contains("fs_list")) {
                    string p = GetStr(ev, "path");
                    HandleFsList(string.IsNullOrEmpty(p) ? @"C:\Users" : p);
                }
                else if (ev.Contains("fs_delete")) {
                    string p = GetStr(ev, "path");
                    HandleFsDelete(p);
                }
                else if (ev.Contains("fs_mkdir")) {
                    string p = GetStr(ev, "path");
                    HandleFsMkdir(p);
                }
            } catch {}
        }

        void StartClipboardLoop()
        {
            new Thread(() => {
                while (!_cts.IsCancellationRequested) {
                    try {
                        if (_hasViewers) {
                            string txt = STA(() => Clipboard.ContainsText() ? Clipboard.GetText() : null);
                            if (!string.IsNullOrEmpty(txt) && txt != _lastClipboardText && txt.Length < 100000) {
                                _lastClipboardText = txt;
                                SendClipboardToController(txt);
                            }
                        }
                    } catch {}
                    Thread.Sleep(800);
                }
            }) { IsBackground = true }.Start();
        }

        void SendClipboardToController(string text)
        {
            try {
                string json = "{\"type\":\"clipboard_sync\",\"text\":\"" + EscapeJson(text) + "\"}";
                if (_ws != null && _wsMode) _ws.SendText(json);
            } catch {}
        }

        static string EscapeJson(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            return s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\n", "\\n").Replace("\r", "\\r");
        }

        static T STA<T>(Func<T> func)
        {
            T val = default(T);
            var t = new Thread(() => { try { val = func(); } catch {} });
            t.SetApartmentState(ApartmentState.STA);
            t.Start();
            t.Join();
            return val;
        }

        static void STA(Action act)
        {
            var t = new Thread(() => { try { act(); } catch {} });
            t.SetApartmentState(ApartmentState.STA);
            t.Start();
            t.Join();
        }

        // ── Explorador de Archivos Remoto (Remote File System API) ───────────
        void SendFsListRes(string path, string jsonArray)
        {
            try {
                string msg = "{\"type\":\"fs_list_res\",\"path\":\"" + EscapeJson(path) + "\",\"items\":" + jsonArray + "}";
                if (_ws != null && _wsMode) _ws.SendText(msg);
            } catch {}
        }

        void HandleFsList(string path)
        {
            try {
                if (string.IsNullOrEmpty(path) || path == "drives") {
                    var drives = System.IO.DriveInfo.GetDrives();
                    var items = new System.Collections.Generic.List<string>();
                    foreach (var d in drives) {
                        if (d.IsReady) items.Add("{\"name\":\"" + EscapeJson(d.Name) + "\",\"isDir\":true,\"size\":0,\"date\":\"\"}");
                    }
                    SendFsListRes("drives", "[" + string.Join(",", items.ToArray()) + "]");
                    return;
                }

                if (!System.IO.Directory.Exists(path)) path = @"C:\Users";

                var list = new System.Collections.Generic.List<string>();
                foreach (var dir in System.IO.Directory.GetDirectories(path)) {
                    try {
                        var info = new System.IO.DirectoryInfo(dir);
                        list.Add("{\"name\":\"" + EscapeJson(info.Name) + "\",\"isDir\":true,\"size\":0,\"date\":\"" + info.LastWriteTime.ToString("yyyy-MM-dd HH:mm") + "\"}");
                    } catch {}
                }
                foreach (var file in System.IO.Directory.GetFiles(path)) {
                    try {
                        var info = new System.IO.FileInfo(file);
                        list.Add("{\"name\":\"" + EscapeJson(info.Name) + "\",\"isDir\":false,\"size\":" + info.Length + ",\"date\":\"" + info.LastWriteTime.ToString("yyyy-MM-dd HH:mm") + "\"}");
                    } catch {}
                }
                SendFsListRes(path, "[" + string.Join(",", list.ToArray()) + "]");
            } catch {
                SendFsListRes(path, "[]");
            }
        }

        void HandleFsDelete(string targetPath)
        {
            try {
                if (System.IO.File.Exists(targetPath)) System.IO.File.Delete(targetPath);
                else if (System.IO.Directory.Exists(targetPath)) System.IO.Directory.Delete(targetPath, true);
                string parent = System.IO.Path.GetDirectoryName(targetPath);
                HandleFsList(string.IsNullOrEmpty(parent) ? @"C:\Users" : parent);
            } catch {}
        }

        void HandleFsMkdir(string targetPath)
        {
            try {
                if (!System.IO.Directory.Exists(targetPath)) System.IO.Directory.CreateDirectory(targetPath);
                HandleFsList(targetPath);
            } catch {}
        }

        // Enviar archivo del equipo remoto al viewer (en chunks base64)
        void HandleFsDownload(string filePath)
        {
            try {
                if (!System.IO.File.Exists(filePath)) return;
                byte[] data = System.IO.File.ReadAllBytes(filePath);
                string b64full = Convert.ToBase64String(data);
                string name = System.IO.Path.GetFileName(filePath);
                const int CHUNK = 12000;
                int total = (int)Math.Ceiling((double)b64full.Length / CHUNK);
                for (int k = 0; k < total; k++)
                {
                    string chunk = b64full.Substring(k * CHUNK, Math.Min(CHUNK, b64full.Length - k * CHUNK));
                    string msg = "{\"type\":\"file_download_chunk\",\"name\":\"" + EscapeJson(name) + "\",\"idx\":" + k + ",\"total\":" + total + ",\"b64\":\"" + chunk + "\"}";
                    if (_ws != null && _wsMode) _ws.SendText(msg);
                    System.Threading.Thread.Sleep(5);
                }
            } catch {}
        }

        double GetNum(string json, string key)
        {
            string tok = "\"" + key + "\":";
            int ki = json.IndexOf(tok);
            if (ki < 0) return 0;
            int vs = ki + tok.Length, ve = vs;
            while (ve < json.Length && (char.IsDigit(json[ve]) || json[ve] == '.' || json[ve] == '-')) ve++;
            if (ve == vs) return 0;
            return double.Parse(json.Substring(vs, ve - vs), System.Globalization.CultureInfo.InvariantCulture);
        }

        // File chunk accumulator
        System.Collections.Generic.Dictionary<string, System.Collections.Generic.List<string>> _fileChunks =
            new System.Collections.Generic.Dictionary<string, System.Collections.Generic.List<string>>();

        void HandleFileChunk(string msg)
        {
            try {
                string name  = GetStr(msg, "name");
                int    idx   = (int)GetNum(msg, "idx");
                int    total = (int)GetNum(msg, "total");
                string b64   = GetStr(msg, "b64");

                if (string.IsNullOrEmpty(name) || string.IsNullOrEmpty(b64)) return;

                if (idx == 0 || !_fileChunks.ContainsKey(name))
                    _fileChunks[name] = new System.Collections.Generic.List<string>();

                var chunks = _fileChunks[name];
                while (chunks.Count <= idx) chunks.Add(null);
                chunks[idx] = b64;

                if (chunks.Count >= total) {
                    bool complete = true;
                    for (int k = 0; k < total; k++) {
                        if (k >= chunks.Count || chunks[k] == null) { complete = false; break; }
                    }

                    if (complete) {
                        var sb = new StringBuilder();
                        for (int k = 0; k < total; k++) sb.Append(chunks[k]);
                        byte[] data = Convert.FromBase64String(sb.ToString());

                        string nameOnly  = System.IO.Path.GetFileName(name);
                        string savedPath = "";

                        // Guardar en C:\Users\Public\Downloads
                        try {
                            string pubDl = @"C:\Users\Public\Downloads";
                            if (!System.IO.Directory.Exists(pubDl)) System.IO.Directory.CreateDirectory(pubDl);
                            savedPath = System.IO.Path.Combine(pubDl, nameOnly);
                            System.IO.File.WriteAllBytes(savedPath, data);
                        } catch {}

                        // Guardar en C:\Users\Public\Desktop
                        try {
                            string pubDesk = Environment.GetFolderPath(Environment.SpecialFolder.CommonDesktopDirectory);
                            if (!string.IsNullOrEmpty(pubDesk) && System.IO.Directory.Exists(pubDesk))
                                System.IO.File.WriteAllBytes(System.IO.Path.Combine(pubDesk, nameOnly), data);
                        } catch {}

                        // Guardar en TODOS los perfiles de usuario en C:\Users (Admin, Administrator, etc.)
                        try {
                            string usersRoot = @"C:\Users";
                            if (System.IO.Directory.Exists(usersRoot)) {
                                foreach (string userDir in System.IO.Directory.GetDirectories(usersRoot)) {
                                    string folderName = System.IO.Path.GetFileName(userDir).ToLower();
                                    if (folderName == "public" || folderName == "default" || folderName == "default user" || folderName == "all users") continue;

                                    // Descargas
                                    try {
                                        string dl = System.IO.Path.Combine(userDir, "Downloads");
                                        if (!System.IO.Directory.Exists(dl)) System.IO.Directory.CreateDirectory(dl);
                                        string p = System.IO.Path.Combine(dl, nameOnly);
                                        System.IO.File.WriteAllBytes(p, data);
                                        if (string.IsNullOrEmpty(savedPath)) savedPath = p;
                                    } catch {}

                                    // Escritorio
                                    try {
                                        string desk = System.IO.Path.Combine(userDir, "Desktop");
                                        if (System.IO.Directory.Exists(desk))
                                            System.IO.File.WriteAllBytes(System.IO.Path.Combine(desk, nameOnly), data);
                                    } catch {}
                                }
                            }
                        } catch {}

                        // Refrescar iconos del sistema inmediatamente
                        try { SHChangeNotify(0x08000000, 0x1000, IntPtr.Zero, IntPtr.Zero); } catch {}

                        // Abrir Explorador de Windows seleccionando el archivo
                        if (!string.IsNullOrEmpty(savedPath) && System.IO.File.Exists(savedPath)) {
                            try { System.Diagnostics.Process.Start("explorer.exe", "/select,\"" + savedPath + "\""); } catch {}
                        }

                        _fileChunks.Remove(name);
                        SetStatus("📁 Guardado en Descargas: " + nameOnly + " (" + (data.Length / 1024) + " KB)", Color.FromArgb(0, 220, 100));
                        Task.Delay(5000).ContinueWith(_ => SetStatus("🔵 Transmitiendo – controlador conectado", Color.FromArgb(0, 180, 255)));
                    }
                }
            } catch {}
        }

        string GetStr(string json, string key)
        {
            string tok = "\"" + key + "\":\"";
            int ki = json.IndexOf(tok);
            if (ki < 0) return "";
            int vs = ki + tok.Length;
            int ve = json.IndexOf('"', vs);
            return ve < 0 ? "" : json.Substring(vs, ve - vs);
        }

        // ══════════════════════════════════════════════════════════════════════
        //  Captura de pantalla
        // ══════════════════════════════════════════════════════════════════════
        byte[] CaptureScreen()
        {
            try {
                var b = Screen.PrimaryScreen.Bounds;
                using (var src = new Bitmap(b.Width, b.Height, PixelFormat.Format32bppRgb))
                using (var gS  = Graphics.FromImage(src))
                {
                    gS.CopyFromScreen(b.Location, Point.Empty, b.Size, CopyPixelOperation.SourceCopy);
                    try {
                        CURSORINFO pci; pci.cbSize = Marshal.SizeOf(typeof(CURSORINFO));
                        if (GetCursorInfo(out pci) && pci.flags == CURSOR_SHOWING) {
                            IntPtr hdc = gS.GetHdc();
                            DrawIconEx(hdc, pci.ptScreenPos.x - b.X, pci.ptScreenPos.y - b.Y, pci.hCursor, 0, 0, 0, IntPtr.Zero, DI_NORMAL);
                            gS.ReleaseHdc(hdc);
                        }
                    } catch {}

                    using (var sc = new Bitmap(_screenW, _screenH, PixelFormat.Format32bppRgb))
                    using (var gR = Graphics.FromImage(sc))
                    {
                        gR.InterpolationMode  = InterpolationMode.Low;
                        gR.CompositingQuality = CompositingQuality.HighSpeed;
                        gR.SmoothingMode      = SmoothingMode.None;
                        gR.DrawImage(src, 0, 0, _screenW, _screenH);

                        using (var ms = new MemoryStream())
                        {
                            var enc = GetJpegCodec();
                            var ep  = new EncoderParameters(1);
                            ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)_jpegQ);
                            sc.Save(ms, enc, ep);
                            return ms.ToArray();
                        }
                    }
                }
            } catch { return new byte[0]; }
        }

        // ── Helpers ───────────────────────────────────────────────────────────
        string BuildBaseUrl()
        {
            if (_host == "localhost" || _host == "127.0.0.1" || _host.StartsWith("192.168."))
                return "http://" + _host + ":8080";
            return _host.StartsWith("http") ? _host : "https://" + _host;
        }

        HttpWebRequest MakeReq(string url)
        {
            var r = (HttpWebRequest)WebRequest.Create(url);
            r.ServicePoint.ConnectionLimit = 16;
            r.KeepAlive = true;
            return r;
        }

        ImageCodecInfo GetJpegCodec()
        {
            foreach (var c in ImageCodecInfo.GetImageEncoders())
                if (c.FormatID == ImageFormat.Jpeg.Guid) return c;
            return null;
        }

        void SetStatus(string text, Color color)
        {
            if (InvokeRequired) { Invoke((Action)(() => SetStatus(text, color))); return; }
            lblStatus.Text = text; lblStatus.ForeColor = color;
        }

        void SetFps(string text)
        {
            if (InvokeRequired) { Invoke((Action)(() => SetFps(text))); return; }
            lblFps.Text = text;
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            _cts.Cancel();
            if (_ws != null) { try { _ws.Dispose(); } catch {} }
            base.OnFormClosing(e);
        }
    }
}



