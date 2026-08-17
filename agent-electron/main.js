/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║         ApexRemote — Agente Electron (main process)         ║
 * ║                                                              ║
 * ║  • Captura pantalla via getUserMedia en renderer (rápido)   ║
 * ║  • Inyecta mouse/teclado via robotjs                        ║
 * ║  • Conecta al relay via WebSocket                           ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

'use strict';

const { app, BrowserWindow, desktopCapturer, ipcMain, screen: eScreen } = require('electron');
const WebSocket = require('ws');
const path      = require('path');
const os        = require('os');
const fs        = require('fs');

// ── Cargar robotjs (nativo, compilado para Electron) ──────────────────────────
let robot = null;
try { robot = require('robotjs'); robot.setMouseDelay(0); robot.setKeyboardDelay(0); }
catch (e) { console.warn('[Agent] robotjs no disponible:', e.message); }

// ── Configuración ─────────────────────────────────────────────────────────────
const RELAY_HOST = process.env.APEX_RELAY || 'apex-remote.onrender.com';
const RELAY_URL  = `wss://${RELAY_HOST}/ws`;
const AGENT_ID   = process.env.APEX_ID   || String(Math.floor(100000 + Math.random() * 900000));
const AGENT_PIN  = process.env.APEX_PIN  || String(Math.floor(1000   + Math.random() * 9000));

// ── Estado ────────────────────────────────────────────────────────────────────
let mainWindow   = null;
let ws           = null;
let hasViewers   = false;
let framesSent   = 0;
let lastFpsTime  = Date.now();
let lastFrameKB  = 0;
let cursorTimer  = null;
let screenW      = 1280;
let screenH      = 720;
let jpegQ        = 50;

// ── Ventana principal ─────────────────────────────────────────────────────────
function createWindow() {
    mainWindow = new BrowserWindow({
        width:          420,
        height:         560,
        resizable:      false,
        maximizable:    false,
        frame:          false,
        transparent:    false,
        backgroundColor: '#111118',
        webPreferences: {
            preload:          path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration:  false,
        },
        show: false,
    });

    mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
        mainWindow.webContents.send('init', { id: AGENT_ID, pin: AGENT_PIN, relay: RELAY_HOST });
    });

    // Minimizar en lugar de cerrar (keep running)
    mainWindow.on('close', (e) => {
        if (!app.isQuitting) {
            e.preventDefault();
            mainWindow.minimize();
        }
    });
}

// ── IPC desde renderer ────────────────────────────────────────────────────────
ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-close',    () => { app.isQuitting = true; app.quit(); });
ipcMain.on('set-quality', (_, { w, h, q }) => {
    screenW = w; screenH = h; jpegQ = q;
    // Notificar al renderer para reiniciar captura con nueva resolución
    if (hasViewers) mainWindow?.webContents.send('quality-changed', { w, h, q });
});

// ── WebRTC signaling desde renderer ──────────────────────────────────────────
ipcMain.on('webrtc-answer',    (_, answer)    => wsSend({ type: 'webrtc_answer', answer }));
ipcMain.on('webrtc-ice-agent', (_, candidate) => wsSend({ type: 'webrtc_ice', candidate }));

// ── Captura: renderer solicita fuentes de pantalla ────────────────────────────
ipcMain.handle('get-sources', async () => {
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    return sources.map(s => ({ id: s.id, name: s.name }));
});

// ── Recibir frames JPEG ya codificados desde el renderer ─────────────────────
ipcMain.on('frame', (_, buf) => {
    if (!hasViewers || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(buf);
    framesSent++;
    lastFrameKB = Math.round(buf.length / 1024);

    const now = Date.now();
    if (now - lastFpsTime >= 1000) {
        const fps = Math.round(framesSent * 1000 / (now - lastFpsTime));
        mainWindow?.webContents.send('stats', { fps, kb: lastFrameKB, w: screenW, h: screenH });
        framesSent = 0; lastFpsTime = now;
    }
});

// ── Posición del cursor: enviar al viewer como JSON separado ──────────────────
function startCursorSend() {
    if (cursorTimer) return;
    cursorTimer = setInterval(() => {
        const pt   = eScreen.getCursorScreenPoint();
        const disp = eScreen.getPrimaryDisplay().bounds;
        // Al renderer: coordenadas en píxeles del canvas para dibujar en el frame
        const cx = Math.round(pt.x / disp.width  * screenW);
        const cy = Math.round(pt.y / disp.height * screenH);
        mainWindow?.webContents.send('cursor-update', { cx, cy });
        // Al viewer web (solo si hay alguien conectado): posición relativa 0-1
        if (ws && ws.readyState === WebSocket.OPEN && hasViewers)
            wsSend({ type: 'cursor_pos', rx: pt.x / disp.width, ry: pt.y / disp.height });
    }, 16); // ~60 Hz — cursor fluido
}

function stopCursorSend() {
    if (cursorTimer) { clearInterval(cursorTimer); cursorTimer = null; }
}

// ── Inicio/parada de captura ──────────────────────────────────────────────────
function startCapture() {
    framesSent = 0; lastFpsTime = Date.now();
    mainWindow?.webContents.send('start-capture', { w: screenW, h: screenH, q: jpegQ });
    startCursorSend();
}

function stopCapture() {
    mainWindow?.webContents.send('stop-capture');
    stopCursorSend();
    framesSent = 0;
    mainWindow?.webContents.send('stats', null);
}

// ── Inyección de input ────────────────────────────────────────────────────────
function handleInput(event) {
    if (!robot || !event) return;
    try {
        const disp = eScreen.getPrimaryDisplay().bounds;

        if (event.MouseMoveDelta) {
            // Modo Pointer Lock: delta relativo desde el viewer
            const pt = eScreen.getCursorScreenPoint();
            const nx = Math.max(0, Math.min(disp.width  - 1, pt.x + event.MouseMoveDelta.dx));
            const ny = Math.max(0, Math.min(disp.height - 1, pt.y + event.MouseMoveDelta.dy));
            robot.moveMouse(nx, ny);

        } else if (event.MouseMove) {
            // Fallback modo absoluto (touch desde móvil)
            const rx = event.MouseMove.rx || 0;
            const ry = event.MouseMove.ry || 0;
            robot.moveMouse(Math.round(rx * disp.width), Math.round(ry * disp.height));

        } else if (event.MouseDown) {
            robot.mouseToggle('down', (event.MouseDown.button || 'Left').toLowerCase());

        } else if (event.MouseUp) {
            robot.mouseToggle('up', (event.MouseUp.button || 'Left').toLowerCase());

        } else if (event.MouseScroll) {
            robot.scrollMouse(0, Math.round(event.MouseScroll.delta_y / 120));

        } else if (event.KeyDown) {
            const k = vkToRobot(event.KeyDown.key_code);
            if (k) robot.keyToggle(k, 'down');

        } else if (event.KeyUp) {
            const k = vkToRobot(event.KeyUp.key_code);
            if (k) robot.keyToggle(k, 'up');

        } else if (event.SetQuality) {
            const { w, h, q } = event.SetQuality;
            if (w > 0 && h > 0 && q > 0) {
                screenW = w; screenH = h; jpegQ = q;
                if (hasViewers) mainWindow?.webContents.send('quality-changed', { w, h, q });
            }

        } else if (event.FileChunk) {
            handleFileChunk(event.FileChunk);

        } else if (event.ClipboardSync || event.clipboard_sync) {
            const txt = (event.ClipboardSync || event.clipboard_sync).text;
            if (txt) require('electron').clipboard.writeText(txt);
        }
    } catch (e) { console.warn('[Input]', e.message); }
}

// ── File system handlers ──────────────────────────────────────────────────────
const _fileChunks = {};

function handleFsList(reqPath) {
    try {
        let items = [];
        if (!reqPath || reqPath === 'drives') {
            ['C:', 'D:', 'E:', 'F:', 'G:', 'H:'].forEach(d => {
                try { fs.readdirSync(d + '\\'); items.push({ name: d + '\\', isDir: true, size: 0, date: '' }); } catch {}
            });
        } else {
            const entries = fs.readdirSync(reqPath, { withFileTypes: true });
            items = entries.map(e => {
                try {
                    const full = path.join(reqPath, e.name);
                    const stat = fs.statSync(full);
                    return { name: e.name, isDir: e.isDirectory(), size: stat.size, date: stat.mtime.toLocaleString('es') };
                } catch { return { name: e.name, isDir: e.isDirectory(), size: 0, date: '' }; }
            }).filter(Boolean);
        }
        wsSend({ type: 'fs_list_res', path: reqPath || 'drives', items });
    } catch {
        wsSend({ type: 'fs_list_res', path: reqPath || 'drives', items: [] });
    }
}

function handleFsDelete(p) {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
    handleFsList(path.dirname(p));
}

function handleFsMkdir(p) {
    try { fs.mkdirSync(p, { recursive: true }); } catch {}
    handleFsList(path.dirname(p));
}

function handleFsDownload(filePath) {
    try {
        if (!fs.existsSync(filePath)) return;
        const data   = fs.readFileSync(filePath);
        const b64    = data.toString('base64');
        const name   = path.basename(filePath);
        const CHUNK  = 12000;
        const total  = Math.ceil(b64.length / CHUNK);
        for (let k = 0; k < total; k++) {
            wsSend({ type: 'file_download_chunk', name, idx: k, total, b64: b64.slice(k * CHUNK, (k + 1) * CHUNK) });
        }
    } catch {}
}

function handleFileChunk(chunk) {
    const { name, idx, total, b64, targetDir } = chunk;
    if (!name || !b64) return;
    if (!_fileChunks[name]) _fileChunks[name] = [];
    _fileChunks[name][idx] = b64;
    // Guardar el targetDir en el primer chunk que lo traiga
    if (targetDir && !_fileChunks[name]._targetDir) _fileChunks[name]._targetDir = targetDir;
    if (_fileChunks[name].filter(Boolean).length >= total) {
        try {
            const full = Buffer.from(_fileChunks[name].join(''), 'base64');
            const savedDir = _fileChunks[name]._targetDir;
            delete _fileChunks[name];

            // Usar el directorio remoto activo si existe, si no caer en Downloads/Desktop
            const saveDirs = (savedDir && fs.existsSync(savedDir))
                ? [savedDir]
                : [
                    path.join(os.homedir(), 'Downloads'),
                    path.join(os.homedir(), 'Desktop'),
                    'C:\\Users\\Public\\Downloads',
                  ];

            let saved = '';
            for (const dir of saveDirs) {
                try {
                    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                    fs.writeFileSync(path.join(dir, name), full);
                    if (!saved) saved = path.join(dir, name);
                } catch {}
            }
            if (saved) {
                mainWindow?.webContents.send('file-received', { name, size: full.length, path: saved });
                // Refrescar el explorador remoto en el viewer para que aparezca el archivo
                handleFsList(path.dirname(saved));
            }
        } catch {}
    }
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
function wsSend(obj) {
    if (ws && ws.readyState === WebSocket.OPEN)
        ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
}

function connect() {
    updateStatus('connecting');
    ws = new WebSocket(RELAY_URL);

    ws.on('open', () => {
        wsSend({ type: 'register', id: AGENT_ID, pin: AGENT_PIN, hostname: os.hostname() });
        updateStatus('waiting');
    });

    ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return; }

        switch (msg.type) {
            case 'viewer_connected':
                hasViewers = true;
                startCapture();
                updateStatus('streaming');
                break;

            case 'viewer_disconnected':
                if ((msg.count || 0) === 0) {
                    hasViewers = false;
                    stopCapture();
                    updateStatus('waiting');
                }
                break;

            case 'input':
                handleInput(msg.event);
                break;

            case 'webrtc_offer':
                mainWindow?.webContents.send('webrtc-offer', msg.offer);
                break;

            case 'webrtc_ice':
                mainWindow?.webContents.send('webrtc-ice', msg.candidate);
                break;

            case 'fs_list':     handleFsList(msg.path);    break;
            case 'fs_delete':   handleFsDelete(msg.path);  break;
            case 'fs_mkdir':    handleFsMkdir(msg.path);   break;
            case 'fs_download': handleFsDownload(msg.path); break;
            case 'file_chunk':  handleFileChunk(msg);      break;
        }
    });

    ws.on('close', () => {
        hasViewers = false;
        stopCapture();
        updateStatus('disconnected');
        setTimeout(connect, 4000);
    });

    ws.on('error', () => {});
}

function updateStatus(status) {
    mainWindow?.webContents.send('status', status);
}

// ── Mapeo VK → robotjs ───────────────────────────────────────────────────────
function vkToRobot(vk) {
    const m = {
        8:'backspace', 9:'tab', 13:'enter', 16:'shift', 17:'control', 18:'alt',
        19:'pause', 20:'caps_lock', 27:'escape', 32:'space',
        33:'page_up', 34:'page_down', 35:'end', 36:'home',
        37:'left', 38:'up', 39:'right', 40:'down',
        44:'printscreen', 45:'insert', 46:'delete',
        48:'0', 49:'1', 50:'2', 51:'3', 52:'4',
        53:'5', 54:'6', 55:'7', 56:'8', 57:'9',
        65:'a', 66:'b', 67:'c', 68:'d', 69:'e', 70:'f', 71:'g',
        72:'h', 73:'i', 74:'j', 75:'k', 76:'l', 77:'m', 78:'n',
        79:'o', 80:'p', 81:'q', 82:'r', 83:'s', 84:'t', 85:'u',
        86:'v', 87:'w', 88:'x', 89:'y', 90:'z',
        91:'command', 93:'menu',
        96:'numpad_0', 97:'numpad_1', 98:'numpad_2', 99:'numpad_3',
        100:'numpad_4', 101:'numpad_5', 102:'numpad_6', 103:'numpad_7',
        104:'numpad_8', 105:'numpad_9',
        106:'multiply', 107:'add', 109:'subtract', 110:'decimal', 111:'divide',
        112:'f1', 113:'f2', 114:'f3', 115:'f4', 116:'f5', 117:'f6',
        118:'f7', 119:'f8', 120:'f9', 121:'f10', 122:'f11', 123:'f12',
        144:'num_lock', 145:'scroll_lock',
        186:'semicolon', 187:'equal', 188:'comma', 189:'minus',
        190:'period', 191:'slash', 192:'grave', 219:'open_bracket',
        220:'backslash', 221:'close_bracket', 222:'quote',
    };
    return m[vk] || null;
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
    createWindow();
    connect();
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { app.isQuitting = true; });
