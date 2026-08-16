/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║              ⚡  ApexRemote - Agente Remoto                  ║
 * ║                                                              ║
 * ║  Este programa corre en el PC que quieres controlar.         ║
 * ║  1. Muestra un ID de 6 dígitos                               ║
 * ║  2. Captura la pantalla y la envía al servidor               ║
 * ║  3. Recibe eventos de mouse/teclado y los inyecta            ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 *  Uso:  node agent.js [IP_DEL_SERVIDOR]
 *  Ej:   node agent.js 192.168.1.100
 */

const { WebSocket } = require('ws');
const { execSync, exec } = require('child_process');
const os   = require('os');
const path = require('path');
const fs   = require('fs');

// ── Configuración ─────────────────────────────────────────────────────────────
const SERVER_IP  = process.argv[2] || 'localhost';
const SERVER_URL = `ws://${SERVER_IP}:8080/ws`;
const AGENT_ID   = process.env.APEX_ID || String(Math.floor(100000 + Math.random() * 900000));

const FPS            = 20;
const JPEG_QUALITY   = 70;
const FRAME_INTERVAL = Math.floor(1000 / FPS);
const TMP_DIR        = os.tmpdir();

// ── Estado ────────────────────────────────────────────────────────────────────
let ws            = null;
let captureTimer  = null;
let viewers       = 0;
let framesSent    = 0;
let connected     = false;

// ── Banner ────────────────────────────────────────────────────────────────────
console.clear();
console.log('╔══════════════════════════════════════════════════════════════╗');
console.log('║              ⚡  ApexRemote - Agente Remoto v1.0            ║');
console.log('╠══════════════════════════════════════════════════════════════╣');
console.log(`║                                                              ║`);
console.log(`║          Tu ID de conexión:   ${AGENT_ID}                    ║`);
console.log(`║                                                              ║`);
console.log(`║  Dile a quien te va a controlar este ID.                     ║`);
console.log(`║  Conéctate al servidor:  ${SERVER_URL.padEnd(36)}║`);
console.log('╚══════════════════════════════════════════════════════════════╝\n');

// ── Conexión al servidor ──────────────────────────────────────────────────────
function connect() {
    console.log(`[Agente] Conectando a ${SERVER_URL}...`);
    ws = new WebSocket(SERVER_URL);

    ws.on('open', () => {
        connected = true;
        console.log('[Agente] ✅ Conectado al servidor de retransmisión');

        // Registrarse con el ID y metadatos del equipo
        ws.send(JSON.stringify({
            type:     'register',
            id:       AGENT_ID,
            hostname: os.hostname(),
            os:       `${os.type()} ${os.release()}`,
            arch:     os.arch(),
        }));
    });

    ws.on('message', (data, isBinary) => {
        if (isBinary) return; // El agente no recibe binario

        let msg;
        try { msg = JSON.parse(data.toString()); }
        catch { return; }

        switch (msg.type) {
            case 'registered':
                console.log(`[Agente] ✅ Registrado con ID: ${msg.id}\n`);
                console.log('        Esperando que alguien se conecte...');
                break;

            case 'viewer_connected':
                viewers = msg.count;
                console.log(`\n[Agente] 👁  Controlador conectado! (${viewers} activo/s)`);
                startCapture();
                break;

            case 'viewer_disconnected':
                viewers = msg.count;
                console.log(`[Agente] 👁  Controlador desconectado (${viewers} restantes)`);
                if (viewers === 0) stopCapture();
                break;

            case 'input':
                handleInput(msg.event);
                break;
        }
    });

    ws.on('close', () => {
        connected = false;
        stopCapture();
        console.log('\n[Agente] ⚠️  Conexión perdida. Reconectando en 5s...');
        setTimeout(connect, 5000);
    });

    ws.on('error', (err) => {
        console.log(`[Agente] ❌ Error: ${err.message}`);
    });
}

// ── Captura de pantalla ───────────────────────────────────────────────────────
function startCapture() {
    if (captureTimer) return;
    console.log(`[Agente] 🎬 Iniciando captura a ${FPS} FPS...`);
    captureTimer = setInterval(captureAndSend, FRAME_INTERVAL);

    // Stats cada 10s
    setInterval(() => {
        if (viewers > 0 && framesSent > 0) {
            console.log(`[Agente] 📊 Frames enviados: ${framesSent} | Viewers: ${viewers}`);
        }
    }, 10000);
}

function stopCapture() {
    if (captureTimer) {
        clearInterval(captureTimer);
        captureTimer = null;
        console.log('[Agente] ⏸  Captura pausada');
    }
}

function captureAndSend() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const frame = captureScreen();
    if (!frame) return;

    ws.send(frame, { binary: true });
    framesSent++;
}

// ── Métodos de captura de pantalla ───────────────────────────────────────────
function captureScreen() {
    const tmp = path.join(TMP_DIR, `apex_${Date.now()}.jpg`);

    // Script PowerShell: captura usando .NET System.Drawing
    // Funciona en sesiones interactivas, RDP, y Windows 10/11
    const script = [
        'Add-Type -AssemblyName System.Windows.Forms,System.Drawing',
        '$bounds=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
        '$bmp=New-Object System.Drawing.Bitmap($bounds.Width,$bounds.Height)',
        '$g=[System.Drawing.Graphics]::FromImage($bmp)',
        '$g.CopyFromScreen($bounds.Location,[System.Drawing.Point]::Empty,$bounds.Size)',
        '$g.Dispose()',
        // Incluir cursor del mouse
        '$cursor=[System.Windows.Forms.Cursor]::Current',
        '$cursorPos=[System.Windows.Forms.Cursor]::Position',
        // Guardar como JPEG con la calidad especificada
        '$encoder=([System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders()|Where-Object{$_.MimeType -eq "image/jpeg"})',
        '$params=New-Object System.Drawing.Imaging.EncoderParameters(1)',
        `$params.Param[0]=New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality,${JPEG_QUALITY}L)`,
        `$bmp.Save('${tmp.replace(/\\/g, '\\\\')}', $encoder, $params)`,
        '$bmp.Dispose()',
    ].join(';');

    try {
        execSync(
            `powershell -NoProfile -NonInteractive -WindowStyle Hidden -Command "${script}"`,
            { timeout: FRAME_INTERVAL - 5, stdio: 'pipe' }
        );
        if (fs.existsSync(tmp)) {
            const data = fs.readFileSync(tmp);
            try { fs.unlinkSync(tmp); } catch {}
            return data;
        }
    } catch {}
    return null;
}

// ── Inyección de input ────────────────────────────────────────────────────────
function handleInput(event) {
    if (!event) return;

    if (event.MouseMove) {
        injectMouseMove(event.MouseMove.x, event.MouseMove.y);
    } else if (event.MouseDown) {
        injectMouseClick(event.MouseDown.button, 'down');
    } else if (event.MouseUp) {
        injectMouseClick(event.MouseUp.button, 'up');
    } else if (event.KeyDown) {
        injectKey(event.KeyDown.key_code, 'down');
    } else if (event.KeyUp) {
        injectKey(event.KeyUp.key_code, 'up');
    } else if (event.MouseScroll) {
        injectScroll(event.MouseScroll.delta_y);
    }
}

function runPS(script) {
    exec(`powershell -NoProfile -NonInteractive -WindowStyle Hidden -Command "${script}"`, { timeout: 200 });
}

function injectMouseMove(x, y) {
    runPS(`Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.Cursor]::Position=New-Object System.Drawing.Point(${x},${y})`);
}

function injectMouseClick(button, action) {
    const btnMap = { Left: 'Left', Right: 'Right', Middle: 'Middle' };
    const btn = btnMap[button] || 'Left';
    const method = action === 'down' ? 'MouseDown' : 'MouseUp';

    runPS([
        'Add-Type -AssemblyName System.Windows.Forms',
        `[System.Windows.Forms.SendKeys]::${method === 'MouseDown' ? '' : ''}`,
        // Usar mouse_event via pinvoke
        'Add-Type -TypeDefinition @"',
        'using System;using System.Runtime.InteropServices;',
        'public class NativeMethods{',
        '[DllImport("user32.dll")]public static extern void mouse_event(int dwFlags,int dx,int dy,int dwData,int dwExtraInfo);}',
        '"@',
        `$f=${btn === 'Left' ? (action === 'down' ? 2 : 4) : btn === 'Right' ? (action === 'down' ? 8 : 16) : (action === 'down' ? 32 : 64)}`,
        '[NativeMethods]::mouse_event($f,0,0,0,0)',
    ].join(';'));
}

function injectKey(keyCode, action) {
    // Usar SendKeys para teclas básicas
    runPS(`Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.SendKeys]::SendWait('')`);
}

function injectScroll(deltaY) {
    const clicks = Math.round(deltaY / 120);
    if (clicks === 0) return;
    runPS([
        'Add-Type -TypeDefinition @"',
        'using System;using System.Runtime.InteropServices;',
        'public class NM{[DllImport("user32.dll")]public static extern void mouse_event(int f,int x,int y,int d,int e);}',
        '"@',
        `[NM]::mouse_event(0x800,0,0,${-clicks * 120},0)`,
    ].join(';'));
}

// ── Iniciar ───────────────────────────────────────────────────────────────────
connect();
