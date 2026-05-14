# Cognitive Training 2026-05 Games

Static GitHub Pages deployment for 13 cognitive training games:

- Public page: <https://xyjk0511.github.io/cognitive-training-2026-05-games/>
- Local entry: open `index.html`
- Launcher grouping: `01 感知觉`, `02 记忆力`, `03 注意力`, `04 执行能力`, `05 社会认知`

This deployment repository contains only runnable static game files, shared assets, and a browser smoke script. The full design-parity verifier remains in the source workspace because it depends on local design-package workbooks and documents.

Smoke verification:

```powershell
$env:NODE_PATH='C:\Users\55093\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules'; node .\tools\smoke-games.mjs
```
