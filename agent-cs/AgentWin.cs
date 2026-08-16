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
            } catch {}

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            string serverHost = args.Length > 0 ? args[0] : "apex-remote.onrender.com";
            string id         = args.Length > 1 ? args[1] : new Random().Next(100000, 999999).ToString();

            Application.Run(new AgentForm(serverHost, id));
        }
    }

    // ─── Agente Principal ──────────────────────────────────────────────────────
    public class AgentForm : Form
    {
        // Win32 Mouse
        [DllImport("user32.dll")] static extern void mouse_event(int f, int x, int y, int d, int e);
        // Win32 Keyboard
        [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte sc, uint fl, int ei);
        // Dibujar cursor en la captura
        [DllImport("user32.dll")] static extern bool DrawIconEx(IntPtr hdc, int x, int y, IntPtr hIcon, int cx, int cy, uint step, IntPtr br, uint di);
        [DllImport("user32.dll")] static extern bool GetCursorInfo(out CURSORINFO pci);

        [StructLayout(LayoutKind.Sequential)] struct PT    { public int x, y; }
        [StructLayout(LayoutKind.Sequential)] struct CURSORINFO { public int cbSize, flags; public IntPtr hCursor; public PT ptScreenPos; }

        const int    MOUSEEVENTF_MOVE        = 0x0001;
        const int    MOUSEEVENTF_LEFTDOWN    = 0x0002;
        const int    MOUSEEVENTF_LEFTUP      = 0x0004;
        const int    MOUSEEVENTF_RIGHTDOWN   = 0x0008;
        const int    MOUSEEVENTF_RIGHTUP     = 0x0010;
        const int    MOUSEEVENTF_MIDDLEDOWN  = 0x0020;
        const int    MOUSEEVENTF_MIDDLEUP    = 0x0040;
        const int    MOUSEEVENTF_WHEEL       = 0x0800;
        const uint   CURSOR_SHOWING          = 0x00000001;
        const uint   DI_NORMAL               = 0x0003;
        const long   KEYEVENTF_KEYUP         = 2;

        // ── Estado ─────────────────────────────────────────────────────────────
        readonly string _serverHost;
        readonly string _agentId;
        readonly CancellationTokenSource _cts = new CancellationTokenSource();

        bool   _hasViewers = false;
        int    _screenW    = 1280; // resolución de captura
        int    _screenH    = 720;

        // ── UI ─────────────────────────────────────────────────────────────────
        Label  lblStatus;
        Label  lblId;
        Button btnCopy;

        public AgentForm(string host, string id)
        {
            _serverHost = host;
            _agentId    = id;
            BuildUI();
            StartLoop();
        }

        void BuildUI()
        {
            Text        = "ApexRemote";
            Size        = new Size(440, 220);
            MinimumSize = Size;
            MaximumSize = Size;
            StartPosition = FormStartPosition.CenterScreen;
            BackColor   = Color.FromArgb(10, 13, 20);

            var panel = new Panel { Location = new Point(16, 12), Size = new Size(400, 168), BackColor = Color.FromArgb(17, 22, 32) };

            var lblTitle = new Label {
                Text      = "⚡ ApexRemote",
                Font      = new Font("Segoe UI", 15, FontStyle.Bold),
                ForeColor = Color.FromArgb(0, 229, 255),
                Location  = new Point(14, 10),
                AutoSize  = true
            };

            var lblSub = new Label {
                Text      = "Da este ID a quien te va a controlar:",
                Font      = new Font("Segoe UI", 9),
                ForeColor = Color.FromArgb(90, 106, 128),
                Location  = new Point(16, 40),
                AutoSize  = true
            };

            lblId = new Label {
                Text      = _agentId,
                Font      = new Font("Consolas", 26, FontStyle.Bold),
                ForeColor = Color.White,
                Location  = new Point(14, 60),
                AutoSize  = true
            };

            btnCopy = new Button {
                Text      = "Copiar",
                Font      = new Font("Segoe UI", 9, FontStyle.Bold),
                ForeColor = Color.Black,
                BackColor = Color.FromArgb(0, 229, 255),
                FlatStyle = FlatStyle.Flat,
                Location  = new Point(270, 65),
                Size      = new Size(110, 36),
                Cursor    = Cursors.Hand
            };
            btnCopy.FlatAppearance.BorderSize = 0;
            btnCopy.Click += (s, e) => {
                Clipboard.SetText(_agentId);
                btnCopy.Text = "✓ Copiado";
                Task.Delay(1500).ContinueWith(_ => Invoke((Action)(() => btnCopy.Text = "Copiar")));
            };

            lblStatus = new Label {
                Text      = "🟡 Conectando...",
                Font      = new Font("Segoe UI", 9),
                ForeColor = Color.FromArgb(200, 160, 0),
                Location  = new Point(16, 126),
                AutoSize  = true
            };

            panel.Controls.AddRange(new Control[] { lblTitle, lblSub, lblId, btnCopy, lblStatus });
            Controls.Add(panel);
        }

        // ──────────────────────────────────────────────────────────────────────
        //  LOOP PRINCIPAL – HTTP POST polling (compatible Win7 + Render.com)
        //  Enviamos frames JPEG comprimidos y recibimos inputs en cada respuesta.
        // ──────────────────────────────────────────────────────────────────────
        async void StartLoop()
        {
            string baseUrl = _serverHost.StartsWith("http")
                ? _serverHost
                : string.Format("https://{0}", _serverHost);

            if (_serverHost == "localhost" || _serverHost == "127.0.0.1" || _serverHost.StartsWith("192.168."))
                baseUrl = string.Format("http://{0}:8080", _serverHost);

            // Registrar sesión
            try {
                var reg  = CreateRequest(baseUrl + "/api/agent/register");
                reg.Method      = "POST";
                reg.ContentType = "application/json";
                byte[] regBody  = Encoding.UTF8.GetBytes(string.Format("{{\"id\":\"{0}\",\"hostname\":\"{1}\"}}", _agentId, Environment.MachineName));
                reg.ContentLength = regBody.Length;
                using (var s = reg.GetRequestStream()) s.Write(regBody, 0, regBody.Length);
                using (reg.GetResponse()) {}
                SetStatus("🟢 Conectado – listo para controlar", Color.FromArgb(0, 220, 100));
            } catch { SetStatus("🟠 No se pudo conectar, reintentando...", Color.Orange); }

            string frameUrl = string.Format("{0}/api/agent/frame?id={1}", baseUrl, _agentId);

            while (!_cts.IsCancellationRequested)
            {
                try
                {
                    // Capturar pantalla solo si hay alguien mirando
                    byte[] jpeg = _hasViewers ? CaptureScreen() : Array.Empty<byte>();

                    var req = CreateRequest(frameUrl);
                    req.Method         = "POST";
                    req.ContentType    = "image/jpeg";
                    req.ContentLength  = jpeg.Length;
                    req.Timeout        = 3000;
                    req.ReadWriteTimeout = 3000;

                    if (jpeg.Length > 0)
                        using (var s = req.GetRequestStream()) s.Write(jpeg, 0, jpeg.Length);

                    using (var resp   = (HttpWebResponse)req.GetResponse())
                    using (var reader = new System.IO.StreamReader(resp.GetResponseStream()))
                    {
                        string body = reader.ReadToEnd();
                        bool hasViewers = body.Contains("\"hasViewers\":true");

                        if (hasViewers && !_hasViewers)
                            SetStatus("🔵 Transmitiendo – Controlador conectado", Color.FromArgb(0, 180, 255));
                        else if (!hasViewers && _hasViewers)
                            SetStatus("🟢 Conectado – listo para controlar", Color.FromArgb(0, 220, 100));

                        _hasViewers = hasViewers;

                        if (_hasViewers)
                            ProcessInputs(body);
                    }
                }
                catch { /* red inestable – reintentar */ }

                // ~30 fps cuando hay viewers, 500ms de polling cuando no hay nadie
                await Task.Delay(_hasViewers ? 33 : 500);
            }
        }

        // ──────────────────────────────────────────────────────────────────────
        //  Captura de pantalla optimizada (escala a 1280×720 ó 1920×1080)
        // ──────────────────────────────────────────────────────────────────────
        byte[] CaptureScreen()
        {
            try {
                var bounds = Screen.PrimaryScreen.Bounds;

                // Resolución de envío: 1280×720 para rapidez, configurable
                int tw = _screenW, th = _screenH;

                using (var src = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format32bppRgb))
                using (var gSrc = Graphics.FromImage(src))
                {
                    gSrc.CopyFromScreen(bounds.Location, Point.Empty, bounds.Size, CopyPixelOperation.SourceCopy);

                    // Dibujar cursor real sobre el frame
                    try {
                        CURSORINFO pci; pci.cbSize = Marshal.SizeOf(typeof(CURSORINFO));
                        if (GetCursorInfo(out pci) && pci.flags == CURSOR_SHOWING)
                        {
                            IntPtr hdc = gSrc.GetHdc();
                            DrawIconEx(hdc, pci.ptScreenPos.x - bounds.X, pci.ptScreenPos.y - bounds.Y,
                                       pci.hCursor, 0, 0, 0, IntPtr.Zero, DI_NORMAL);
                            gSrc.ReleaseHdc(hdc);
                        }
                    } catch {}

                    using (var scaled = new Bitmap(tw, th, PixelFormat.Format32bppRgb))
                    using (var gScaled = Graphics.FromImage(scaled))
                    {
                        gScaled.InterpolationMode = InterpolationMode.Low;
                        gScaled.CompositingQuality = CompositingQuality.HighSpeed;
                        gScaled.SmoothingMode = SmoothingMode.None;
                        gScaled.DrawImage(src, 0, 0, tw, th);

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
            }
            catch { return Array.Empty<byte>(); }
        }

        // ──────────────────────────────────────────────────────────────────────
        //  Procesar eventos de input recibidos del relay
        //  Formato JSON: {"hasViewers":true,"inputs":[{"MouseMove":{"rx":0.5,"ry":0.5}}, ...]}
        // ──────────────────────────────────────────────────────────────────────
        void ProcessInputs(string json)
        {
            try {
                int idx = json.IndexOf("\"inputs\":");
                if (idx < 0) return;

                // Parsear cada evento JSON manualmente (sin dependencias externas)
                int arrStart = json.IndexOf('[', idx);
                int arrEnd   = json.LastIndexOf(']');
                if (arrStart < 0 || arrEnd < 0) return;

                string arr = json.Substring(arrStart + 1, arrEnd - arrStart - 1);

                // Dividir por objetos top-level
                int depth = 0, start = 0;
                for (int i = 0; i <= arr.Length; i++)
                {
                    char c = i < arr.Length ? arr[i] : ',';
                    if (c == '{') depth++;
                    else if (c == '}') { depth--; if (depth == 0) { ProcessEvent(arr.Substring(start, i - start + 1)); start = i + 2; } }
                }
            }
            catch {}
        }

        void ProcessEvent(string ev)
        {
            try
            {
                if (ev.Contains("MouseMove"))
                {
                    double rx = ParseDouble(ev, "rx");
                    double ry = ParseDouble(ev, "ry");
                    var bounds = Screen.PrimaryScreen.Bounds;
                    int x = bounds.X + (int)(rx * bounds.Width);
                    int y = bounds.Y + (int)(ry * bounds.Height);
                    // Mover solo si hay diferencia real
                    if (Math.Abs(Cursor.Position.X - x) > 2 || Math.Abs(Cursor.Position.Y - y) > 2)
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
                    int dy = (int)ParseDouble(ev, "delta_y");
                    mouse_event(MOUSEEVENTF_WHEEL, 0, 0, -dy * 3, 0);
                }
                else if (ev.Contains("KeyDown"))
                {
                    byte vk = (byte)ParseDouble(ev, "key_code");
                    keybd_event(vk, 0, 0, 0);
                }
                else if (ev.Contains("KeyUp"))
                {
                    byte vk = (byte)ParseDouble(ev, "key_code");
                    keybd_event(vk, 0, (uint)KEYEVENTF_KEYUP, 0);
                }
            }
            catch {}
        }

        // Extrae un número double del JSON por clave
        double ParseDouble(string json, string key)
        {
            int ki = json.IndexOf("\"" + key + "\":");
            if (ki < 0) return 0;
            int vs = ki + key.Length + 3;
            int ve = vs;
            while (ve < json.Length && (char.IsDigit(json[ve]) || json[ve] == '.' || json[ve] == '-')) ve++;
            return double.Parse(json.Substring(vs, ve - vs), System.Globalization.CultureInfo.InvariantCulture);
        }

        HttpWebRequest CreateRequest(string url)
        {
            var req = (HttpWebRequest)WebRequest.Create(url);
            req.ServicePoint.ConnectionLimit = 8;
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

        protected override void OnFormClosing(FormClosingEventArgs e) { _cts.Cancel(); base.OnFormClosing(e); }
    }
}
