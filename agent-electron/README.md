# ApexRemote — Agente Electron

## Instalación

```bash
cd agent-electron
npm install          # instala dependencias + compila robotjs para Electron
```

Si falla la compilación de robotjs:
```bash
npm install --global windows-build-tools   # solo una vez, como admin
npm run rebuild
```

## Desarrollo
```bash
npm start
```

## Distribución (exe)
```bash
npm run build            # genera installer NSIS + portable exe en dist/
```

El installer se genera en `dist/ApexRemote Agent Setup 1.0.0.exe`

## Variables de entorno opcionales
- `APEX_RELAY` — URL del relay (default: apex-remote.onrender.com)
- `APEX_ID`    — ID fijo (default: aleatorio)
- `APEX_PIN`   — PIN fijo (default: aleatorio)
