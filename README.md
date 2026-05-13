# Cognitive Training 2026-05 Games

Static GitHub Pages deployment for eleven cognitive training games.

Open `index.html` to choose a game.

This deployment repository contains only runnable static game files, shared assets, and a browser smoke script. The full design-parity verifier remains in the source workspace because it depends on local design-package workbooks and documents.

Smoke verification:

```powershell
$env:NODE_PATH='C:\Users\55093\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules'; node .\tools\smoke-games.mjs
```
