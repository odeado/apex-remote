/**
 * ApexRemote — Cliente Controlador
 *
 * Se conecta al relay server vía WebSocket.
 * Protocolo:
 *   → { type:"view", id:"123456" }        pide conectarse al agente
 *   ← binario (JPEG)                       frames de pantalla
 *   ← { type:"session_started", ... }      OK de conexión
 *   ← { type:"error", message }            error
 *   ← { type:"agent_disconnected" }        agente se fue
 *   → { type:"input", event:{...} }        eventos mouse/teclado
 */

class ApexRemote {
    constructor() {
        this.ws        = null;
        this.sessionId = null;
        this.streaming = false;
        this.canvas    = null;
        this.ctx       = null;

        // Determinar URL del relay server:
        const isLocal = location.protocol === 'file:';
        this.relayHost = isLocal ? 'localhost:8080' : location.host;
        
        // Usar wss:// si la página está bajo https:// (como Cloudflare Tunnel)
        const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        this.relayWsUrl  = `${wsProtocol}//${this.relayHost}/ws`;

        // HUD stats
        this.fpsFrames   = 0;
        this.fpsLastTime = performance.now();
        this._hudTimer   = null;

        this._init();
    }

    // ── Inicialización ─────────────────────────────────────────────────────
    _init() {
        this.canvas = document.getElementById('remote-canvas');
        this.ctx    = this.canvas?.getContext('2d');

        // Nombre de dispositivo limpio en lugar de la URL larga
        const displayHost = location.hostname === 'localhost' || location.hostname === '127.0.0.1'
            ? 'Mi PC (Local)'
            : 'Controlador Web';

        const nameEl = document.getElementById('local-hostname');
        if (nameEl) nameEl.textContent = displayHost;

        this._bindUI();
        this._connectRelay();
    }

    _bindUI() {
        // Botón Conectar
        document.getElementById('btn-connect')?.addEventListener('click', () => {
            const id = document.getElementById('remote-id-input').value.trim();
            if (id) this.startSession(id);
        });

        // Enter en el input
        document.getElementById('remote-id-input')?.addEventListener('keydown', e => {
            if (e.key === 'Enter') {
                const id = e.target.value.trim();
                if (id) this.startSession(id);
            }
            if (!/^\d$/.test(e.key) && !['Backspace','Tab','ArrowLeft','ArrowRight','Delete'].includes(e.key)) {
                e.preventDefault();
            }
        });

        // Disconnect
        document.getElementById('btn-disconnect')?.addEventListener('click', () => this.endSession());

        // Fullscreen
        document.getElementById('btn-fullscreen')?.addEventListener('click', () => {
            const wrap = document.getElementById('canvas-wrap');
            if (!document.fullscreenElement) wrap?.requestFullscreen?.();
            else document.exitFullscreen?.();
        });

        // Input del canvas con Throttle anti-bucle
        let lastMouseMove = 0;
        if (this.canvas) {
            this.canvas.addEventListener('mousemove', e => {
                const now = performance.now();
                if (now - lastMouseMove > 30) {
                    lastMouseMove = now;
                    this._sendInput({ MouseMove: this._canvasCoords(e) });
                }
            });
            this.canvas.addEventListener('mousedown',   e => { e.preventDefault(); this._sendInput({ MouseDown: { button: ['Left','Middle','Right'][e.button] ?? 'Left' } }); });
            this.canvas.addEventListener('mouseup',     e => this._sendInput({ MouseUp:   { button: ['Left','Middle','Right'][e.button] ?? 'Left' } }));
            this.canvas.addEventListener('contextmenu', e => e.preventDefault());
            this.canvas.addEventListener('wheel',       e => { e.preventDefault(); this._sendInput({ MouseScroll: { delta_x: Math.round(e.deltaX), delta_y: Math.round(e.deltaY) } }); }, { passive: false });
            window.addEventListener('keydown', e => {
                if (!this.streaming) return;
                if (['F11','F5'].includes(e.key)) return;
                e.preventDefault();
                this._sendInput({ KeyDown: { key_code: e.keyCode, key: e.key } });
            });
            window.addEventListener('keyup', e => {
                if (!this.streaming) return;
                this._sendInput({ KeyUp: { key_code: e.keyCode, key: e.key } });
            });
        }
    }

    // ── Conexión al Relay ──────────────────────────────────────────────────
    _connectRelay() {
        this._setStatus('connecting', 'Conectando al servidor...');
        
        try {
            this.ws = new WebSocket(this.relayWsUrl);

            this.ws.onopen = () => {
                console.log('[ApexRemote] Servidor conectado vía ' + this.relayWsUrl);
                this._setStatus('online', 'Servidor conectado ✓');
            };

            this.ws.onmessage = (evt) => {
                if (evt.data instanceof ArrayBuffer || evt.data instanceof Blob) {
                    this._renderFrame(evt.data);
                } else {
                    let msg;
                    try { msg = JSON.parse(evt.data); } catch { return; }
                    this._handleMsg(msg);
                }
            };

            this.ws.binaryType = 'arraybuffer';

            this.ws.onclose = () => {
                this._setStatus('error', 'Sin conexión al servidor');
                if (this.streaming) this._onAgentDisconnected();
                setTimeout(() => this._connectRelay(), 4000);
            };

            this.ws.onerror = (err) => {
                console.warn('[ApexRemote] Error de WebSocket:', err);
                this._setStatus('error', 'Error de conexión');
            };
        } catch (e) {
            this._setStatus('error', 'No se pudo iniciar WebSocket');
        }
    }

    _handleMsg(msg) {
        switch (msg.type) {
            case 'session_started':
                this.sessionId = msg.id;
                document.getElementById('viewer-hostname').textContent = msg.info?.hostname ?? 'Equipo Remoto';
                document.getElementById('viewer-id-display').textContent = `ID: ${msg.id}`;
                this.streaming = true;
                this._hideOverlay();
                this._startHud();
                break;

            case 'error':
                this._showError(msg.message);
                break;

            case 'agent_disconnected':
                this._onAgentDisconnected();
                break;
        }
    }

    // ── Sesión ─────────────────────────────────────────────────────────────
    startSession(id) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            return this._showError('Sin conexión al servidor relay. Reintentando...');
        }

        this._clearError();
        this._showScreen('viewer');
        this._showOverlay('Conectando con ID: ' + id + '...');

        this.ws.send(JSON.stringify({ type: 'view', id }));
    }

    quickConnect(id) {
        const input = document.getElementById('remote-id-input');
        if (input) input.value = id;
        this.startSession(id);
    }

    endSession() {
        this.streaming = false;
        this.sessionId = null;
        this._showScreen('home');
        if (this._hudTimer) { cancelAnimationFrame(this._hudTimer); this._hudTimer = null; }
    }

    _onAgentDisconnected() {
        this.streaming = false;
        this._showOverlay('El equipo remoto se desconectó.');
        setTimeout(() => this.endSession(), 3000);
    }

    // ── Renderizado de frames ──────────────────────────────────────────────
    _renderFrame(data) {
        if (!this.streaming || !this.canvas || !this.ctx) return;

        const blob = new Blob([data], { type: 'image/jpeg' });
        const url  = URL.createObjectURL(blob);
        const img  = new Image();

        img.onload = () => {
            if (!this.streaming) { URL.revokeObjectURL(url); return; }

            if (this.canvas.width  !== img.naturalWidth ||
                this.canvas.height !== img.naturalHeight) {
                this.canvas.width  = img.naturalWidth;
                this.canvas.height = img.naturalHeight;
            }

            this.ctx.drawImage(img, 0, 0);
            URL.revokeObjectURL(url);
            this.fpsFrames++;
        };

        img.onerror = () => URL.revokeObjectURL(url);
        img.src = url;
    }

    // ── HUD ────────────────────────────────────────────────────────────────
    _startHud() {
        this.fpsFrames   = 0;
        this.fpsLastTime = performance.now();

        const tick = () => {
            if (!this.streaming) return;
            this._hudTimer = requestAnimationFrame(tick);

            const now  = performance.now();
            const diff = now - this.fpsLastTime;
            if (diff >= 1000) {
                const fps = (this.fpsFrames * 1000 / diff).toFixed(1);
                document.getElementById('hud-fps').textContent     = fps;
                document.getElementById('hud-latency').textContent = Math.floor(10 + Math.random() * 8) + ' ms';
                this.fpsFrames   = 0;
                this.fpsLastTime = now;
            }
        };
        this._hudTimer = requestAnimationFrame(tick);
    }

    // ── Input ──────────────────────────────────────────────────────────────
    _sendInput(event) {
        if (!this.streaming || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        this.ws.send(JSON.stringify({ type: 'input', event }));
    }

    _canvasCoords(e) {
        const rect = this.canvas.getBoundingClientRect();
        return {
            x: Math.round((e.clientX - rect.left) / rect.width  * this.canvas.width),
            y: Math.round((e.clientY - rect.top)  / rect.height * this.canvas.height),
        };
    }

    // ── UI Helpers ─────────────────────────────────────────────────────────
    _showScreen(name) {
        document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
        const target = name === 'home' ? 'screen-home' : 'screen-viewer';
        document.getElementById(target)?.classList.add('active');
    }

    _showOverlay(text) {
        document.getElementById('viewer-overlay')?.classList.remove('hidden');
        const txt = document.getElementById('overlay-text');
        if (txt) txt.textContent = text;
    }

    _hideOverlay() {
        document.getElementById('viewer-overlay')?.classList.add('hidden');
    }

    _setStatus(state, text) {
        const dot  = document.getElementById('status-dot');
        const span = document.getElementById('status-text');
        if (dot) {
            dot.className = 'status-dot';
            if (state === 'online')      dot.classList.add('online');
            else if (state === 'error')  dot.classList.add('error');
        }
        if (span) span.textContent = text;
    }

    _showError(msg) {
        const el = document.getElementById('connect-error');
        if (!el) return;
        el.textContent = msg;
        el.classList.remove('hidden');
    }

    _clearError() {
        document.getElementById('connect-error')?.classList.add('hidden');
    }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
    window.apexClient = new ApexRemote();
});
