using System;
using System.Collections.Generic;
using System.Drawing;
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
                ServicePointManager.ServerCertificateValidationCallback = (sender, cert, chain, sslPolicyErrors) => true;
            } catch {}

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            string serverHost = args.Length > 0 ? args[0] : "hydrogen-fda-homework-mat.trycloudflare.com";
            string id = args.Length > 1 ? args[1] : new Random().Next(100000, 999999).ToString();

            Application.Run(new AgentForm(serverHost, id));
        }
    }

    public class AgentForm : Form
    {
        [DllImport("user32.dll")]
        private static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);

        [DllImport("user32.dll")]
        private static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, int dwExtraInfo);

        private const int MOUSEEVENTF_LEFTDOWN = 0x02;
        private const int MOUSEEVENTF_LEFTUP = 0x04;
        private const int MOUSEEVENTF_RIGHTDOWN = 0x08;
        private const int MOUSEEVENTF_RIGHTUP = 0x10;
        private const int MOUSEEVENTF_MIDDLEDOWN = 0x20;
        private const int MOUSEEVENTF_MIDDLEUP = 0x40;
        private const int MOUSEEVENTF_WHEEL = 0x0800;

        private string _serverHost;
        private string _agentId;
        private CancellationTokenSource _cts;
        private bool _hasViewers = false;

        private Label lblTitle;
        private Label lblSub;
        private Label lblId;
        private Label lblStatus;
        private Button btnCopy;
        private Panel pnlCard;

        public AgentForm(string serverHost, string agentId)
        {
            _serverHost = serverHost;
            _agentId = agentId;
            _cts = new CancellationTokenSource();

            InitUI();
            StartNetworkLoop();
        }

        private void InitUI()
        {
            this.Text = "ApexRemote - Agente Remoto";
            this.Size = new Size(450, 240);
            this.StartPosition = FormStartPosition.CenterScreen;
            this.FormBorderStyle = FormBorderStyle.FixedSingle;
            this.MaximizeBox = false;
            this.BackColor = Color.FromArgb(10, 13, 20);

            pnlCard = new Panel
            {
                Location = new Point(18, 15),
                Size = new Size(398, 170),
                BackColor = Color.FromArgb(17, 22, 32),
            };

            lblTitle = new Label
            {
                Text = "⚡ ApexRemote",
                Font = new Font("Segoe UI", 16, FontStyle.Bold),
                ForeColor = Color.FromArgb(0, 229, 255),
                Location = new Point(16, 12),
                AutoSize = true
            };

            lblSub = new Label
            {
                Text = "Dile a quien te va a controlar este ID de 6 dígitos:",
                Font = new Font("Segoe UI", 9, FontStyle.Regular),
                ForeColor = Color.FromArgb(138, 153, 173),
                Location = new Point(18, 44),
                AutoSize = true
            };

            lblId = new Label
            {
                Text = _agentId,
                Font = new Font("Consolas", 28, FontStyle.Bold),
                ForeColor = Color.White,
                Location = new Point(16, 68),
                AutoSize = true
            };

            btnCopy = new Button
            {
                Text = "📋 Copiar ID",
                Font = new Font("Segoe UI", 9, FontStyle.Bold),
                ForeColor = Color.Black,
                BackColor = Color.FromArgb(0, 229, 255),
                FlatStyle = FlatStyle.Flat,
                Location = new Point(276, 72),
                Size = new Size(104, 38),
                Cursor = Cursors.Hand
            };
            btnCopy.FlatAppearance.BorderSize = 0;
            btnCopy.Click += (s, e) =>
            {
                Clipboard.SetText(_agentId);
                btnCopy.Text = "✅ Copiado";
                Task.Delay(1500).ContinueWith(_ => this.Invoke((Action)(() => btnCopy.Text = "📋 Copiar ID")));
            };

            lblStatus = new Label
            {
                Text = "🟡 Conectando a Internet...",
                Font = new Font("Segoe UI", 9, FontStyle.Regular),
                ForeColor = Color.FromArgb(255, 200, 0),
                Location = new Point(18, 128),
                AutoSize = true
            };

            pnlCard.Controls.Add(lblTitle);
            pnlCard.Controls.Add(lblSub);
            pnlCard.Controls.Add(lblId);
            pnlCard.Controls.Add(btnCopy);
            pnlCard.Controls.Add(lblStatus);

            this.Controls.Add(pnlCard);
        }

        private async void StartNetworkLoop()
        {
            string baseUrl = _serverHost.StartsWith("http") 
                ? _serverHost 
                : string.Format("https://{0}", _serverHost);

            if (_serverHost.StartsWith("192.168.") || _serverHost == "localhost" || _serverHost == "127.0.0.1")
            {
                baseUrl = string.Format("http://{0}:8080", _serverHost);
            }

            try {
                string regUrl = baseUrl + "/api/agent/register";
                string json = string.Format("{{\"id\":\"{0}\",\"hostname\":\"{1}\"}}", _agentId, Environment.MachineName);
                byte[] body = Encoding.UTF8.GetBytes(json);

                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(regUrl);
                req.Method = "POST";
                req.ContentType = "application/json";
                req.ContentLength = body.Length;
                using (Stream s = req.GetRequestStream()) s.Write(body, 0, body.Length);
                using (WebResponse resp = req.GetResponse()) {}

                UpdateStatus("🟢 Conectado a Internet (Listo)", Color.FromArgb(0, 230, 118));
            }
            catch {}

            string frameUrl = string.Format("{0}/api/agent/frame?id={1}", baseUrl, _agentId);

            while (!_cts.IsCancellationRequested)
            {
                try {
                    byte[] jpeg = _hasViewers ? CapturePrimaryScreenJpeg(50) : new byte[0]; // Compresión optimizada Q50 ultra-rápida

                    HttpWebRequest req = (HttpWebRequest)WebRequest.Create(frameUrl);
                    req.Method = "POST";
                    req.ContentType = "image/jpeg";
                    req.ContentLength = jpeg.Length;
                    req.Timeout = 1500;

                    if (jpeg.Length > 0)
                    {
                        using (Stream s = req.GetRequestStream()) s.Write(jpeg, 0, jpeg.Length);
                    }

                    using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                    using (StreamReader reader = new StreamReader(resp.GetResponseStream()))
                    {
                        string respText = reader.ReadToEnd();
                        if (respText.Contains("\"hasViewers\":true"))
                        {
                            if (!_hasViewers)
                            {
                                _hasViewers = true;
                                UpdateStatus("🔵 En transmisión activa con controlador", Color.FromArgb(0, 229, 255));
                            }

                            // Procesar eventos de input entrantes
                            ProcessInputEvents(respText);
                        }
                        else
                        {
                            if (_hasViewers)
                            {
                                _hasViewers = false;
                                UpdateStatus("🟢 Conectado a Internet (Listo)", Color.FromArgb(0, 230, 118));
                            }
                        }
                    }
                }
                catch {
                    UpdateStatus("🟢 Conectado a Internet (Listo)", Color.FromArgb(0, 230, 118));
                }

                await Task.Delay(25); // ~40 FPS ultra-rápido
            }
        }

        private void ProcessInputEvents(string jsonText)
        {
            try {
                // Inyección de movimiento de ratón
                if (jsonText.Contains("MouseMove"))
                {
                    int xIdx = jsonText.IndexOf("\"x\":");
                    int yIdx = jsonText.IndexOf("\"y\":");
                    if (xIdx != -1 && yIdx != -1)
                    {
                        int xEnd = jsonText.IndexOf(",", xIdx);
                        if (xEnd == -1) xEnd = jsonText.IndexOf("}", xIdx);
                        int yEnd = jsonText.IndexOf("}", yIdx);
                        if (yEnd == -1) yEnd = jsonText.IndexOf(",", yIdx);

                        string xStr = jsonText.Substring(xIdx + 4, xEnd - (xIdx + 4)).Trim();
                        string yStr = jsonText.Substring(yIdx + 4, yEnd - (yIdx + 4)).Trim(' ', '}');

                        int x = int.Parse(xStr);
                        int y = int.Parse(yStr);

                        Cursor.Position = new Point(x, y);
                    }
                }

                // Inyección de Clics
                if (jsonText.Contains("MouseDown"))
                {
                    if (jsonText.Contains("Left")) mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
                    else if (jsonText.Contains("Right")) mouse_event(MOUSEEVENTF_RIGHTDOWN, 0, 0, 0, 0);
                    else if (jsonText.Contains("Middle")) mouse_event(MOUSEEVENTF_MIDDLEDOWN, 0, 0, 0, 0);
                }

                if (jsonText.Contains("MouseUp"))
                {
                    if (jsonText.Contains("Left")) mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
                    else if (jsonText.Contains("Right")) mouse_event(MOUSEEVENTF_RIGHTUP, 0, 0, 0, 0);
                    else if (jsonText.Contains("Middle")) mouse_event(MOUSEEVENTF_MIDDLEUP, 0, 0, 0, 0);
                }

                // Inyección de Teclado
                if (jsonText.Contains("KeyDown"))
                {
                    int keyIdx = jsonText.IndexOf("\"key_code\":");
                    if (keyIdx != -1)
                    {
                        int keyEnd = jsonText.IndexOf(",", keyIdx);
                        if (keyEnd == -1) keyEnd = jsonText.IndexOf("}", keyIdx);
                        string keyStr = jsonText.Substring(keyIdx + 11, keyEnd - (keyIdx + 11)).Trim();
                        byte vk = byte.Parse(keyStr);
                        keybd_event(vk, 0, 0, 0);
                    }
                }

                if (jsonText.Contains("KeyUp"))
                {
                    int keyIdx = jsonText.IndexOf("\"key_code\":");
                    if (keyIdx != -1)
                    {
                        int keyEnd = jsonText.IndexOf(",", keyIdx);
                        if (keyEnd == -1) keyEnd = jsonText.IndexOf("}", keyIdx);
                        string keyStr = jsonText.Substring(keyIdx + 11, keyEnd - (keyIdx + 11)).Trim();
                        byte vk = byte.Parse(keyStr);
                        keybd_event(vk, 0, 2, 0);
                    }
                }

                // Inyección de Scroll
                if (jsonText.Contains("MouseScroll"))
                {
                    int deltaIdx = jsonText.IndexOf("\"delta_y\":");
                    if (deltaIdx != -1)
                    {
                        int deltaEnd = jsonText.IndexOf("}", deltaIdx);
                        if (deltaEnd == -1) deltaEnd = jsonText.IndexOf(",", deltaIdx);
                        string deltaStr = jsonText.Substring(deltaIdx + 10, deltaEnd - (deltaIdx + 10)).Trim(' ', '}');
                        int deltaY = int.Parse(deltaStr);
                        mouse_event(MOUSEEVENTF_WHEEL, 0, 0, -deltaY, 0);
                    }
                }
            }
            catch {}
        }

        private byte[] CapturePrimaryScreenJpeg(long quality)
        {
            try {
                Rectangle bounds = Screen.PrimaryScreen.Bounds;
                using (Bitmap bmp = new Bitmap(bounds.Width, bounds.Height))
                {
                    using (Graphics g = Graphics.FromImage(bmp))
                    {
                        g.CopyFromScreen(bounds.Location, Point.Empty, bounds.Size);
                    }

                    using (MemoryStream ms = new MemoryStream())
                    {
                        ImageCodecInfo encoder = GetEncoder(ImageFormat.Jpeg);
                        EncoderParameters encoderParams = new EncoderParameters(1);
                        encoderParams.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, quality);

                        bmp.Save(ms, encoder, encoderParams);
                        return ms.ToArray();
                    }
                }
            }
            catch { return null; }
        }

        private ImageCodecInfo GetEncoder(ImageFormat format)
        {
            ImageCodecInfo[] codecs = ImageCodecInfo.GetImageEncoders();
            foreach (ImageCodecInfo codec in codecs)
            {
                if (codec.FormatID == format.Guid) return codec;
            }
            return null;
        }

        private void UpdateStatus(string text, Color color)
        {
            if (this.InvokeRequired)
            {
                this.Invoke((Action)(() => UpdateStatus(text, color)));
                return;
            }
            lblStatus.Text = text;
            lblStatus.ForeColor = color;
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            _cts.Cancel();
            base.OnFormClosing(e);
        }
    }
}
