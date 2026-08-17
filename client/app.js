/**
 * ApexRemote v3.1 — Cliente con recientes + transferencia de archivos
 */
class ApexRemote {
    constructor() {
        this.ws        = null;
        this.streaming = false;
        this.canvas    = null;
        this.ctx       = null;
        this.fpsFrames = 0;
        this.fpsLast   = performance.now();
        this._hudTimer = null;
        this._fitted   = false;

        const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const host    = location.protocol === 'file:' ? 'localhost:8080' : location.host;
        this.relayWsUrl = wsProto + '//' + host + '/ws';

        this._init();
    }

    _init() {
        this.canvas = document.getElementById('remote-canvas');
        this.ctx    = this.canvas ? this.canvas.getContext('2d') : null;
        this._renderRecents();
        this._bindUI();
        this._connect();
    }

    // ── WebSocket ────────────────────────────────────────────────────────────
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
        } catch { this._setStatus('error', 'No se pudo conectar'); }
    }

    _onMessage(e) {
        if (e.data instanceof ArrayBuffer) { this._renderFrame(e.data); return; }
        let msg; try { msg = JSON.parse(e.data); } catch { return; }
        if (msg.type === 'session_started') {
            document.getElementById('viewer-hostname').textContent   = msg.info && msg.info.hostname ? msg.info.hostname : 'Equipo Remoto';
            document.getElementById('viewer-id-display').textContent = 'ID: ' + msg.id;
            this.streaming = true;
            this._hideOverlay();
            this._startHud();
            this._showFileBar();
        } else if (msg.type === 'error') {
            this._showError(msg.message);
        } else if (msg.type === 'agent_disconnected') {
            this._agentGone();
        }
    }

    // ── Session ──────────────────────────────────────────────────────────────
    startSession(id) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN)
            return this._showError('Sin conexión al servidor. Espera un momento...');
        this._clearError();
        this._saveRecent(id);
        this._showScreen('viewer');
        this._showOverlay('Conectando con ID: ' + id + '...');
        this.ws.send(JSON.stringify({ type: 'view', id }));
    }

    quickConnect(id) {
        const inp = document.getElementById('remote-id-input');
        if (inp) inp.value = id;
        this.startSession(id);
    }

    endSession() {
        this.streaming = false;
        this._fitted = false;
        this._hideFileBar();
        this._showScreen('home');
        if (this._hudTimer) { cancelAnimationFrame(this._hudTimer); this._hudTimer = null; }
    }

    _agentGone() {
        this.streaming = false;
        this._showOverlay('El equipo remoto se desconectó.');
        setTimeout(() => this.endSession(), 2500);
    }

    // ── Render frames ────────────────────────────────────────────────────────
    _renderFrame(data) {
        if (!this.streaming || !this.ctx) return;
        const url = URL.createObjectURL(new Blob([data], { type: 'image/jpeg' }));
        const img = new Image();
        img.onload = () => {
            if (!this.streaming) { URL.revokeObjectURL(url); return; }
            if (this.canvas.width !== img.naturalWidth || this.canvas.height !== img.naturalHeight) {
                this.canvas.width  = img.naturalWidth;
                this.canvas.height = img.naturalHeight;
                this._fitCanvas();
            }
            this.ctx.drawImage(img, 0, 0);
            URL.revokeObjectURL(url);
            this.fpsFrames++;
        };
        img.onerror = () => URL.revokeObjectURL(url);
        img.src = url;
    }

    _fitCanvas() {
        if (!this.canvas || !this.canvas.width) return;
        const wrap = document.getElementById('canvas-wrap');
        if (!wrap) return;
        const availW = wrap.clientWidth;
        const availH = wrap.clientHeight;
        const scale  = Math.min(availW / this.canvas.width, availH / this.canvas.height);
        this.canvas.style.width  = Math.round(this.canvas.width  * scale) + 'px';
        this.canvas.style.height = Math.round(this.canvas.height * scale) + 'px';
    }

    // ── Recent connections ───────────────────────────────────────────────────
    _saveRecent(id) {
        let list = this._loadRecentList();
        const existing = list.find(r => r.id === id);
        const name = existing ? existing.name : '';
        list = list.filter(r => r.id !== id);
        list.unshift({ id, name, lastSeen: Date.now() });
        if (list.length > 8) list = list.slice(0, 8);
        try { localStorage.setItem('apx_recent', JSON.stringify(list)); } catch {}
        this._renderRecents();
    }

    _renameRecent(id, e) {
        if (e) e.stopPropagation();
        let list = this._loadRecentList();
        const item = list.find(r => r.id === id);
        const newName = prompt('Nombre para este equipo (' + id + '):', item ? item.name || '' : '');
        if (newName === null) return;
        list = list.map(r => r.id === id ? Object.assign({}, r, { name: newName.trim() }) : r);
        try { localStorage.setItem('apx_recent', JSON.stringify(list)); } catch {}
        this._renderRecents();
    }

    _deleteRecent(id, e) {
        if (e) e.stopPropagation();
        let list = this._loadRecentList();
        list = list.filter(r => r.id !== id);
        try { localStorage.setItem('apx_recent', JSON.stringify(list)); } catch {}
        this._renderRecents();
    }

    _loadRecentList() {
        try { return JSON.parse(localStorage.getItem('apx_recent') || '[]'); } catch { return []; }
    }

    _renderRecents() {
        const list = this._loadRecentList();
        const container = document.getElementById('recent-list');
        if (!container) return;
        if (list.length === 0) {
            container.innerHTML = '<p class="no-recent">Sin conexiones recientes</p>';
            return;
        }
        container.innerHTML = list.map(r => {
            const ago = this._timeAgo(r.lastSeen);
            const displayName = r.name ? r.name : r.id;
            const subText = r.name ? r.id + ' · ' + ago : ago;
            return '<div class="recent-item" onclick="apexClient.quickConnect(\'' + r.id + '\')">' +
                '<div class="recent-icon">🖥</div>' +
                '<div class="recent-info">' +
                '<div class="recent-id">' + this._escapeHtml(displayName) + '</div>' +
                '<div class="recent-time">' + subText + '</div></div>' +
                '<div class="recent-actions">' +
                '<button class="recent-action-btn" title="Renombrar equipo" onclick="apexClient._renameRecent(\'' + r.id + '\', event)">✏️</button>' +
                '<button class="recent-action-btn danger" title="Eliminar de recientes" onclick="apexClient._deleteRecent(\'' + r.id + '\', event)">🗑️</button>' +
                '<button class="recent-connect" title="Conectar">▶</button>' +
                '</div></div>';
        }).join('');
    }

    _escapeHtml(str) {
        return (str || '').replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }

    _timeAgo(ts) {
        const s = Math.floor((Date.now() - ts) / 1000);
        if (s < 60)    return 'Hace ' + s + 's';
        if (s < 3600)  return 'Hace ' + Math.floor(s / 60) + 'min';
        if (s < 86400) return 'Hace ' + Math.floor(s / 3600) + 'h';
        return 'Hace ' + Math.floor(s / 86400) + 'd';
    }

    // ── File transfer ────────────────────────────────────────────────────────
    _handleFileUpload(file) {
        if (!this.streaming) { alert('Conecta a un equipo primero'); return; }
        if (file.size > 25 * 1024 * 1024) { alert('Máx 25MB por archivo'); return; }
        const label = document.getElementById('file-label');
        const bar   = document.getElementById('file-progress');
        if (label) label.textContent = 'Leyendo ' + file.name + '...';
        const reader = new FileReader();
        reader.onload = (e) => {
            const dataUrl = e.target.result;
            const b64     = dataUrl.indexOf(',') >= 0 ? dataUrl.split(',')[1] : dataUrl;
            const CHUNK   = 8000; // 8KB chunks (pequeños y seguros, cero fragmentación)
            const total   = Math.ceil(b64.length / CHUNK);
            if (label) label.textContent = 'Enviando ' + file.name + '...';

            let i = 0;
            const sendNext = () => {
                if (i >= total) {
                    if (label) label.textContent = '✓ ' + file.name + ' guardado en C:\\ApexRemote_Downloads y Escritorio';
                    if (bar)   setTimeout(() => { bar.style.width = '0%'; }, 4500);
                    return;
                }
                const chunk = b64.slice(i * CHUNK, (i + 1) * CHUNK);
                this._sendInput({ FileChunk: { name: file.name, idx: i, total: total, b64: chunk } });
                if (bar) bar.style.width = Math.round((i + 1) / total * 100) + '%';
                i++;
                setTimeout(sendNext, 8);
            };
            sendNext();
        };
        reader.readAsDataURL(file);
    }

    // ── Input binding ────────────────────────────────────────────────────────
    _bindUI() {
        document.getElementById('btn-connect')?.addEventListener('click', () => {
            const id = document.getElementById('remote-id-input').value.trim();
            if (id.length === 6) this.startSession(id);
        });
        document.getElementById('remote-id-input')?.addEventListener('keydown', e => {
            if (e.key === 'Enter') { const id = e.target.value.trim(); if (id.length === 6) this.startSession(id); }
            if (!/^\d$/.test(e.key) && !['Backspace','Tab','ArrowLeft','ArrowRight','Delete'].includes(e.key)) e.preventDefault();
        });
        document.getElementById('btn-disconnect')?.addEventListener('click', () => this.endSession());
        document.getElementById('btn-fullscreen')?.addEventListener('click', () => {
            const wrap = document.getElementById('canvas-wrap');
            if (!document.fullscreenElement) wrap?.requestFullscreen?.();
            else document.exitFullscreen?.();
            setTimeout(() => this._fitCanvas(), 200);
        });
        document.getElementById('quality-select')?.addEventListener('change', e => {
            const val = e.target.value;
            let mode = { w: 1280, h: 720, q: 45 };
            if (val === 'fast')     mode = { w: 960,  h: 540,  q: 35 };
            if (val === 'hd')       mode = { w: 1920, h: 1080, q: 60 };
            this._sendInput({ SetQuality: mode });
        });
        document.getElementById('file-input')?.addEventListener('change', e => {
            if (e.target.files[0]) this._handleFileUpload(e.target.files[0]);
        });
        const wrap = document.getElementById('canvas-wrap');
        if (wrap) {
            wrap.addEventListener('dragover', e => e.preventDefault());
            wrap.addEventListener('drop', e => { e.preventDefault(); if (this.streaming && e.dataTransfer.files[0]) this._handleFileUpload(e.dataTransfer.files[0]); });
        }

        // Touch buttons
        document.getElementById('touch-lclick')?.addEventListener('touchstart',     e => { e.preventDefault(); this._sendInput({ MouseDown: { button: 'Left'  } }); }, { passive: false });
        document.getElementById('touch-lclick')?.addEventListener('touchend',       e => { e.preventDefault(); this._sendInput({ MouseUp:   { button: 'Left'  } }); }, { passive: false });
        document.getElementById('touch-rclick')?.addEventListener('touchstart',     e => { e.preventDefault(); this._sendInput({ MouseDown: { button: 'Right' } }); }, { passive: false });
        document.getElementById('touch-rclick')?.addEventListener('touchend',       e => { e.preventDefault(); this._sendInput({ MouseUp:   { button: 'Right' } }); }, { passive: false });
        document.getElementById('touch-scroll-up')?.addEventListener('touchstart',   e => { e.preventDefault(); this._sendInput({ MouseScroll: { delta_y: -120 } }); }, { passive: false });
        document.getElementById('touch-scroll-down')?.addEventListener('touchstart', e => { e.preventDefault(); this._sendInput({ MouseScroll: { delta_y:  120 } }); }, { passive: false });

        const canvas = this.canvas;
        if (!canvas) return;
        let lastMove = 0;
        canvas.addEventListener('mousemove', e => {
            const now = performance.now();
            if (now - lastMove < 25) return;
            lastMove = now;
            this._sendInput({ MouseMove: this._coords(e) });
        });
        canvas.addEventListener('mousedown',   e => { e.preventDefault(); this._sendInput({ MouseDown: { button: ['Left','Middle','Right'][e.button] || 'Left' } }); });
        canvas.addEventListener('mouseup',     e => this._sendInput({ MouseUp: { button: ['Left','Middle','Right'][e.button] || 'Left' } }));
        canvas.addEventListener('contextmenu', e => e.preventDefault());
        canvas.addEventListener('wheel',       e => { e.preventDefault(); this._sendInput({ MouseScroll: { delta_y: Math.round(e.deltaY) } }); }, { passive: false });
        canvas.addEventListener('touchstart',  e => { e.preventDefault(); const t = e.touches[0]; lastMove = performance.now(); this._sendInput({ MouseMove: this._coordsTouch(t) }); }, { passive: false });
        canvas.addEventListener('touchmove',   e => { e.preventDefault(); const t = e.touches[0], now = performance.now(); if (now - lastMove < 30) return; lastMove = now; this._sendInput({ MouseMove: this._coordsTouch(t) }); }, { passive: false });

        window.addEventListener('keydown', e => { if (!this.streaming) return; if (['F11','F5'].includes(e.key)) return; e.preventDefault(); this._sendInput({ KeyDown: { key_code: e.keyCode } }); });
        window.addEventListener('keyup',   e => { if (!this.streaming) return; this._sendInput({ KeyUp: { key_code: e.keyCode } }); });
        window.addEventListener('resize',  () => this._fitCanvas());
    }

    _sendInput(event) {
        if (!this.streaming || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        this.ws.send(JSON.stringify({ type: 'input', event }));
    }

    _coords(e) {
        const r = this.canvas.getBoundingClientRect();
        return { rx: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), ry: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) };
    }
    _coordsTouch(t) {
        const r = this.canvas.getBoundingClientRect();
        return { rx: Math.max(0, Math.min(1, (t.clientX - r.left) / r.width)), ry: Math.max(0, Math.min(1, (t.clientY - r.top) / r.height)) };
    }

    // ── HUD ──────────────────────────────────────────────────────────────────
    _startHud() {
        this.fpsFrames = 0; this.fpsLast = performance.now();
        const tick = () => {
            if (!this.streaming) return;
            this._hudTimer = requestAnimationFrame(tick);
            const now = performance.now(), diff = now - this.fpsLast;
            if (diff >= 1000) {
                const el = document.getElementById('hud-fps');
                if (el) el.textContent = (this.fpsFrames * 1000 / diff).toFixed(1);
                this.fpsFrames = 0; this.fpsLast = now;
            }
        };
        this._hudTimer = requestAnimationFrame(tick);
    }

    // ── UI helpers ───────────────────────────────────────────────────────────
    _showScreen(name) {
        document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
        document.getElementById(name === 'home' ? 'screen-home' : 'screen-viewer')?.classList.add('active');
    }
    _showOverlay(text)  { const el = document.getElementById('viewer-overlay'); el?.classList.remove('hidden'); const t = document.getElementById('overlay-text'); if (t) t.textContent = text; }
    _hideOverlay()      { document.getElementById('viewer-overlay')?.classList.add('hidden'); }
    _showFileBar()      { document.getElementById('file-transfer-bar')?.classList.remove('hidden'); }
    _hideFileBar()      { document.getElementById('file-transfer-bar')?.classList.add('hidden'); }
    _setStatus(state, text) {
        const dot = document.getElementById('status-dot'), span = document.getElementById('status-text');
        if (dot)  { dot.className = 'status-dot'; if (state === 'online') dot.classList.add('online'); else if (state === 'error') dot.classList.add('error'); }
        if (span) span.textContent = text;
    }
    _showError(msg) { const el = document.getElementById('connect-error'); if (!el) return; el.textContent = msg; el.classList.remove('hidden'); }
    _clearError()   { document.getElementById('connect-error')?.classList.add('hidden'); }
}

window.addEventListener('DOMContentLoaded', () => { window.apexClient = new ApexRemote(); });
