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
        // Posición predicha del cursor remoto (0-1), se actualiza localmente
        // sin esperar la vuelta por red → cursor instantáneo
        this._cursorRx  = 0.5;
        this._cursorRy  = 0.5;
        this._rendering = false; // evita encolar decodificaciones JPEG

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
            this._cancelView();   // stop retry loop
            document.getElementById('viewer-hostname').textContent   = msg.info && msg.info.hostname ? msg.info.hostname : 'Equipo Remoto';
            document.getElementById('viewer-id-display').textContent = 'ID: ' + msg.id;
            this.streaming = true;
            this._hideOverlay();
            this._startHud();
            this._showFileBar();
            this._initWebRTC();
            // Mostrar hint de pointer lock y resetear posición predicha al centro
            this._cursorRx = 0.5; this._cursorRy = 0.5;
            const lockHint = document.getElementById('pointer-lock-hint');
            if (lockHint) lockHint.classList.remove('hidden');
        } else if (msg.type === 'clipboard_sync' && msg.text) {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(msg.text).catch(() => {});
            }
            this.showToast('📋 Portapapeles Recibido', 'Texto copiado desde la PC remota', '📋', 3000);
        } else if (msg.type === 'webrtc_answer') {
            if (this.pc) this.pc.setRemoteDescription(new RTCSessionDescription(msg.answer)).catch(() => {});
        } else if (msg.type === 'webrtc_ice') {
            // try-catch: RTCIceCandidate lanza síncronamente si sdpMid y sdpMLineIndex son null/undefined
            if (this.pc && msg.candidate) {
                try { this.pc.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(() => {}); } catch(e) {}
            }
        } else if (msg.type === 'error') {
            const isPinErr = msg.message && (msg.message.toLowerCase().includes('pin') || msg.message.toLowerCase().includes('contraseña'));
            if (isPinErr) {
                // PIN wrong → cancel retry and go home
                this._cancelView();
                this._showError(msg.message);
                setTimeout(() => this.endSession(), 1200);
                const ps = document.getElementById('pin-status');
                if (ps) { ps.textContent = '❌ PIN incorrecto'; ps.style.color = '#ff4d6d'; }
            } else {
                // Non-PIN error (agent not found, etc.) → retry is still running, just show toast
                // Don't call _showError (targets hidden home div)
                // The overlay text already shows the countdown — don't interrupt unless streaming
                if (this.streaming) this._agentGone();
            }
        } else if (msg.type === 'pin_rejected') {
            this._cancelView();
            this._showError('PIN incorrecto. Verifica el PIN que muestra el agente.');
            setTimeout(() => this.endSession(), 1500);
        } else if (msg.type === 'agent_disconnected') {
            this._agentGone();
        } else if (msg.type === 'fs_list_res') {
            if (this.fileExplorer) this.fileExplorer._onFsListRes(msg);
        } else if (msg.type === 'file_download_chunk') {
            if (this.fileExplorer) this.fileExplorer._onDownloadChunk(msg);
        } else if (msg.type === 'cursor_pos') {
            // Corrección de drift: sincronizamos la posición real del agente
            // pero solo si no tenemos el pointer lock (evita saltos mientras movemos)
            if (document.pointerLockElement !== this.canvas) {
                this._cursorRx = msg.rx;
                this._cursorRy = msg.ry;
                this._updateCursor(msg.rx, msg.ry);
            } else {
                // Con pointer lock: corrección suave para evitar drift acumulado
                this._cursorRx += (msg.rx - this._cursorRx) * 0.15;
                this._cursorRy += (msg.ry - this._cursorRy) * 0.15;
            }
        }
    }

    _initWebRTC() {
        try {
            const config = { iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
            ]};
            this.pc = new RTCPeerConnection(config);

            this.pc.onicecandidate = e => {
                if (e.candidate && this.ws?.readyState === WebSocket.OPEN)
                    this.ws.send(JSON.stringify({ type: 'webrtc_ice', candidate: e.candidate }));
            };

            // Recibir el video track que el agente añade al canvas stream
            this.pc.ontrack = (e) => {
                if (!e.streams[0]) return;
                this.webrtcVideo = document.createElement('video');
                this.webrtcVideo.srcObject = e.streams[0];
                this.webrtcVideo.muted      = true;
                this.webrtcVideo.autoplay   = true;
                this.webrtcVideo.playsInline = true;
                this.webrtcVideo.play().catch(() => {});
                this.webrtcActive = true;
                this._startWebRTCRender();
                this.showToast('🚀 WebRTC P2P Activo', 'Video directo sin relay — latencia mínima', '⚡', 4000);
            };

            // Indicamos que queremos recibir video (el agente enviará)
            this.pc.addTransceiver('video', { direction: 'recvonly' });

            this.pc.createOffer().then(offer => {
                this.pc.setLocalDescription(offer);
                if (this.ws?.readyState === WebSocket.OPEN)
                    this.ws.send(JSON.stringify({ type: 'webrtc_offer', offer }));
            }).catch(() => {});
        } catch(err) { console.warn('[WebRTC viewer]', err); }
    }

    _startWebRTCRender() {
        // Ocultar cursor CSS overlay — el cursor ya viene bakeado en el stream WebRTC
        const cursorEl = document.getElementById('remote-cursor');
        if (cursorEl) cursorEl.classList.add('hidden');
        const draw = () => {
            if (!this.webrtcActive || !this.webrtcVideo || !this.ctx) return;
            if (this.webrtcVideo.readyState >= 2) {
                const vw = this.webrtcVideo.videoWidth;
                const vh = this.webrtcVideo.videoHeight;
                if (vw && vh && (this.canvas.width !== vw || this.canvas.height !== vh)) {
                    this.canvas.width  = vw;
                    this.canvas.height = vh;
                    this._fitCanvas();
                }
                this.ctx.drawImage(this.webrtcVideo, 0, 0);
                this.fpsFrames++;
            }
            requestAnimationFrame(draw);
        };
        requestAnimationFrame(draw);
    }

    // ── Session ──────────────────────────────────────────────────────────────
    startSession(id) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN)
            return this._showError('Sin conexión al servidor. Espera un momento...');
        this._clearError();
        const pin = (document.getElementById('remote-pin-input')?.value || '').trim();
        this._saveRecent(id);
        this._showScreen('viewer');
        this._showOverlay('Buscando agente ' + id + '…');
        // Retry logic: keep sending view request until agent registers
        this._cancelView();
        this._pendingViewId  = id;
        this._pendingViewPin = pin;
        this._viewAttempts   = 0;
        this._sendViewMsg();
    }

    _sendViewMsg() {
        if (!this._pendingViewId) return;
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        const id  = this._pendingViewId;
        const pin = this._pendingViewPin;
        this.ws.send(JSON.stringify(pin ? { type: 'view', id, pin } : { type: 'view', id }));
        this._viewAttempts++;
        const elapsed = this._viewAttempts * 3;
        if (this._viewAttempts >= 20) {          // 60 s timeout
            this._cancelView();
            this._showOverlay('El agente ' + id + ' no responde. ¿Está corriendo el agente?');
            setTimeout(() => this.endSession(), 3500);
            return;
        }
        const el = document.getElementById('overlay-text');
        if (el) el.textContent = 'Buscando agente ' + id + '… (' + elapsed + 's)';
        this._viewRetryTimer = setTimeout(() => this._sendViewMsg(), 3000);
    }

    _cancelView() {
        this._pendingViewId = null;
        this._pendingViewPin = null;
        if (this._viewRetryTimer) { clearTimeout(this._viewRetryTimer); this._viewRetryTimer = null; }
    }

    quickConnect(id) {
        const inp = document.getElementById('remote-id-input');
        if (inp) inp.value = id;
        this.startSession(id);
    }

    endSession() {
        this._cancelView();   // stop any pending view retry
        this.streaming = false;
        this._fitted = false;
        this._hideFileBar();
        this._showScreen('home');
        if (this._hudTimer) { cancelAnimationFrame(this._hudTimer); this._hudTimer = null; }
        if (this.fileExplorer) this.fileExplorer.hide();
        const cursor = document.getElementById('remote-cursor');
        if (cursor) cursor.classList.add('hidden');
        // Liberar pointer lock y ocultar hints
        if (document.pointerLockElement) document.exitPointerLock();
        document.getElementById('pointer-lock-hint')?.classList.add('hidden');
        document.getElementById('pointer-lock-esc')?.classList.add('hidden');
        // Cerrar WebRTC
        if (this.pc) { try { this.pc.close(); } catch {} this.pc = null; }
        if (this.webrtcVideo) { this.webrtcVideo.srcObject = null; this.webrtcVideo = null; }
        this.webrtcActive = false;
    }

    _updateCursor(rx, ry) {
        const el = document.getElementById('remote-cursor');
        if (!el || !this.canvas || !this.streaming) return;
        // Con WebRTC el cursor ya viene bakeado en el video — no mostrar overlay CSS
        if (this.webrtcActive) { el.classList.add('hidden'); return; }
        const canvasRect = this.canvas.getBoundingClientRect();
        const wrapRect   = document.getElementById('canvas-wrap').getBoundingClientRect();
        const x = (canvasRect.left - wrapRect.left) + rx * canvasRect.width;
        const y = (canvasRect.top  - wrapRect.top)  + ry * canvasRect.height;
        el.style.left = Math.round(x) + 'px';
        el.style.top  = Math.round(y) + 'px';
        el.classList.remove('hidden');
    }

    _agentGone() {
        this.streaming = false;
        this._showOverlay('El equipo remoto se desconectó.');
        setTimeout(() => this.endSession(), 2500);
    }

    // ── Render frames (fallback JPEG cuando WebRTC no conecta) ───────────────
    _renderFrame(data) {
        if (!this.streaming || !this.ctx || this.webrtcActive) return;
        // Si todavía estamos decodificando el frame anterior, descartar éste.
        // Evita que se encolen frames y causen tiritones en ráfaga.
        if (this._rendering) return;
        this._rendering = true;
        createImageBitmap(new Blob([data], { type: 'image/jpeg' })).then(bmp => {
            this._rendering = false;
            if (!this.streaming || this.webrtcActive) { bmp.close(); return; }
            if (this.canvas.width !== bmp.width || this.canvas.height !== bmp.height) {
                this.canvas.width  = bmp.width;
                this.canvas.height = bmp.height;
                this._fitCanvas();
            }
            this.ctx.drawImage(bmp, 0, 0);
            bmp.close();
            this.fpsFrames++;
        }).catch(() => { this._rendering = false; });
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

    showToast(title, message, icon, duration) {
        icon = icon || '✨';
        duration = duration || 5000;
        let container = document.getElementById('toast-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'toast-container';
            container.className = 'toast-container';
            document.body.appendChild(container);
        }
        const toast = document.createElement('div');
        toast.className = 'toast';
        toast.innerHTML = 
            '<div class="toast-icon">' + icon + '</div>' +
            '<div class="toast-body">' +
            '<div class="toast-title">' + this._escapeHtml(title) + '</div>' +
            '<div class="toast-msg">' + this._escapeHtml(message) + '</div>' +
            '</div>' +
            '<button class="toast-close" onclick="this.parentElement.remove()">✕</button>';
        container.appendChild(toast);

        if (duration > 0) {
            setTimeout(() => {
                toast.classList.add('toast-out');
                setTimeout(() => toast.remove(), 300);
            }, duration);
        }
    }

    // ── File transfer ────────────────────────────────────────────────────────
    _handleFileUpload(file) {
        if (!this.streaming) { alert('Conecta a un equipo primero'); return; }
        if (file.size > 50 * 1024 * 1024) { alert('Máx 50MB por archivo'); return; }
        const label = document.getElementById('file-label');
        const bar   = document.getElementById('file-progress');
        if (label) label.textContent = 'Leyendo ' + file.name + '...';
        const reader = new FileReader();
        const startTime = performance.now();
        let bytesSent = 0;

        reader.onload = (e) => {
            const dataUrl = e.target.result;
            const b64     = dataUrl.indexOf(',') >= 0 ? dataUrl.split(',')[1] : dataUrl;
            const CHUNK   = 12000; // 12KB chunks para mayor velocidad
            const total   = Math.ceil(b64.length / CHUNK);
            if (label) label.textContent = 'Enviando ' + file.name + '...';

            let i = 0;
            const sendNext = () => {
                if (i >= total) {
                    if (label) label.textContent = '✓ ' + file.name + ' guardado en Descargas';
                    this.showToast('📁 Archivo Guardado', file.name + ' se guardó en la carpeta Descargas y Escritorio', '✅', 6000);
                    if (bar)   setTimeout(() => { bar.style.width = '0%'; }, 4500);
                    return;
                }
                const chunk = b64.slice(i * CHUNK, (i + 1) * CHUNK);
                this._sendInput({ FileChunk: { name: file.name, idx: i, total: total, b64: chunk } });
                bytesSent += chunk.length;
                const elapsedSec = (performance.now() - startTime) / 1000;
                const speedMB    = elapsedSec > 0 ? ((bytesSent * 0.75) / (1024 * 1024) / elapsedSec).toFixed(1) : '0.0';
                const pct        = Math.round((i + 1) / total * 100);

                if (label) label.textContent = 'Enviando ' + file.name + ' (' + pct + '% · ' + speedMB + ' MB/s)';
                if (bar)   bar.style.width = pct + '%';
                i++;
                setTimeout(sendNext, 6);
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
        document.getElementById('remote-pin-input')?.addEventListener('input', () => {
            const ps = document.getElementById('pin-status');
            if (ps) ps.textContent = '';
        });
        document.getElementById('btn-disconnect')?.addEventListener('click', () => this.endSession());
        document.getElementById('btn-files-remote')?.addEventListener('click', () => {
            if (!this.fileExplorer) this.fileExplorer = new FileExplorer(this);
            this.fileExplorer.toggle();
        });
        document.getElementById('btn-fullscreen')?.addEventListener('click', () => {
            const wrap = document.getElementById('canvas-wrap');
            if (!document.fullscreenElement) wrap?.requestFullscreen?.();
            else document.exitFullscreen?.();
            setTimeout(() => this._fitCanvas(), 200);
        });
        document.getElementById('quality-select')?.addEventListener('change', e => {
            const val = e.target.value;
            let mode = { w: 1280, h: 720, q: 45 }, qLabel = 'Equilibrio (720p)';
            if (val === 'fast')     { mode = { w: 960,  h: 540,  q: 35 }; qLabel = 'Rápido (540p)'; }
            if (val === 'hd')       { mode = { w: 1920, h: 1080, q: 60 }; qLabel = 'HD (1080p)'; }
            this._sendInput({ SetQuality: mode });
            this.showToast('🎛️ Calidad Cambiada', 'Modo ajustado a: ' + qLabel, '⚡', 3500);
        });
        document.getElementById('file-input')?.addEventListener('change', e => {
            if (e.target.files[0]) this._handleFileUpload(e.target.files[0]);
        });

        // ── Drag & Drop Overlay on Canvas ────────────────────────────────────
        const wrap = document.getElementById('canvas-wrap');
        if (wrap) {
            wrap.addEventListener('dragover', e => {
                e.preventDefault();
                document.getElementById('dropzone-overlay')?.classList.remove('hidden');
            });
            wrap.addEventListener('dragleave', e => {
                if (e.relatedTarget === null || !wrap.contains(e.relatedTarget)) {
                    document.getElementById('dropzone-overlay')?.classList.add('hidden');
                }
            });
            wrap.addEventListener('drop', e => {
                e.preventDefault();
                document.getElementById('dropzone-overlay')?.classList.add('hidden');
                if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                    for (let i = 0; i < e.dataTransfer.files.length; i++) {
                        this._handleFileUpload(e.dataTransfer.files[i]);
                    }
                }
            });
        }

        // ── Clipboard Copy Sync ──────────────────────────────────────────────
        window.addEventListener('copy', () => {
            if (this.streaming && navigator.clipboard) {
                navigator.clipboard.readText().then(txt => {
                    if (txt) {
                        this._sendInput({ ClipboardSync: { text: txt } });
                        this.showToast('📋 Portapapeles Copiado', 'Texto enviado a la PC remota', '✨', 2500);
                    }
                }).catch(() => {});
            }
        });

        // Touch buttons
        document.getElementById('touch-lclick')?.addEventListener('touchstart',     e => { e.preventDefault(); this._sendInput({ MouseDown: { button: 0 } }); }, { passive: false });
        document.getElementById('touch-lclick')?.addEventListener('touchend',       e => { e.preventDefault(); this._sendInput({ MouseUp:   { button: 0 } }); }, { passive: false });
        document.getElementById('touch-rclick')?.addEventListener('touchstart',     e => { e.preventDefault(); this._sendInput({ MouseDown: { button: 1 } }); }, { passive: false });
        document.getElementById('touch-rclick')?.addEventListener('touchend',       e => { e.preventDefault(); this._sendInput({ MouseUp:   { button: 1 } }); }, { passive: false });
        document.getElementById('touch-scroll-up')?.addEventListener('touchstart',   e => { e.preventDefault(); this._sendInput({ MouseScroll: { delta_y: -120 } }); }, { passive: false });
        document.getElementById('touch-scroll-down')?.addEventListener('touchstart', e => { e.preventDefault(); this._sendInput({ MouseScroll: { delta_y:  120 } }); }, { passive: false });

        const canvas = this.canvas;
        if (!canvas) return;

        // ── Pointer Lock: mouse virtual (igual que AnyDesk/TeamViewer) ────────
        // Al hacer click en el canvas se captura el cursor — desaparece localmente
        // y los movimientos se envían como deltas al equipo remoto.
        canvas.addEventListener('click', () => {
            if (!this.streaming) return;
            if (document.pointerLockElement !== canvas) canvas.requestPointerLock();
        });

        document.addEventListener('pointerlockchange', () => {
            const locked = document.pointerLockElement === canvas;
            const lockHint = document.getElementById('pointer-lock-hint');
            const escHint  = document.getElementById('pointer-lock-esc');
            if (lockHint) lockHint.classList.toggle('hidden', locked);
            if (escHint)  escHint.classList.toggle('hidden', !locked);
        });

        // Movimiento del mouse: Soporta modo Absoluto (hover/drag directo) y Pointer Lock (delta)
        let lastMoveTime = 0;
        document.addEventListener('mousemove', e => {
            if (!this.streaming) return;
            const now = performance.now();
            if (document.pointerLockElement === canvas) {
                if (now - lastMoveTime < 12) return; // 80Hz throttle para suavidad óptima
                lastMoveTime = now;
                const rect  = canvas.getBoundingClientRect();
                const scale = rect.width > 0 ? canvas.width / rect.width : 1;
                const dx = Math.round(e.movementX * scale);
                const dy = Math.round(e.movementY * scale);
                if (dx === 0 && dy === 0) return;
                this._sendInput({ MouseMoveDelta: { dx, dy } });
                this._cursorRx = Math.max(0, Math.min(1, this._cursorRx + dx / (canvas.width  || 1280)));
                this._cursorRy = Math.max(0, Math.min(1, this._cursorRy + dy / (canvas.height || 720)));
                this._updateCursor(this._cursorRx, this._cursorRy);
            } else {
                const rect = canvas.getBoundingClientRect();
                if (e.clientX >= rect.left && e.clientX <= rect.right &&
                    e.clientY >= rect.top  && e.clientY <= rect.bottom) {
                    if (now - lastMoveTime < 16) return; // ~60 FPS throttle
                    lastMoveTime = now;
                    const c = this._coords(e);
                    this._sendInput({ MouseMove: c });
                    this._cursorRx = c.rx;
                    this._cursorRy = c.ry;
                    this._updateCursor(c.rx, c.ry);
                }
            }
        });

        canvas.addEventListener('mousedown',   e => { e.preventDefault(); if (this.streaming) this._sendInput({ MouseDown: { button: e.button } }); });
        canvas.addEventListener('mouseup',     e => { if (this.streaming) this._sendInput({ MouseUp:   { button: e.button } }); });
        canvas.addEventListener('contextmenu', e => e.preventDefault());
        canvas.addEventListener('wheel',       e => { e.preventDefault(); if (this.streaming) this._sendInput({ MouseScroll: { delta_y: Math.round(e.deltaY) } }); }, { passive: false });

        // Touch: sigue usando modo absoluto (pantallas móviles)
        let lastTouch = 0;
        // Touch en modo absoluto: mover cursor remoto Y actualizar overlay local inmediatamente
        // (no esperar el roundtrip agent→cursor_pos → el cursor se ve instantáneo)
        const _touchMove = (t) => {
            const c = this._coordsTouch(t);
            this._sendInput({ MouseMove: c });
            this._cursorRx = c.rx;
            this._cursorRy = c.ry;
            this._updateCursor(c.rx, c.ry);
        };
        canvas.addEventListener('touchstart',  e => { e.preventDefault(); lastTouch = performance.now(); _touchMove(e.touches[0]); }, { passive: false });
        canvas.addEventListener('touchmove',   e => { e.preventDefault(); const now = performance.now(); if (now - lastTouch < 30) return; lastTouch = now; _touchMove(e.touches[0]); }, { passive: false });

        window.addEventListener('keydown', e => { if (!this.streaming) return; if (['F11','F5'].includes(e.key)) return; e.preventDefault(); this._sendInput({ KeyDown: { key_code: e.code } }); });
        window.addEventListener('keyup',   e => { if (!this.streaming) return; this._sendInput({ KeyUp:   { key_code: e.code } }); });
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

// ══════════════════════════════════════════════════════════════════════════════
//  FileExplorer — Explorador Dual-Pane Local ↔ Remoto
// ══════════════════════════════════════════════════════════════════════════════
class FileExplorer {
    constructor(client) {
        this.client        = client;
        this.localHandle   = null;   // FileSystemDirectoryHandle (File Access API)
        this.localPath     = '';
        this.localItems    = [];
        this.localSelected = new Set();
        this.localStack    = [];     // historial de navegación local

        this.remotePath    = '';
        this.remoteItems   = [];
        this.remoteSelected = new Set();
        this.remoteStack   = [];

        this._bindUI();
        // Pedir lista raíz del remoto al abrirse
        this._remoteList('drives');
    }

    // ── Visibilidad ──────────────────────────────────────────────────────────
    show()   { document.getElementById('file-manager').classList.remove('hidden'); }
    hide()   { document.getElementById('file-manager').classList.add('hidden'); }
    toggle() { document.getElementById('file-manager').classList.toggle('hidden'); if (!document.getElementById('file-manager').classList.contains('hidden')) this._remoteList(this.remotePath || 'drives'); }

    // ── Bind UI ──────────────────────────────────────────────────────────────
    _bindUI() {
        document.getElementById('fm-close-btn')?.addEventListener('click', () => this.hide());

        // LOCAL
        document.getElementById('fm-local-open')?.addEventListener('click',    () => this._openLocalDir());
        document.getElementById('fm-local-refresh')?.addEventListener('click', () => this._refreshLocal());
        document.getElementById('fm-local-home')?.addEventListener('click',    () => this._refreshLocal());
        document.getElementById('fm-local-up')?.addEventListener('click',      () => this._localUp());
        document.getElementById('fm-local-mkdir')?.addEventListener('click',   () => this._localMkdir());
        document.getElementById('fm-local-delete')?.addEventListener('click',  () => this._localDelete());

        // REMOTO
        document.getElementById('fm-remote-home')?.addEventListener('click',    () => this._remoteList('drives'));
        document.getElementById('fm-remote-up')?.addEventListener('click',      () => this._remoteUp());
        document.getElementById('fm-remote-refresh')?.addEventListener('click', () => this._remoteList(this.remotePath || 'drives'));
        document.getElementById('fm-remote-mkdir')?.addEventListener('click',   () => this._remoteMkdir());
        document.getElementById('fm-remote-delete')?.addEventListener('click',  () => this._remoteDelete());

        // TRANSFERENCIA
        document.getElementById('fm-btn-send')?.addEventListener('click', () => this._sendSelected());
        document.getElementById('fm-btn-recv')?.addEventListener('click', () => this._recvSelected());
    }

    // ── LOCAL: File System Access API ────────────────────────────────────────
    async _openLocalDir() {
        if (!window.showDirectoryPicker) {
            // fallback: input file
            const inp = document.createElement('input');
            inp.type = 'file'; inp.multiple = true;
            inp.onchange = () => { if (inp.files[0]) this._loadLocalFiles(Array.from(inp.files)); };
            inp.click(); return;
        }
        try {
            const h = await window.showDirectoryPicker({ mode: 'readwrite' });
            this.localHandle = h; this.localPath = h.name; this.localStack = [];
            await this._refreshLocal();
        } catch(e) { if (e.name !== 'AbortError') this.client.showToast('Error','No se pudo abrir la carpeta','❌',3000); }
    }

    _loadLocalFiles(files) {
        this.localItems = files.map(f => ({ name: f.name, isDir: false, size: f.size, date: new Date(f.lastModified).toLocaleString('es'), _file: f }));
        this.localPath = 'Archivos seleccionados';
        this._renderLocal();
    }

    async _refreshLocal() {
        if (!this.localHandle) return;
        this.localItems = [];
        try {
            for await (const [name, h] of this.localHandle.entries()) {
                if (h.kind === 'directory') {
                    this.localItems.push({ name, isDir: true, size: 0, date: '', _handle: h });
                } else {
                    const f = await h.getFile();
                    this.localItems.push({ name, isDir: false, size: f.size, date: new Date(f.lastModified).toLocaleString('es'), _handle: h, _file: f });
                }
            }
        } catch(e) {}
        this.localItems.sort((a,b) => (+b.isDir - +a.isDir) || a.name.localeCompare(b.name));
        this.localSelected.clear();
        this._renderLocal();
    }

    async _localEnter(item) {
        if (!item.isDir || !item._handle) return;
        this.localStack.push({ handle: this.localHandle, path: this.localPath });
        this.localHandle = item._handle; this.localPath = (this.localPath ? this.localPath + '\\' : '') + item.name;
        await this._refreshLocal();
    }

    async _localUp() {
        if (!this.localStack.length) return;
        const prev = this.localStack.pop();
        this.localHandle = prev.handle; this.localPath = prev.path;
        await this._refreshLocal();
    }

    async _localMkdir() {
        const name = prompt('Nombre de la nueva carpeta:');
        if (!name || !this.localHandle) return;
        try { await this.localHandle.getDirectoryHandle(name, { create: true }); await this._refreshLocal(); } catch(e) { alert('Error: ' + e.message); }
    }

    async _localDelete() {
        if (!this.localSelected.size) { alert('Selecciona al menos un archivo'); return; }
        if (!confirm('¿Eliminar ' + this.localSelected.size + ' elemento(s)?')) return;
        for (const name of this.localSelected) {
            try { await this.localHandle.removeEntry(name, { recursive: true }); } catch(e) {}
        }
        await this._refreshLocal();
    }

    // ── LOCAL: Render ────────────────────────────────────────────────────────
    _renderLocal() {
        const el = document.getElementById('fm-local-list');
        const pathEl = document.getElementById('fm-local-path');
        if (pathEl) pathEl.textContent = this.localPath || '—';
        if (!el) return;
        if (!this.localItems.length) {
            el.innerHTML = '<div class="fm-empty"><div class="fm-empty-icon">📂</div><span>Carpeta vacía</span></div>'; return;
        }
        el.innerHTML = this.localItems.map(item => {
            const sel = this.localSelected.has(item.name) ? ' selected' : '';
            const cls = item.isDir ? ' dir' : '';
            const ico = item.isDir ? '📁' : this._fileIcon(item.name);
            const sz  = item.isDir ? '—' : this._fmtSize(item.size);
            return `<div class="fm-row${cls}${sel}" data-name="${this._esc(item.name)}" data-dir="${item.isDir}">
                <div class="fm-row-name"><span class="fm-icon">${ico}</span><span class="fm-name-text">${this._esc(item.name)}</span></div>
                <div class="fm-row-date">${item.date || '—'}</div>
                <div class="fm-row-size">${sz}</div>
            </div>`;
        }).join('');
        el.querySelectorAll('.fm-row').forEach(row => {
            const name = row.dataset.name;
            const isDir = row.dataset.dir === 'true';
            row.addEventListener('click', (e) => {
                if (e.detail === 2) { // dblclick
                    if (isDir) { const item = this.localItems.find(i => i.name === name); if (item) this._localEnter(item); }
                } else {
                    this.localSelected.has(name) ? this.localSelected.delete(name) : this.localSelected.add(name);
                    row.classList.toggle('selected', this.localSelected.has(name));
                }
            });
        });
    }

    // ── REMOTO ───────────────────────────────────────────────────────────────
    _remoteList(path) {
        if (!this.client.ws || this.client.ws.readyState !== WebSocket.OPEN) return;
        const el = document.getElementById('fm-remote-list');
        if (el) el.innerHTML = '<div class="fm-empty"><div class="fm-empty-icon">🔄</div><span>Cargando...</span></div>';
        this.client.ws.send(JSON.stringify({ type: 'input', event: { FsList: { path: path || 'drives' } } }));
    }

    _onFsListRes(msg) {
        this.remotePath = msg.path || '';
        this.remoteItems = msg.items || [];
        this.remoteSelected.clear();
        this._renderRemote();
    }

    _remoteUp() {
        if (!this.remotePath || this.remotePath === 'drives') return;
        const parts = this.remotePath.replace(/[/\\]+$/, '').split(/[/\\]/);
        parts.pop();
        const parent = parts.join('\\') || 'drives';
        this._remoteList(parent);
    }

    _remoteMkdir() {
        const name = prompt('Nombre de la nueva carpeta remota:');
        if (!name || !this.remotePath || this.remotePath === 'drives') return;
        const path = this.remotePath.replace(/[/\\]$/, '') + '\\' + name;
        this.client.ws.send(JSON.stringify({ type: 'input', event: { FsMkdir: { path } } }));
        setTimeout(() => this._remoteList(this.remotePath), 800);
    }

    _remoteDelete() {
        if (!this.remoteSelected.size) { alert('Selecciona al menos un archivo remoto'); return; }
        if (!confirm('¿Eliminar ' + this.remoteSelected.size + ' elemento(s) en el equipo remoto?')) return;
        for (const name of this.remoteSelected) {
            const fullPath = (this.remotePath === 'drives') ? name : this.remotePath.replace(/[/\\]$/, '') + '\\' + name;
            this.client.ws.send(JSON.stringify({ type: 'input', event: { FsDelete: { path: fullPath } } }));
        }
        setTimeout(() => this._remoteList(this.remotePath), 800);
    }

    // ── REMOTO: Render ───────────────────────────────────────────────────────
    _renderRemote() {
        const el = document.getElementById('fm-remote-list');
        const pathEl = document.getElementById('fm-remote-path');
        if (pathEl) pathEl.textContent = this.remotePath || '—';
        if (!el) return;
        if (!this.remoteItems.length) {
            el.innerHTML = '<div class="fm-empty"><div class="fm-empty-icon">📂</div><span>Carpeta vacía</span></div>'; return;
        }
        el.innerHTML = this.remoteItems.map(item => {
            const sel = this.remoteSelected.has(item.name) ? ' selected' : '';
            const cls = item.isDir ? ' dir' : '';
            const ico = item.isDir ? '📁' : this._fileIcon(item.name);
            const sz  = item.isDir ? '—' : this._fmtSize(item.size);
            return `<div class="fm-row${cls}${sel}" data-name="${this._esc(item.name)}" data-dir="${item.isDir}">
                <div class="fm-row-name"><span class="fm-icon">${ico}</span><span class="fm-name-text">${this._esc(item.name)}</span></div>
                <div class="fm-row-date">${item.date || '—'}</div>
                <div class="fm-row-size">${sz}</div>
            </div>`;
        }).join('');
        el.querySelectorAll('.fm-row').forEach(row => {
            const name = row.dataset.name;
            const isDir = row.dataset.dir === 'true';
            row.addEventListener('click', (e) => {
                if (e.detail === 2) {
                    if (isDir) {
                        const path = this.remotePath === 'drives' ? name : this.remotePath.replace(/[/\\]$/, '') + '\\' + name;
                        this._remoteList(path);
                    }
                } else {
                    this.remoteSelected.has(name) ? this.remoteSelected.delete(name) : this.remoteSelected.add(name);
                    row.classList.toggle('selected', this.remoteSelected.has(name));
                }
            });
        });
    }

    // ── TRANSFERENCIA: Local → Remoto ────────────────────────────────────────
    async _sendSelected() {
        if (!this.localSelected.size) { alert('Selecciona archivo(s) locales primero'); return; }
        for (const name of this.localSelected) {
            const item = this.localItems.find(i => i.name === name);
            if (!item || item.isDir) continue;
            let file = item._file;
            if (!file && item._handle) { file = await item._handle.getFile(); }
            if (!file) continue;
            this._queueTransfer(file, 'send');
        }
    }

    _queueTransfer(file, dir) {
        const tid  = 'tx-' + Date.now() + '-' + Math.random().toString(36).slice(2);
        const card = this._addTransferCard(tid, file.name, dir);
        const reader = new FileReader();
        reader.onload = (e) => {
            const b64  = e.target.result.split(',')[1] || e.target.result;
            const CHUNK = 12000;
            const total = Math.ceil(b64.length / CHUNK);
            const start = performance.now();
            let i = 0, sent = 0;
            const next = () => {
                if (i >= total) {
                    this._updateCard(tid, 100, '✓ Enviado', 'done');
                    const destLabel = (this.remotePath && this.remotePath !== 'drives') ? this.remotePath : 'Descargas';
                    this.client.showToast('📁 Enviado', file.name + ' → ' + destLabel, '✅', 4000);
                    setTimeout(() => this._remoteList(this.remotePath), 1200);
                    return;
                }
                if (!this.client.streaming) { this._updateCard(tid, 0, '❌ Sin conexión', 'error'); return; }
                const chunk = b64.slice(i * CHUNK, (i+1) * CHUNK);
                const targetDir = (this.remotePath && this.remotePath !== 'drives') ? this.remotePath : null;
                this.client.ws.send(JSON.stringify({ type: 'input', event: { FileChunk: { name: file.name, idx: i, total, b64: chunk, targetDir } } }));
                sent += chunk.length;
                const pct = Math.round((i+1)/total*100);
                const sec = (performance.now()-start)/1000;
                const spd = sec > 0 ? ((sent*.75)/(1024*1024)/sec).toFixed(1) : '0.0';
                this._updateCard(tid, pct, pct + '% · ' + spd + ' MB/s');
                i++;
                setTimeout(next, 6);
            };
            next();
        };
        reader.readAsDataURL(file);
    }

    // ── TRANSFERENCIA: Remoto → Local (download) ─────────────────────────────
    _recvSelected() {
        if (!this.remoteSelected.size) { alert('Selecciona archivo(s) remotos primero'); return; }
        for (const name of this.remoteSelected) {
            const item = this.remoteItems.find(i => i.name === name);
            if (!item || item.isDir) continue;
            const fullPath = this.remotePath === 'drives' ? name : this.remotePath.replace(/[/\\]$/, '') + '\\' + name;
            const tid = 'rx-' + Date.now();
            this._addTransferCard(tid, name, 'recv');
            this._pendingRecv = this._pendingRecv || {};
            this._pendingRecv[name] = { tid, chunks: [], total: 0, received: 0, startMs: performance.now() };
            this.client.ws.send(JSON.stringify({ type: 'input', event: { FsDownload: { path: fullPath } } }));
        }
    }

    // Llamado cuando llega file_download_chunk desde el agente
    _onDownloadChunk(msg) {
        if (!this._pendingRecv) this._pendingRecv = {};
        const state = this._pendingRecv[msg.name];
        if (!state) return;
        state.chunks[msg.idx] = msg.b64;
        state.total = msg.total;
        state.received = (state.received || 0) + 1;
        const pct = Math.round(state.received / msg.total * 100);
        const elapsed = (performance.now() - state.startMs) / 1000;
        const approxBytes = state.received * 12000 * 0.75;
        const spd = elapsed > 0.1 ? (approxBytes / (1024 * 1024) / elapsed).toFixed(1) + ' MB/s' : '';
        this._updateCard(state.tid, pct, pct + '% ' + spd);
        if (state.received >= msg.total) {
            try {
                // Reconstuir en orden por índice
                let b64full = '';
                for (let i = 0; i < msg.total; i++) b64full += (state.chunks[i] || '');
                const binary = atob(b64full);
                const bytes  = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                const blob = new Blob([bytes]);
                const url  = URL.createObjectURL(blob);
                const a    = document.createElement('a');
                a.href = url; a.download = msg.name; a.click();
                setTimeout(() => URL.revokeObjectURL(url), 3000);
                this._updateCard(state.tid, 100, '✓ Descargado (' + this._fmtSize(bytes.length) + ')', 'done');
                this.client.showToast('📥 Descargado', msg.name + ' ← PC remota', '✅', 4000);
            } catch(e) {
                this._updateCard(state.tid, 0, '❌ Error al reconstruir', 'error');
            }
            delete this._pendingRecv[msg.name];
        }
    }

    // ── Queue UI ─────────────────────────────────────────────────────────────
    _addTransferCard(tid, name, dir) {
        const list = document.getElementById('fm-queue-list');
        if (!list) return;
        list.querySelector('.fm-queue-empty')?.remove();
        const arrow = dir === 'send' ? '→' : '←';
        const card  = document.createElement('div');
        card.className = 'fm-transfer-item'; card.id = tid;
        card.innerHTML = `<div class="fm-ti-name">${arrow} ${this._esc(name)}</div>
            <div class="fm-ti-bar-wrap"><div class="fm-ti-bar" style="width:0%"></div></div>
            <div class="fm-ti-status">Preparando...</div>`;
        list.appendChild(card);
        return card;
    }

    _updateCard(tid, pct, text, cls) {
        const card = document.getElementById(tid);
        if (!card) return;
        const bar  = card.querySelector('.fm-ti-bar');
        const stat = card.querySelector('.fm-ti-status');
        if (bar)  bar.style.width = pct + '%';
        if (stat) { stat.textContent = text; stat.className = 'fm-ti-status' + (cls ? ' '+cls : ''); }
    }

    // ── Utils ────────────────────────────────────────────────────────────────
    _fmtSize(b) {
        if (!b) return '0 B';
        if (b < 1024) return b + ' B';
        if (b < 1048576) return (b/1024).toFixed(1) + ' KB';
        if (b < 1073741824) return (b/1048576).toFixed(1) + ' MB';
        return (b/1073741824).toFixed(2) + ' GB';
    }

    _fileIcon(name) {
        const ext = (name.split('.').pop() || '').toLowerCase();
        const map = { jpg:'🖼', jpeg:'🖼', png:'🖼', gif:'🖼', bmp:'🖼', webp:'🖼', svg:'🖼',
            mp4:'🎬', mkv:'🎬', avi:'🎬', mov:'🎬', mp3:'🎵', wav:'🎵', ogg:'🎵', flac:'🎵',
            pdf:'📄', doc:'📝', docx:'📝', xls:'📊', xlsx:'📊', ppt:'📊', pptx:'📊',
            zip:'🗜', rar:'🗜', '7z':'🗜', tar:'🗜', gz:'🗜',
            exe:'⚙', dll:'⚙', bat:'⚙', cmd:'⚙', ps1:'⚙', sh:'⚙',
            txt:'📃', log:'📃', csv:'📃', json:'📃', xml:'📃', html:'🌐', css:'🎨', js:'📜' };
        return map[ext] || '📄';
    }

    _esc(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
}

window.addEventListener('DOMContentLoaded', () => { window.apexClient = new ApexRemote(); });