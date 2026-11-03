import * as esbuild from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  logLevel: 'info',
};

// pdf.js für die PDF-Anzeige (media/pdf.js lädt es als ES-Modul aus dist/pdfjs)
const pdfjs = 'node_modules/pdfjs-dist';
mkdirSync('dist/pdfjs', { recursive: true });
cpSync(`${pdfjs}/build/pdf.min.mjs`, 'dist/pdfjs/pdf.min.mjs');
cpSync(`${pdfjs}/build/pdf.worker.min.mjs`, 'dist/pdfjs/pdf.worker.min.mjs');
cpSync(`${pdfjs}/LICENSE`, 'dist/pdfjs/LICENSE');
for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) cpSync(`${pdfjs}/${dir}`, `dist/pdfjs/${dir}`, { recursive: true });

if (watch) await (await esbuild.context(options)).watch();
else await esbuild.build(options);
