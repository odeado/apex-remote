/**
 * ApexRemote — Cliente Controlador
 * WebSocket relay + soporte táctil para móvil/tablet
 */

class ApexRemote {
    constructor() {
        this.ws          = null;
        this.streaming   = false;
        this.canvas      = null;
        this.ctx         = null;
        this.fpsFrames   = 0;
        this.fpsLast     = performance.now();
        this._hudTimer   = null;

        // Coordenadas táctiles activas
        this._touchActive = false;
        this._lastTouchX  = 0;
        this._lastTouchY  = 0;

        const wsProto    = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const host       = (location.protocol === 'file:') ? 'localhost:8080' : location.host;
        this.relayWsUrl  = `${wsProto}//${host}/ws`;

        this._init();
    }

    _init() {
        this.canvas = document.getElementById('remote-canvas');
        this.ctx    = this.canvas?.getContext('2d');

        const nameEl = document.getElementById('local-hostname');
        if (nameEl) nameEl.textContent = location.hostname === 'localhost' ? 'Mi PC (Local)' : 'Controlador Web';

        this._bindUI();
        this._connect();
    }

    // ── Conectar al relay ────────────────────────────────────────────────────
    _connect() {
        this._setStatus('connecting', 'Conectando...');
        try {
            this.ws = new WebSocket(this.relayWsUrl);
            this.ws.binaryType = 'arraybuffer';

            this.ws.onopen    = () => this._setStatus('online', 'Servidor listo ✓');
            this.ws.onmessage = e => this._onMessage(e);
            this.ws.onclose   = () => {
                this._setStatus('error', 'Sin conexión');
                if (this.streaming) this._agentGone();
                setTimeout(() => this._connect(), 4000);
            };
            this.ws.onerror = () => this._setStatus('error', 'Error de conexión');
        } catch {
            this._setStatus('error', 'No se pudo conectar');
        }
    }

    _onMessage(e) {
        if (e.data instanceof ArrayBuffer) { this._renderFrame(e.data); return; }
        let msg; try { msg = JSON.parse(e.data); } catch { return; }

        if (msg.type === 'session_started') {
            document.getElementById('viewer-hostname').textContent   = msg.info?.hostname ?? 'Equipo Remoto';
            document.getElementById('viewer-id-display').textContent = `ID: ${msg.id}`;
            this.streaming = true;
            this._hideOverlay();
            this._startHud();
        } else if (msg.type === 'error') {
            this._showError(msg.message);
        } else if (msg.type === 'agent_disconnected') {
            this._agentGone();
        }
    }

    // ── Conectar a equipo remoto ──────────────────────────────────────────────
    startSession(id) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN)
            return this._showError('Sin conexión al servidor. Espera un momento...');
        this._clearError();
        this._showScreen('viewer');
        this._showOverlay(`Conectando con ID: ${id}...`);
        this.ws.send(JSON.stringify({ type: 'view', id }));
    }

    quickConnect(id) {
        const inp = document.getElementById('remote-id-input');
        if (inp) inp.value = id;
        this.startSession(id);
    }

    endSession() {
        this.streaming = false;
        this._showScreen('home');
        if (this._hudTimer) { cancelAnimationFrame(this._hudTimer); this._hudTimer = null; }
    }

    _agentGone() {
        this.streaming = false;
        this._showOverlay('El equipo remoto se desconectó.');
        setTimeout(() => this.endSession(), 2500);
    }

    // ── Render JPEG ──────────────────────────────────────────────────────────
    _renderFrame(data) {
        if (!this.streaming || !this.ctx) return;
        const url = URL.createObjectURL(new Blob([data], { type: 'image/jpeg' }));
        const img = new Image();
        img.onload = () => {
            if (!this.streaming) { URL.revokeObjectURL(url); return; }
            if (this.canvas.width !== img.naturalWidth || this.canvas.height !== img.naturalHeight) {
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

    // ── Input: Mouse y Teclado ───────────────────────────────────────────────
    _bindUI() {
        // Botón conectar
        document.getElementById('btn-connect')?.addEventListener('click', () => {
            const id = document.getElementById('remote-id-input').value.trim();
            if (id.length === 6) this.startSession(id);
        });

        document.getElementById('remote-id-input')?.addEventListener('keydown', e => {
            if (e.key === 'Enter') {
                const id = e.target.value.trim();
                if (id.length === 6) this.startSession(id);
            }
            if (!/^\d$/.test(e.key) && !['Backspace','Tab','ArrowLeft','ArrowRight','Delete'].includes(e.key))
                e.preventDefault();
        });

        document.getElementById('btn-disconnect')?.addEventListener('click', () => this.endSession());

        document.getElementById('btn-fullscreen')?.addEventListener('click', () => {
            const wrap = document.getElementById('canvas-wrap');
            if (!document.fullscreenElement) wrap?.requestFullscreen?.();
            else document.exitFullscreen?.();
        });

        // Touch buttons (móvil)
        document.getElementById('touch-lclick')?.addEventListener('touchstart', e => {
            e.preventDefault();
            this._sendInput({ MouseDown: { button: 'Left' } });
        });
        document.getElementById('touch-lclick')?.addEventListener('touchend', e => {
            e.preventDefault();
            this._sendInput({ MouseUp: { button: 'Left' } });
        });
        document.getElementById('touch-rclick')?.addEventListener('touchstart', e => {
            e.preventDefault();
            this._sendInput({ MouseDown: { button: 'Right' } });
        });
        document.getElementById('touch-rclick')?.addEventListener('touchend', e => {
            e.preventDefault();
            this._sendInput({ MouseUp: { button: 'Right' } });
        });
        document.getElementById('touch-scroll-up')?.addEventListener('touchstart', e => {
            e.preventDefault(); this._sendInput({ MouseScroll: { delta_y: -120 } });
        });
        document.getElementById('touch-scroll-down')?.addEventListener('touchstart', e => {
            e.preventDefault(); this._sendInput({ MouseScroll: { delta_y: 120 } });
        });

        // Mouse en canvas
        const canvas = this.canvas;
        if (!canvas) return;

        let lastMove = 0;
        canvas.addEventListener('mousemove', e => {
            const now = performance.now();
            if (now - lastMove < 25) return;
            lastMove = now;
            this._sendInput({ MouseMove: this._coords(e) });
        });
        canvas.addEventListener('mousedown',   e => { e.preventDefault(); this._sendInput({ MouseDown: { button: ['Left','Middle','Right'][e.button] ?? 'Left' } }); });
        canvas.addEventListener('mouseup',     e => this._sendInput({ MouseUp: { button: ['Left','Middle','Right'][e.button] ?? 'Left' } }));
        canvas.addEventListener('contextmenu', e => e.preventDefault());
        canvas.addEventListener('wheel',       e => { e.preventDefault(); this._sendInput({ MouseScroll: { delta_y: Math.round(e.deltaY) } }); }, { passive: false });

        // Touch en canvas (deslizar para mover ratón)
        canvas.addEventListener('touchstart', e => {
            e.preventDefault();
            const t = e.touches[0];
            this._lastTouchX = t.clientX;
            this._lastTouchY = t.clientY;
            this._touchActive = true;
            this._sendInput({ MouseMove: this._coordsTouch(t) });
        }, { passive: false });

        canvas.addEventListener('touchmove', e => {
            e.preventDefault();
            const t = e.touches[0];
            const now = performance.now();
            if (now - lastMove < 30) return;
            lastMove = now;
            this._sendInput({ MouseMove: this._coordsTouch(t) });
            this._lastTouchX = t.clientX;
            this._lastTouchY = t.clientY;
        }, { passive: false });

        canvas.addEventListener('touchend', e => { e.preventDefault(); this._touchActive = false; }, { passive: false });

        // Teclado
        window.addEventListener('keydown', e => {
            if (!this.streaming) return;
            if (['F11', 'F5'].includes(e.key)) return;
            e.preventDefault();
            this._sendInput({ KeyDown: { key_code: e.keyCode } });
        });
        window.addEventListener('keyup', e => {
            if (!this.streaming) return;
            this._sendInput({ KeyUp: { key_code: e.keyCode } });
        });
    }

    _sendInput(event) {
        if (!this.streaming || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        this.ws.send(JSON.stringify({ type: 'input', event }));
    }

    // Coordenadas relativas al canvas (0.0 – 1.0)
    _coords(e) {
        const r = this.canvas.getBoundingClientRect();
        return {
            rx: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
            ry: Math.max(0, Math.min(1, (e.clientY - r.top)  / r.height))
        };
    }

    _coordsTouch(t) {
        const r = this.canvas.getBoundingClientRect();
        return {
            rx: Math.max(0, Math.min(1, (t.clientX - r.left) / r.width)),
            ry: Math.max(0, Math.min(1, (t.clientY - r.top)  / r.height))
        };
    }

    // ── HUD ──────────────────────────────────────────────────────────────────
    _startHud() {
        this.fpsFrames = 0;
        this.fpsLast   = performance.now();
        const tick = () => {
            if (!this.streaming) return;
            this._hudTimer = requestAnimationFrame(tick);
            const now = performance.now(), diff = now - this.fpsLast;
            if (diff >= 1000) {
                const fps = (this.fpsFrames * 1000 / diff).toFixed(1);
                const el  = document.getElementById('hud-fps');
                if (el) el.textContent = fps;
                this.fpsFrames = 0;
                this.fpsLast   = now;
            }
        };
        this._hudTimer = requestAnimationFrame(tick);
    }

    // ── Helpers UI ───────────────────────────────────────────────────────────
    _showScreen(name) {
        document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
        document.getElementById(name === 'home' ? 'screen-home' : 'screen-viewer')?.classList.add('active');
    }

    _showOverlay(text) {
        const el = document.getElementById('viewer-overlay');
        el?.classList.remove('hidden');
        const t = document.getElementById('overlay-text');
        if (t) t.textContent = text;
    }

    _hideOverlay() { document.getElementById('viewer-overlay')?.classList.add('hidden'); }

    _setStatus(state, text) {
        const dot  = document.getElementById('status-dot');
        const span = document.getElementById('status-text');
        if (dot) { dot.className = 'status-dot'; if (state === 'online') dot.classList.add('online'); else if (state === 'error') dot.classList.add('error'); }
        if (span) span.textContent = text;
    }

    _showError(msg) {
        const el = document.getElementById('connect-error');
        if (!el) return;
        el.textContent = msg;
        el.classList.remove('hidden');
    }

    _clearError() { document.getElementById('connect-error')?.classList.add('hidden'); }
}

window.addEventListener('DOMContentLoaded', () => { window.apexClient = new ApexRemote(); });
