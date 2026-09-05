const WebSocket = require('ws');
const { execFileSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');

const RELAY = 'wss://apex-remote-production.up.railway.app';
const ID    = String(100000 + Math.floor(Math.random() * 900000));
const PIN   = String(1000   + Math.floor(Math.random() * 9000));
const TMP   = path.join(os.tmpdir(), 'apx.jpg');
const PS1   = path.join(os.tmpdir(), 'apx_cap.ps1');

// Script PowerShell para capturar pantalla Y posición del cursor en una sola llamada
// Escribe el JPEG en TMP y devuelve "rx,ry" por stdout
fs.writeFileSync(PS1, [
  'Add-Type -AssemblyName System.Windows.Forms,System.Drawing',
  '$scr=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
  '$cur=[System.Windows.Forms.Cursor]::Position',
  '$rx=[math]::Round($cur.X/$scr.Width,4)',
  '$ry=[math]::Round($cur.Y/$scr.Height,4)',
  'Write-Output "$rx,$ry"',
  '$bmp=New-Object System.Drawing.Bitmap($scr.Width,$scr.Height)',
  '$g=[System.Drawing.Graphics]::FromImage($bmp)',
  '$g.CopyFromScreen($scr.Location,[System.Drawing.Point]::Empty,$scr.Size)',
  '$c=[System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders()|?{$_.MimeType -eq "image/jpeg"}',
  '$ep=New-Object System.Drawing.Imaging.EncoderParameters(1)',
  '$ep.Param[0]=New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality,[long]35)',
  '$bmp.Save("' + TMP.replace(/\\/g, '\\\\') + '",$c,$ep)',
  '$g.Dispose();$bmp.Dispose()'
].join('\n'));

console.log('=== ApexRemote Agent ===');
console.log('ID:  ' + ID);
console.log('PIN: ' + PIN);
console.log('Viewer: https://apex-remote-production.up.railway.app');

let hasViewers = false;
let ws = null;

// Devuelve { frame: Buffer|null, rx: number, ry: number }
function captureWithCursor() {
  try {
    const out = execFileSync('powershell', [
      '-NonInteractive', '-NoProfile', '-File', PS1
    ], { timeout: 5000 }).toString().trim();

    // Primera línea = "rx,ry"
    const firstLine = out.split(/\r?\n/)[0];
    const parts = firstLine.split(',');
    const rx = parseFloat(parts[0]) || 0.5;
    const ry = parseFloat(parts[1]) || 0.5;

    let frame = null;
    try { frame = fs.readFileSync(TMP); } catch (_) {}

    return { frame, rx, ry };
  } catch (e) {
    return { frame: null, rx: 0.5, ry: 0.5 };
  }
}

function connect() {
  console.log('Conectando al relay...');
  ws = new WebSocket(RELAY);

  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'register', id: ID, pin: PIN }));
  });

  ws.on('message', data => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    if (msg.type === 'registered') {
      console.log('Registrado OK — esperando viewer...');

      // Loop principal: captura + cursor cada 150ms
      setInterval(() => {
        if (!hasViewers || !ws || ws.readyState !== 1) return;

        const { frame, rx, ry } = captureWithCursor();

        // Enviar posición del cursor ANTES del frame
        ws.send(JSON.stringify({ type: 'cursor_pos', rx, ry }));

        // Enviar frame JPEG
        if (frame) ws.send(frame);
      }, 150);
    }

    if (msg.type === 'viewer_connected')    { hasViewers = true;  console.log('Viewer conectado!'); }
    if (msg.type === 'viewer_disconnected') { hasViewers = false; console.log('Viewer desconectado'); }

    if (msg.type === 'input' && msg.event) {
      const ev = msg.event;
      if (ev.MouseMove) moveMouse(ev.MouseMove.rx, ev.MouseMove.ry);
      if (ev.MouseDown) mouseClick(ev.MouseDown.button, true);
      if (ev.MouseUp)   mouseClick(ev.MouseUp.button, false);
      if (ev.MouseScroll) mouseScroll(ev.MouseScroll.delta_y);
      if (ev.KeyDown)   sendKey(ev.KeyDown.key_code, true);
      if (ev.KeyUp)     sendKey(ev.KeyUp.key_code, false);
    }
  });

  ws.on('close', () => {
    hasViewers = false;
    console.log('Desconectado. Reconectando en 5s...');
    setTimeout(connect, 5000);
  });
  ws.on('error', e => console.log('WS Error: ' + e.message));
}

// ── Input handlers ────────────────────────────────────────────────────────────

function ps(cmd) {
  try {
    execFileSync('powershell', ['-NonInteractive', '-NoProfile', '-Command', cmd], { timeout: 500 });
  } catch (_) {}
}

function moveMouse(rx, ry) {
  ps(
    'Add-Type -AssemblyName System.Windows.Forms,System.Drawing;' +
    '$s=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds;' +
    '[System.Windows.Forms.Cursor]::Position=New-Object System.Drawing.Point(' +
      '[int]($s.Width*' + rx + '),[int]($s.Height*' + ry + '))'
  );
}

function mouseClick(button, down) {
  // 0=left, 1=right, 2=middle
  const btnMap = { 0: 'Left', 1: 'Right', 2: 'Middle' };
  const btn = btnMap[button] || 'Left';
  const action = down ? 'mouse_event 0x' + (btn === 'Left' ? '2' : btn === 'Right' ? '8' : '20')
                      : 'mouse_event 0x' + (btn === 'Left' ? '4' : btn === 'Right' ? '10' : '40');
  ps(
    'Add-Type -AssemblyName System.Windows.Forms;' +
    '[System.Windows.Forms.SendKeys]::Flush();' +
    'Add-Type -TypeDefinition \'using System;using System.Runtime.InteropServices;' +
    'public class M{[DllImport("user32.dll")]public static extern void mouse_event(int f,int x,int y,int d,int e);}\';' +
    '[M]::mouse_event(0x' + (down
      ? (button === 0 ? '2' : button === 1 ? '8' : '20')
      : (button === 0 ? '4' : button === 1 ? '10' : '40')
    ) + ',0,0,0,0)'
  );
}

function mouseScroll(deltaY) {
  const amount = Math.round((deltaY || 0) * 120);
  if (!amount) return;
  ps(
    'Add-Type -TypeDefinition \'using System;using System.Runtime.InteropServices;' +
    'public class M{[DllImport("user32.dll")]public static extern void mouse_event(int f,int x,int y,int d,int e);}\';' +
    '[M]::mouse_event(0x800,0,0,' + amount + ',0)'
  );
}

// Minimal VK map for common keys
const VK = {
  'Enter':13,'Escape':27,'Backspace':8,'Tab':9,'Space':32,'Delete':46,
  'ArrowLeft':37,'ArrowUp':38,'ArrowRight':39,'ArrowDown':40,
  'Home':36,'End':35,'PageUp':33,'PageDown':34,
  'ShiftLeft':16,'ShiftRight':16,'ControlLeft':17,'ControlRight':17,
  'AltLeft':18,'AltRight':18,
  'F1':112,'F2':113,'F3':114,'F4':115,'F5':116,'F6':117,
  'F7':118,'F8':119,'F9':120,'F10':121,'F11':122,'F12':123,
};

function sendKey(code, down) {
  let vk = VK[code];
  if (!vk) {
    // Letters: KeyA→65, Digits: Digit0→48
    if (code && code.startsWith('Key') && code.length === 4) vk = code.charCodeAt(3);
    else if (code && code.startsWith('Digit') && code.length === 6) vk = code.charCodeAt(5);
  }
  if (!vk) return;
  const flag = down ? 0 : 2; // KEYEVENTF_KEYUP = 2
  ps(
    'Add-Type -TypeDefinition \'using System;using System.Runtime.InteropServices;' +
    'public class K{[DllImport("user32.dll")]public static extern void keybd_event(byte v,byte s,int f,int e);}\';' +
    '[K]::keybd_event(' + vk + ',0,' + flag + ',0)'
  );
}

connect();

// ── Servidor local para ver ID/PIN en el navegador ────────────────────────────

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><head><title>ApexRemote</title>
<style>*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui,sans-serif;background:#0f172a;color:#fff;
     min-height:100vh;display:flex;align-items:center;justify-content:center}
.c{background:#1e293b;padding:40px;border-radius:16px;text-align:center}
h2{color:#60a5fa;margin-bottom:20px}
.id{font-size:3rem;font-weight:800;letter-spacing:.1em}
.pin{font-size:2rem;color:#34d399;margin:10px 0 20px}
a{color:#60a5fa}</style></head>
<body><div class="c">
  <h2>ApexRemote Agent</h2>
  <div class="id">${ID}</div>
  <div class="pin">PIN: ${PIN}</div>
  <p>Viewer: <a href="https://apex-remote-production.up.railway.app" target="_blank">
     apex-remote-production.up.railway.app</a></p>
</div></body></html>`);
}).listen(9280, '127.0.0.1', () => console.log('UI local: http://127.0.0.1:9280'));