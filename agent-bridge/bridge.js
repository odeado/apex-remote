/**
 * ApexRemote - Servidor All-in-One
 * HTTP  → http://localhost:3000    (sirve la UI del cliente)
 * WS    → ws://localhost:8081      (recibe input mouse/teclado)
 * WS    → ws://localhost:8082      (envía frames JPEG al cliente)
 * WS    → ws://localhost:8080/ws   (señalización con servidor Rust)
 */

const http = require('http');
const WebSocket = require('ws');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// ─── Configuración ────────────────────────────────────────────────────────────
const CLIENT_DIR    = path.resolve(__dirname, '..', 'client');
const SIGNAL_SERVER = 'ws://localhost:8080/ws';
const TARGET_FPS    = 20;
const JPEG_QUALITY  = 75;
const FRAME_INTERVAL_MS = Math.floor(1000 / TARGET_FPS);

const AGENT_ID = '849-' + Math.floor(100 + Math.random() * 900) + '-' + Math.floor(100 + Math.random() * 900);

console.log('╔══════════════════════════════════════════════╗');
console.log('║  ⚡  ApexRemote All-in-One Server v1.0       ║');
console.log('╠══════════════════════════════════════════════╣');
console.log(`║  UI Cliente  →  http://localhost:3000         ║`);
console.log(`║  Agent ID    →  ${AGENT_ID}              ║`);
console.log(`║  Stream FPS  →  ${TARGET_FPS} FPS @ JPEG Q${JPEG_QUALITY}            ║`);
console.log('╚══════════════════════════════════════════════╝\n');

// ─── MIME Types ───────────────────────────────────────────────────────────────
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css':  'text/css',
    '.js':   'application/javascript',
    '.ico':  'image/x-icon',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
};

// ─── HTTP Server (sirve la UI del cliente) ────────────────────────────────────
const httpServer = http.createServer((req, res) => {
    let filePath = path.join(CLIENT_DIR, req.url === '/' ? 'index.html' : req.url);
    const ext = path.extname(filePath);
    const mime = MIME[ext] || 'text/plain';

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end(`404 - ${req.url}`);
            return;
        }
        res.writeHead(200, { 'Content-Type': mime });
        res.end(data);
    });
});

httpServer.listen(3000, () => {
    console.log('✅ UI Cliente disponible en:  http://localhost:3000');
    console.log('   Abre esa URL en tu navegador para ver ApexRemote\n');
});

// ─── WebSocket Frame Server (:8082) ───────────────────────────────────────────
// El cliente se conecta aquí y recibe frames JPEG como binario
const frameWss = new WebSocket.Server({ port: 8082 });
let frameClients = new Set();
let captureInterval = null;
let frameCount = 0;
let streamStart = Date.now();

frameWss.on('connection', (socket) => {
    frameClients.add(socket);
    console.log(`📺 Cliente de visualización conectado (total: ${frameClients.size})`);

    if (!captureInterval) {
        console.log('🎬 Iniciando captura de pantalla...');
        frameCount = 0;
        streamStart = Date.now();
        captureInterval = setInterval(captureAndBroadcast, FRAME_INTERVAL_MS);

        // Log de performance cada 10s
        setInterval(() => {
            const secs = (Date.now() - streamStart) / 1000;
            if (secs > 0 && frameClients.size > 0) {
                console.log(`📊 Stream: ${(frameCount/secs).toFixed(1)} FPS | Frames: ${frameCount} | Clientes: ${frameClients.size}`);
            }
        }, 10000);
    }

    socket.on('close', () => {
        frameClients.delete(socket);
        console.log(`📺 Cliente desconectado (restantes: ${frameClients.size})`);
        if (frameClients.size === 0 && captureInterval) {
            clearInterval(captureInterval);
            captureInterval = null;
            console.log('⏸  Captura pausada (sin clientes)');
        }
    });

    socket.on('error', () => frameClients.delete(socket));
});

console.log('🔌 Frame WebSocket escuchando en  ws://localhost:8082');

// ─── Captura de pantalla con .NET ─────────────────────────────────────────────
function captureAndBroadcast() {
    if (frameClients.size === 0) return;

    const frame = captureScreenshot();
    if (!frame) return;

    frameClients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(frame, { binary: true });
            frameCount++;
        }
    });
}

function captureScreenshot() {
    const tmpFile = path.join(process.env.TEMP || 'C:\\Temp', `apex_${Date.now()}.jpg`);

    // Script PowerShell inline — captura usando .NET (funciona sin permisos admin)
    const script = [
        'Add-Type -AssemblyName System.Windows.Forms,System.Drawing',
        '$s=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
        '$b=New-Object Drawing.Bitmap($s.Width,$s.Height)',
        '$g=[Drawing.Graphics]::FromImage($b)',
        '$g.CopyFromScreen($s.Location,[Drawing.Point]::Empty,$s.Size)',
        '$g.Dispose()',
        '$e=([Drawing.Imaging.ImageCodecInfo]::GetImageEncoders()|?{$_.MimeType -eq "image/jpeg"})',
        '$p=New-Object Drawing.Imaging.EncoderParameters(1)',
        `$p.Param[0]=New-Object Drawing.Imaging.EncoderParameter([Drawing.Imaging.Encoder]::Quality,${JPEG_QUALITY}L)`,
        `$b.Save('${tmpFile.replace(/\\/g, '\\\\')}', $e, $p)`,
        '$b.Dispose()',
    ].join(';');

    try {
        execSync(`powershell -NoP -NonI -Command "${script}"`, { timeout: 80, stdio: 'pipe' });
        if (fs.existsSync(tmpFile)) {
            const data = fs.readFileSync(tmpFile);
            fs.unlinkSync(tmpFile);
            return data;
        }
    } catch (_) {}
    return null;
}

// ─── WebSocket Input Server (:8081) ───────────────────────────────────────────
// El cliente envía eventos de mouse y teclado aquí
const inputWss = new WebSocket.Server({ port: 8081 });

inputWss.on('connection', (socket) => {
    console.log('🖱️  Canal de input conectado');
    socket.on('message', (data) => {
        try {
            const event = JSON.parse(data.toString());
            // TODO Fase 4: Inyectar vía SendInput del agente Rust
            // Por ahora solo loguea eventos de teclado
            if (event.KeyDown) console.log(`⌨️  KeyDown: ${event.KeyDown.key_code}`);
        } catch (_) {}
    });
    socket.on('close', () => console.log('🖱️  Canal de input desconectado'));
});

console.log('🎮 Input WebSocket escuchando en  ws://localhost:8081');

// ─── Conexión al Servidor de Señalización Rust (:8080) ────────────────────────
let signalWs = null;

function connectSignaling() {
    signalWs = new WebSocket(SIGNAL_SERVER);

    signalWs.on('open', () => {
        console.log('\n✅ Conectado al servidor de señalización Rust (:8080)');
        signalWs.send(JSON.stringify({ RegisterAgent: { peer_id: AGENT_ID } }));
    });

    signalWs.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());
            const type = Object.keys(msg)[0];
            if (type === 'AgentRegistered') {
                console.log(`✅ Agente registrado → ID: ${msg.AgentRegistered.peer_id}\n`);
            }
        } catch (_) {}
    });

    signalWs.on('close', () => {
        console.log('⚠️  Señalización desconectada. Reintentando en 5s...');
        setTimeout(connectSignaling, 5000);
    });

    signalWs.on('error', () => {
        console.log('⚠️  Servidor de señalización no disponible (¿ejecutaste remote-server?)');
    });
}

connectSignaling();
