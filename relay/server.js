/**
 * ╔══════════════════════════════════════════════════════╗
 * ║          ApexRemote - Relay & HTTP Server            ║
 * ║                                                      ║
 * ║  Soporta tanto WebSockets como HTTPS POST Polling    ║
 * ║  para compatibilidad 100% con Windows 7/8/10/11.     ║
 * ╚══════════════════════════════════════════════════════╝
 */

const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const PORT       = process.env.PORT || 8080;
const CLIENT_DIR = path.resolve(__dirname, '..', 'client');

// ── Sesiones activas ──────────────────────────────────────────────────────────
const sessions = new Map();

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css':  'text/css',
    '.js':   'application/javascript',
    '.ico':  'image/x-icon',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
};

// ── HTTP Server ───────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {

    // ── HTTP Endpoint: Registro de Agente (Windows 7 HTTPS Fallback) ───────────
    if (req.method === 'POST' && req.url === '/api/agent/register') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const id = data.id || generateId();
                if (!sessions.has(id)) {
                    sessions.set(id, { agent: 'http', viewers: new Set(), inputs: [], lastFrame: null, lastSeen: Date.now() });
                } else {
                    const s = sessions.get(id);
                    s.lastSeen = Date.now();
                }
                console.log(`✅ [HTTP AGENT Win7] Registered ID=${id}`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ type: 'registered', id }));
            } catch (e) {
                res.writeHead(400); res.end();
            }
        });
        return;
    }

    // ── HTTP Endpoint: Recepción de Frame JPEG desde Agente (Auto-registro) ────
    if (req.method === 'POST' && req.url.startsWith('/api/agent/frame')) {
        const urlParams = new URLSearchParams(req.url.split('?')[1]);
        const id = urlParams.get('id');
        let chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            const frameBuffer = Buffer.concat(chunks);
            let session = sessions.get(id);
            if (!session) {
                session = { agent: 'http', viewers: new Set(), inputs: [], lastFrame: null, lastSeen: Date.now() };
                sessions.set(id, session);
                console.log(`✅ [HTTP AGENT Auto-Registered] ID=${id}`);
            }

            session.lastSeen = Date.now();
            if (frameBuffer.length > 0) {
                session.lastFrame = frameBuffer;
                // Transmitir a los viewers conectados vía WebSocket
                session.viewers.forEach(viewer => {
                    if (viewer.readyState === WebSocket.OPEN) {
                        viewer.send(frameBuffer, { binary: true });
                    }
                });
            }

            // Responder con eventos de input pendientes para el agente Win7
            const pendingInputs = session.inputs.splice(0, 10);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ hasViewers: session.viewers.size > 0, inputs: pendingInputs }));
        });
        return;
    }

    // ── Long-Poll: El agente espera hasta recibir inputs (latencia = solo RTT) ──
    if (req.method === 'GET' && req.url.startsWith('/api/agent/poll')) {
        const urlParams = new URLSearchParams(req.url.split('?')[1]);
        const id = urlParams.get('id');
        if (!id) { res.writeHead(400); res.end(); return; }

        let session = sessions.get(id);
        if (!session) {
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
            res.end(JSON.stringify({ inputs: [] }));
            return;
        }

        // Si ya hay inputs en cola → responder de inmediato
        if (session.inputs.length > 0) {
            const inputs = session.inputs.splice(0, 50);
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
            res.end(JSON.stringify({ inputs }));
            return;
        }

        // Si no hay inputs → mantener conexión abierta hasta 8 segundos
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });

        const timeout = setTimeout(() => {
            if (session.onInputs) { session.onInputs = null; }
            try { res.end(JSON.stringify({ inputs: [] })); } catch {}
        }, 8000);

        session.onInputs = (inputs) => {
            clearTimeout(timeout);
            session.onInputs = null;
            try { res.end(JSON.stringify({ inputs })); } catch {}
        };

        req.on('close', () => { clearTimeout(timeout); session.onInputs = null; });
        return;
    }

    // Servir UI estática
    let filePath = path.join(CLIENT_DIR, req.url === '/' ? 'index.html' : req.url);
    const ext    = path.extname(filePath);
    const mime   = MIME[ext] || 'text/plain';

    fs.readFile(filePath, (err, data) => {
        if (err) {
            fs.readFile(path.join(CLIENT_DIR, 'index.html'), (err2, d) => {
                if (err2) { res.writeHead(404); return res.end('404'); }
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
                res.end(d);
            });
            return;
        }
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache, no-store, must-revalidate' });
        res.end(data);
    });
});

// ── WebSocket Server ──────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
    ws._role = null;
    ws._id   = null;

    ws.on('message', (data, isBinary) => {
        if (isBinary) {
            if (ws._role !== 'agent') return;
            const session = sessions.get(ws._id);
            if (!session) return;
            session.viewers.forEach(viewer => {
                if (viewer.readyState === WebSocket.OPEN) {
                    viewer.send(data, { binary: true });
                }
            });
            return;
        }

        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return; }

        switch (msg.type) {
            case 'register': {
                const id = msg.id || generateId();
                ws._role = 'agent';
                ws._id   = id;

                if (!sessions.has(id)) {
                    sessions.set(id, { agent: ws, viewers: new Set(), inputs: [], lastFrame: null, lastSeen: Date.now() });
                } else {
                    sessions.get(id).agent = ws;
                }
                console.log(`✅ [WS AGENT] Registered ID=${id}`);
                ws.send(JSON.stringify({ type: 'registered', id }));
                break;
            }

            case 'view': {
                const id = msg.id?.replace(/[^0-9]/g, '');
                if (!id) return ws.send(JSON.stringify({ type: 'error', message: 'ID inválido' }));

                let session = sessions.get(id);
                if (!session) {
                    return ws.send(JSON.stringify({ type: 'error', message: `Equipo ${id} no encontrado o desconectado` }));
                }

                ws._role = 'viewer';
                ws._id   = id;
                session.viewers.add(ws);

                console.log(`👁  [VIEW] ID=${id} Viewers=${session.viewers.size}`);
                ws.send(JSON.stringify({ type: 'session_started', id, info: { hostname: 'Equipo Remoto' } }));

                // Si hay un frame previo guardado, enviarlo inmediatamente
                if (session.lastFrame) {
                    ws.send(session.lastFrame, { binary: true });
                }

                if (session.agent && typeof session.agent.send === 'function' && session.agent.readyState === WebSocket.OPEN) {
                    session.agent.send(JSON.stringify({ type: 'viewer_connected', count: session.viewers.size }));
                }
                break;
            }

            case 'input': {
                if (ws._role !== 'viewer') return;
                const session = sessions.get(ws._id);
                if (!session) return;

                if (session.agent && typeof session.agent.send === 'function' && session.agent.readyState === WebSocket.OPEN) {
                    if (msg.event && msg.event.FileChunk) {
                        session.agent.send(JSON.stringify({ type: 'file_chunk', ...msg.event.FileChunk }));
                    } else {
                        session.agent.send(JSON.stringify(msg));
                    }
                } else {
                    if (msg.event && msg.event.FileChunk) {
                        session.inputs.push({ FileChunk: msg.event.FileChunk });
                    } else {
                        session.inputs.push(msg.event);
                    }
                    if (session.onInputs) {
                        const inputs = session.inputs.splice(0, 50);
                        session.onInputs(inputs);
                    }
                }
                break;
            }
        }
    });

    ws.on('close', () => {
        if (!ws._id) return;
        const session = sessions.get(ws._id);
        if (!session) return;
        if (ws._role === 'viewer') session.viewers.delete(ws);
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`⚡ ApexRemote Relay Server v1.0 corriendo en puerto ${PORT}`);
});

function generateId() {
    return String(Math.floor(100000 + Math.random() * 900000));
}
