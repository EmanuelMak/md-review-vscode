// Baut dev/index.html (Browser-Harness) aus einer Markdown-Datei: node dev/build-harness.mjs [datei.md]
import { readFileSync, writeFileSync } from 'node:fs';

const src = process.argv[2] ?? new URL('../test/fixtures/beispiel.md', import.meta.url);
const md = readFileSync(src, 'utf8');
const html = `<!DOCTYPE html><html lang="de"><head><meta charset="utf-8"><title>MD Review Harness</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="../media/style.css">
<style>#src{position:fixed;right:0;bottom:0;width:45vw;height:30vh;overflow:auto;background:#111;color:#ddd;font-size:11px;margin:0;padding:6px;z-index:100;white-space:pre-wrap;opacity:.92}</style>
</head><body class="vscode-light"><div id="app"></div><pre id="src"></pre>
<script>window.__initialText = ${JSON.stringify(md).replace(/<\//g, '<\\/')};</script>
<script src="harness.js"></script><script src="../media/main.js"></script></body></html>`;
writeFileSync(new URL('./index.html', import.meta.url), html);
console.log('dev/index.html gebaut aus', String(src));
