using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace ApexRemote
{
    static class Program
    {
        [STAThread]
        static void Main(string[] args)
        {
            try {
                ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072 | (SecurityProtocolType)768 | SecurityProtocolType.Tls;
                ServicePointManager.ServerCertificateValidationCallback = (s, c, ch, e) => true;
                // Aumentar conexiones simultaneas al mismo servidor
                ServicePointManager.DefaultConnectionLimit = 16;
            } catch {}

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            string serverHost = args.Length > 0 ? args[0] : "apex-remote.onrender.com";
            string id         = args.Length > 1 ? args[1] : new Random().Next(100000, 999999).ToString();

            Application.Run(new AgentForm(serverHost, id));
        }
    }

    public class AgentForm : Form
    {
        // ── Win32 APIs ────────────────────────────────────────────────────────
        [DllImport("user32.dll")] static extern void mouse_event(int f, int x, int y, int d, int e);
        [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte sc, uint fl, int ei);
        [DllImport("user32.dll")] static extern bool DrawIconEx(IntPtr hdc, int x, int y, IntPtr hIcon, int cx, int cy, uint step, IntPtr br, uint di);
        [DllImport("user32.dll")] static extern bool GetCursorInfo(out CURSORINFO pci);

        [StructLayout(LayoutKind.Sequential)] struct PT         { public int x, y; }
        [StructLayout(LayoutKind.Sequential)] struct CURSORINFO { public int cbSize, flags; public IntPtr hCursor; public PT ptScreenPos; }

        const int  MOUSEEVENTF_LEFTDOWN   = 0x0002;
        const int  MOUSEEVENTF_LEFTUP     = 0x0004;
        const int  MOUSEEVENTF_RIGHTDOWN  = 0x0008;
        const int  MOUSEEVENTF_RIGHTUP    = 0x0010;
        const int  MOUSEEVENTF_MIDDLEDOWN = 0x0020;
        const int  MOUSEEVENTF_MIDDLEUP   = 0x0040;
        const int  MOUSEEVENTF_WHEEL      = 0x0800;
        const uint CURSOR_SHOWING         = 0x00000001;
        const uint DI_NORMAL              = 0x0003;
        const uint KEYEVENTF_KEYUP        = 2;

        // ── Estado ─────────────────────────────────────────────────────────────
        readonly string _serverHost;
        readonly string _agentId;
        readonly CancellationTokenSource _cts = new CancellationTokenSource();
        volatile bool _hasViewers = false;

        // ── UI ─────────────────────────────────────────────────────────────────
        Label  lblStatus;
        Label  lblFps;

        public AgentForm(string host, string id)
        {
            _serverHost = host;
            _agentId    = id;
            BuildUI();
            // Lanzar los dos loops de forma independiente
            StartInputLoop();   // Loop rápido: solo inputs (30 Hz)
            StartFrameLoop();   // Loop de frames (hasta 25 FPS)
        }

        void BuildUI()
        {
            Text        = "ApexRemote";
            Size        = new Size(440, 210);
            MinimumSize = Size;
            MaximumSize = Size;
            StartPosition = FormStartPosition.CenterScreen;
            BackColor   = Color.FromArgb(10, 13, 20);

            var panel = new Panel { Location = new Point(14, 10), Size = new Size(408, 158), BackColor = Color.FromArgb(17, 22, 32) };

            var lblTitle = new Label {
                Text = "⚡ ApexRemote",
                Font = new Font("Segoe UI", 15, FontStyle.Bold),
                ForeColor = Color.FromArgb(0, 229, 255),
                Location = new Point(14, 10), AutoSize = true
            };

            var lblSub = new Label {
                Text = "Comparte este ID con quien te va a controlar:",
                Font = new Font("Segoe UI", 9),
                ForeColor = Color.FromArgb(90, 106, 128),
                Location = new Point(16, 40), AutoSize = true
            };

            var lblId = new Label {
                Text = _agentId,
                Font = new Font("Consolas", 26, FontStyle.Bold),
                ForeColor = Color.White,
                Location = new Point(14, 58), AutoSize = true
            };

            var btnCopy = new Button {
                Text = "Copiar ID",
                Font = new Font("Segoe UI", 9, FontStyle.Bold),
                ForeColor = Color.Black,
                BackColor = Color.FromArgb(0, 229, 255),
                FlatStyle = FlatStyle.Flat,
                Location = new Point(270, 63), Size = new Size(120, 36),
                Cursor = Cursors.Hand
            };
            btnCopy.FlatAppearance.BorderSize = 0;
            btnCopy.Click += (s, e) => {
                Clipboard.SetText(_agentId);
                btnCopy.Text = "✓ Copiado";
                Task.Delay(1500).ContinueWith(_ => Invoke((Action)(() => btnCopy.Text = "Copiar ID")));
            };

            lblStatus = new Label {
                Text = "🟡 Conectando al servidor...",
                Font = new Font("Segoe UI", 9),
                ForeColor = Color.FromArgb(200, 160, 0),
                Location = new Point(16, 112), AutoSize = true
            };

            lblFps = new Label {
                Text = "",
                Font = new Font("Consolas", 8),
                ForeColor = Color.FromArgb(60, 80, 100),
                Location = new Point(16, 132), AutoSize = true
            };

            panel.Controls.AddRange(new Control[] { lblTitle, lblSub, lblId, btnCopy, lblStatus, lblFps });
            Controls.Add(panel);
        }

        // ══════════════════════════════════════════════════════════════════════
        //  LOOP 1 – Inputs a ~30 Hz (completamente independiente de los frames)
        // ══════════════════════════════════════════════════════════════════════
        async void StartInputLoop()
        {
            string baseUrl  = BuildBaseUrl();
            string inputUrl = baseUrl + "/api/agent/inputs?id=" + _agentId;

            while (!_cts.IsCancellationRequested)
            {
                if (_hasViewers)
                {
                    try {
                        var req = MakeRequest(inputUrl);
                        req.Method  = "GET";
                        req.Timeout = 2000;

                        using (var resp   = (HttpWebResponse)req.GetResponse())
                        using (var reader = new StreamReader(resp.GetResponseStream()))
                        {
                            string body = reader.ReadToEnd();
                            if (body.Contains("\"inputs\":[{"))   // hay eventos reales
                                ProcessInputJson(body);
                        }
                    } catch { /* ignorar, red inestable */ }

                    await Task.Delay(33);   // ~30 Hz
                }
                else
                {
                    await Task.Delay(200);  // sin viewers, checar despacio
                }
            }
        }

        // ══════════════════════════════════════════════════════════════════════
        //  LOOP 2 – Frames JPEG (hasta 25 FPS cuando hay viewers)
        // ══════════════════════════════════════════════════════════════════════
        async void StartFrameLoop()
        {
            string baseUrl  = BuildBaseUrl();
            string frameUrl = baseUrl + "/api/agent/frame?id=" + _agentId;
            int    frames   = 0;
            long   fpsTime  = DateTime.UtcNow.Ticks;

            // Registrar sesión
            try {
                var regUrl = baseUrl + "/api/agent/register";
                var reg    = MakeRequest(regUrl);
                reg.Method      = "POST";
                reg.ContentType = "application/json";
                byte[] regBody  = Encoding.UTF8.GetBytes("{\"id\":\"" + _agentId + "\",\"hostname\":\"" + Environment.MachineName + "\"}");
                reg.ContentLength = regBody.Length;
                using (var s = reg.GetRequestStream()) s.Write(regBody, 0, regBody.Length);
                using (reg.GetResponse()) {}
                SetStatus("🟢 Conectado – esperando controlador", Color.FromArgb(0, 220, 100));
            } catch {
                SetStatus("🟠 Sin conexión al servidor", Color.Orange);
            }

            while (!_cts.IsCancellationRequested)
            {
                try {
                    byte[] jpeg = _hasViewers ? CaptureScreen() : new byte[0];

                    var req = MakeRequest(frameUrl);
                    req.Method        = "POST";
                    req.ContentType   = "image/jpeg";
                    req.ContentLength = jpeg.Length;
                    req.Timeout       = 3000;

                    if (jpeg.Length > 0)
                        using (var s = req.GetRequestStream()) s.Write(jpeg, 0, jpeg.Length);

                    using (var resp   = (HttpWebResponse)req.GetResponse())
                    using (var reader = new StreamReader(resp.GetResponseStream()))
                    {
                        string body    = reader.ReadToEnd();
                        bool viewers   = body.Contains("\"hasViewers\":true");

                        if (viewers && !_hasViewers)
                            SetStatus("🔵 Transmitiendo – controlador conectado", Color.FromArgb(0, 180, 255));
                        else if (!viewers && _hasViewers)
                            SetStatus("🟢 Conectado – esperando controlador", Color.FromArgb(0, 220, 100));

                        _hasViewers = viewers;
                    }

                    // Contador de FPS
                    frames++;
                    long now  = DateTime.UtcNow.Ticks;
                    long diff = now - fpsTime;
                    if (diff >= 10000000) // 1 segundo
                    {
                        double fps = frames * 10000000.0 / diff;
                        SetFps(string.Format("{0:0.0} FPS  |  {1}x{2}", fps, _screenW, _screenH));
                        frames  = 0;
                        fpsTime = now;
                    }
                }
                catch { /* red inestable */ }

                await Task.Delay(_hasViewers ? 40 : 1000); // 25 FPS ó 1 req/seg en idle
            }
        }

        // ══════════════════════════════════════════════════════════════════════
        //  Parseo de inputs JSON → inyección Win32
        // ══════════════════════════════════════════════════════════════════════
        void ProcessInputJson(string json)
        {
            try {
                int arrS = json.IndexOf("[{");
                int arrE = json.LastIndexOf("}]");
                if (arrS < 0 || arrE < 0) return;

                // Extraer todos los eventos del array
                string arr = json.Substring(arrS + 1, arrE - arrS);  // sin [ y ]
                int depth = 0, start = 0;
                for (int i = 0; i <= arr.Length; i++)
                {
                    char c = i < arr.Length ? arr[i] : ',';
                    if      (c == '{') depth++;
                    else if (c == '}')
                    {
                        depth--;
                        if (depth == 0)
                        {
                            string ev = arr.Substring(start, i - start + 1);
                            ExecEvent(ev);
                            start = i + 2;
                        }
                    }
                }
            } catch {}
        }

        void ExecEvent(string ev)
        {
            try {
                if (ev.Contains("MouseMove"))
                {
                    double rx = GetNum(ev, "rx");
                    double ry = GetNum(ev, "ry");
                    var    b  = Screen.PrimaryScreen.Bounds;
                    int    x  = b.X + (int)(rx * b.Width);
                    int    y  = b.Y + (int)(ry * b.Height);
                    if (Math.Abs(Cursor.Position.X - x) > 1 || Math.Abs(Cursor.Position.Y - y) > 1)
                        Cursor.Position = new Point(x, y);
                }
                else if (ev.Contains("MouseDown"))
                {
                    if (ev.Contains("Left"))   mouse_event(MOUSEEVENTF_LEFTDOWN,   0, 0, 0, 0);
                    if (ev.Contains("Right"))  mouse_event(MOUSEEVENTF_RIGHTDOWN,  0, 0, 0, 0);
                    if (ev.Contains("Middle")) mouse_event(MOUSEEVENTF_MIDDLEDOWN, 0, 0, 0, 0);
                }
                else if (ev.Contains("MouseUp"))
                {
                    if (ev.Contains("Left"))   mouse_event(MOUSEEVENTF_LEFTUP,   0, 0, 0, 0);
                    if (ev.Contains("Right"))  mouse_event(MOUSEEVENTF_RIGHTUP,  0, 0, 0, 0);
                    if (ev.Contains("Middle")) mouse_event(MOUSEEVENTF_MIDDLEUP, 0, 0, 0, 0);
                }
                else if (ev.Contains("MouseScroll"))
                {
                    int dy = (int)GetNum(ev, "delta_y");
                    mouse_event(MOUSEEVENTF_WHEEL, 0, 0, -dy * 3, 0);
                }
                else if (ev.Contains("KeyDown"))
                {
                    byte vk = (byte)GetNum(ev, "key_code");
                    keybd_event(vk, 0, 0, 0);
                }
                else if (ev.Contains("KeyUp"))
                {
                    byte vk = (byte)GetNum(ev, "key_code");
                    keybd_event(vk, 0, KEYEVENTF_KEYUP, 0);
                }
            } catch {}
        }

        // Extrae un número double de un fragmento JSON por clave
        double GetNum(string json, string key)
        {
            string token = "\"" + key + "\":";
            int ki = json.IndexOf(token);
            if (ki < 0) return 0;
            int vs = ki + token.Length;
            int ve = vs;
            while (ve < json.Length && (char.IsDigit(json[ve]) || json[ve] == '.' || json[ve] == '-')) ve++;
            if (ve == vs) return 0;
            return double.Parse(json.Substring(vs, ve - vs), System.Globalization.CultureInfo.InvariantCulture);
        }

        // ══════════════════════════════════════════════════════════════════════
        //  Captura de pantalla optimizada
        // ══════════════════════════════════════════════════════════════════════
        int _screenW = 1280, _screenH = 720;

        byte[] CaptureScreen()
        {
            try {
                var bounds = Screen.PrimaryScreen.Bounds;
                int tw = _screenW, th = _screenH;

                using (var src = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format32bppRgb))
                using (var gS  = Graphics.FromImage(src))
                {
                    gS.CopyFromScreen(bounds.Location, Point.Empty, bounds.Size, CopyPixelOperation.SourceCopy);

                    // Dibujar cursor real
                    try {
                        CURSORINFO pci; pci.cbSize = Marshal.SizeOf(typeof(CURSORINFO));
                        if (GetCursorInfo(out pci) && pci.flags == CURSOR_SHOWING)
                        {
                            IntPtr hdc = gS.GetHdc();
                            DrawIconEx(hdc, pci.ptScreenPos.x - bounds.X, pci.ptScreenPos.y - bounds.Y, pci.hCursor, 0, 0, 0, IntPtr.Zero, DI_NORMAL);
                            gS.ReleaseHdc(hdc);
                        }
                    } catch {}

                    using (var scaled = new Bitmap(tw, th, PixelFormat.Format32bppRgb))
                    using (var gR     = Graphics.FromImage(scaled))
                    {
                        gR.InterpolationMode  = InterpolationMode.Low;
                        gR.CompositingQuality = CompositingQuality.HighSpeed;
                        gR.SmoothingMode      = SmoothingMode.None;
                        gR.DrawImage(src, 0, 0, tw, th);

                        using (var ms = new MemoryStream())
                        {
                            var codec = GetJpegCodec();
                            var ep    = new EncoderParameters(1);
                            ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 45L);
                            scaled.Save(ms, codec, ep);
                            return ms.ToArray();
                        }
                    }
                }
            } catch { return new byte[0]; }
        }

        // ── Helpers ───────────────────────────────────────────────────────────
        string BuildBaseUrl()
        {
            if (_serverHost == "localhost" || _serverHost == "127.0.0.1" || _serverHost.StartsWith("192.168."))
                return "http://" + _serverHost + ":8080";
            if (_serverHost.StartsWith("http"))
                return _serverHost;
            return "https://" + _serverHost;
        }

        HttpWebRequest MakeRequest(string url)
        {
            var req = (HttpWebRequest)WebRequest.Create(url);
            req.ServicePoint.ConnectionLimit = 16;
            req.KeepAlive = true;
            return req;
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
            lblStatus.Text      = text;
            lblStatus.ForeColor = color;
        }

        void SetFps(string text)
        {
            if (InvokeRequired) { Invoke((Action)(() => SetFps(text))); return; }
            lblFps.Text = text;
        }

        protected override void OnFormClosing(FormClosingEventArgs e) { _cts.Cancel(); base.OnFormClosing(e); }
    }
}
