'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    // Main → Renderer
    onInit:          (cb) => ipcRenderer.on('init',            (_, d) => cb(d)),
    onStatus:        (cb) => ipcRenderer.on('status',          (_, s) => cb(s)),
    onStats:         (cb) => ipcRenderer.on('stats',           (_, s) => cb(s)),
    onFileReceived:  (cb) => ipcRenderer.on('file-received',   (_, d) => cb(d)),
    onStartCapture:  (cb) => ipcRenderer.on('start-capture',   (_, q) => cb(q)),
    onStopCapture:   (cb) => ipcRenderer.on('stop-capture',    (_)    => cb()),
    onQualityChange: (cb) => ipcRenderer.on('quality-changed', (_, q) => cb(q)),

    // Renderer → Main
    minimize:   () => ipcRenderer.send('window-minimize'),
    close:      () => ipcRenderer.send('window-close'),
    setQuality: (q) => ipcRenderer.send('set-quality', q),

    // Captura: renderer obtiene fuente y envía frames binarios
    getSources: ()    => ipcRenderer.invoke('get-sources'),
    sendFrame:  (buf) => ipcRenderer.send('frame', buf),
});
