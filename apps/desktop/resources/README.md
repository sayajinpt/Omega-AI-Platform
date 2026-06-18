# App icons

- `icon.png` — round Ω icon (1024×1024). Used for the native Windows installer shortcuts and packaged UI (`dist/native/Omega/ui/icon.png`).

Generate or refresh:

```bat
node ../../scripts/ensure-app-icon.mjs
```

On Windows this runs `scripts/ensure-app-icon.ps1` (System.Drawing). The native build pipeline copies this icon into the packaged app.
