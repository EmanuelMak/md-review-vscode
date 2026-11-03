// PDF → Markdown. Die eigentliche Umwandlung macht ein externes Programm (marker, docling oder pymupdf4llm),
// das in einen temporären Ordner schreibt. Danach räumen wir das Markdown auf (Seitenmarken, Formeln, Bildlinks),
// legen die Abbildungen in <name>.assets/ neben die .md und öffnen sie im Review-Editor.
// Dazu kommt eine schlichte PDF-Anzeige (pdf.js, media/pdf.js) mit dem Knopf „In Markdown umwandeln“.

import * as vscode from 'vscode';
import { ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { scanMarkers } from './criticmarkup';
import { findTool } from './dictation';
import { log } from './provider';

export type PdfEngine = 'marker' | 'docling' | 'pymupdf4llm' | 'custom';
export type MathMode = 'code' | 'dollar';

export interface PdfSettings {
  engine: PdfEngine;
  toolPath: string;
  customCommand: string;
  extraArgs: string[];
  math: MathMode;
  pageMarkers: boolean;
}

// ------------------------------------------------------------ reine Hilfsfunktionen

/** Zielpfade neben der PDF. `n` > 1 ergibt „Name-2.md“ usw. */
export function outputPaths(pdfPath: string, n = 1): { md: string; assets: string; assetsName: string } {
  const dir = path.dirname(pdfPath);
  const base = path.basename(pdfPath).replace(/\.pdf$/i, '') + (n > 1 ? `-${n}` : '');
  return { md: path.join(dir, base + '.md'), assets: path.join(dir, base + '.assets'), assetsName: base + '.assets' };
}

/** Erste Nummer, bei der weder .md noch .assets existieren. */
export function freeVariant(pdfPath: string, exists: (p: string) => boolean): number {
  for (let n = 2; ; n++) {
    const p = outputPaths(pdfPath, n);
    if (!exists(p.md) && !exists(p.assets)) return n;
  }
}

/** Programmnamen, nach denen gesucht wird. */
export function toolNames(engine: PdfEngine): string[] {
  switch (engine) {
    case 'marker':
      return ['marker_single'];
    case 'docling':
      return ['docling'];
    case 'pymupdf4llm':
      return ['python3', 'python'];
    case 'custom':
      return [];
  }
}

/** Python-Schnipsel für pymupdf4llm (hat kein eigenes Kommandozeilenprogramm). argv: pdf, ausgabeordner */
export const PYMUPDF_SCRIPT = [
  'import sys, pathlib, pymupdf4llm',
  'pdf, out = sys.argv[1], pathlib.Path(sys.argv[2])',
  'img = out / "images"; img.mkdir(parents=True, exist_ok=True)',
  'md = pymupdf4llm.to_markdown(pdf, write_images=True, image_path=str(img), image_format="png", dpi=200, page_separators=True, show_progress=True)',
  '(out / (pathlib.Path(pdf).stem + ".md")).write_text(md, encoding="utf-8")',
].join('\n');

/** Zerlegt eine Kommandozeile in Argumente (einfache und doppelte Anführungszeichen). */
export function splitArgs(s: string): string[] {
  const out: string[] = [];
  const re = /"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g;
  for (let m; (m = re.exec(s)); ) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : (m[2] ?? m[3]));
  return out;
}

/** Aufruf des Umwandlers. `bin`: gefundenes Programm (bei custom unbenutzt). */
export function engineCommand(s: PdfSettings, bin: string, input: string, outDir: string): { cmd: string; args: string[] } {
  switch (s.engine) {
    case 'marker':
      return { cmd: bin, args: [input, '--output_dir', outDir, '--output_format', 'markdown', ...(s.pageMarkers ? ['--paginate_output'] : []), ...s.extraArgs] };
    case 'docling':
      return { cmd: bin, args: [input, '--to', 'md', '--image-export-mode', 'referenced', '--output', outDir, ...s.extraArgs] };
    case 'pymupdf4llm':
      return { cmd: bin, args: ['-c', PYMUPDF_SCRIPT, input, outDir, ...s.extraArgs] };
    case 'custom': {
      const parts = splitArgs(s.customCommand).map((a) => a.replace(/\{input\}/g, input).replace(/\{output\}/g, outDir));
      return { cmd: parts[0] ?? '', args: [...parts.slice(1), ...s.extraArgs] };
    }
  }
}

/** Hinweis, wenn der Umwandler fehlt. `command`: was man im Terminal ausführen kann. */
export function installHint(engine: PdfEngine, platform: NodeJS.Platform): { text: string; command?: string } {
  if (engine === 'custom') return { text: 'Für die PDF-Umwandlung ist kein Befehl eingestellt (mdReview.pdf.customCommand).' };
  const pkg = { marker: 'marker-pdf', docling: 'docling', pymupdf4llm: 'pymupdf4llm' }[engine];
  const label = { marker: 'marker (marker_single)', docling: 'docling', pymupdf4llm: 'pymupdf4llm' }[engine];
  const what = `Für die PDF-Umwandlung fehlt ${label}.`;
  // uv installiert Python-Programme in eine eigene Umgebung (~/.local/bin), passende Python-Version inklusive
  if (engine === 'pymupdf4llm') {
    const cmd = platform === 'win32' ? 'py -m pip install --user pymupdf4llm' : 'python3 -m pip install --user pymupdf4llm';
    return { text: `${what} Installieren mit: ${cmd} (oder mdReview.pdf.toolPath auf ein Python mit pymupdf4llm setzen)`, command: cmd };
  }
  const uv = `uv tool install --python 3.12 ${pkg}`;
  if (platform === 'darwin') {
    const cmd = `brew install uv && ${uv}`;
    return { text: `${what} Installieren mit: ${cmd} (lädt beim ersten Umwandeln noch die Modelle, ca. 1–3 GB)`, command: cmd };
  }
  if (platform === 'win32') {
    const cmd = `winget install --id astral-sh.uv -e; uv tool install --python 3.12 ${pkg}`;
    return { text: `${what} Installieren mit: ${cmd} (danach VS Code neu starten)`, command: cmd };
  }
  const cmd = `curl -LsSf https://astral.sh/uv/install.sh | sh && ${uv}`;
  return { text: `${what} Installieren mit: ${cmd}`, command: cmd };
}

/**
 * Fortschritt aus einer Ausgabezeile. tqdm (marker, docling): „Recognizing Layout:  40%|████  | 2/5 [00:03<00:04]“,
 * pymupdf4llm: „[=====      ] ( 2/16)“.
 */
export function parseProgress(line: string): { label: string; percent: number } | undefined {
  const s = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim();
  const m = /^(.*?):?\s*(\d{1,3})%\|.*?\|\s*(\d+)\/(\d+)/.exec(s);
  if (m) return { label: `${m[1].trim() || 'Seiten'} ${m[3]}/${m[4]}`, percent: Number(m[2]) };
  const p = /\[[= ]*\]\s*\(\s*(\d+)\/(\d+)\)\s*$/.exec(s);
  if (p && Number(p[2]) > 0) return { label: `Seiten ${p[1]}/${p[2]}`, percent: Math.round((100 * Number(p[1])) / Number(p[2])) };
  return undefined;
}

/** Zieht einen relativen Link für Markdown zurecht (Leerzeichen, Klammern, Umlaute). */
export function mdLink(rel: string): string {
  return rel
    .split('/')
    .map((seg) => encodeURIComponent(seg).replace(/\(/g, '%28').replace(/\)/g, '%29'))
    .join('/');
}

/** Bildlinks im Markdown: ![alt](src) und <img src="…">. */
export function imageRefs(md: string): string[] {
  const out = new Set<string>();
  for (const m of md.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) out.add(m[1]);
  for (const m of md.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)) out.add(m[1]);
  return [...out].filter((s) => /^[a-z]:[\\/]/i.test(s) || !/^[a-z][a-z0-9+.-]*:/i.test(s));
}

/** Neuer Name für eine Abbildung: Seitenzahl aus den üblichen Dateinamen der Umwandler, sonst fortlaufend. */
export function figureName(src: string, index: number): string {
  const file = decodeURIComponent(src.split('/').pop() ?? src);
  const ext = (path.extname(file) || '.png').toLowerCase().replace('.jpeg', '.jpg');
  // marker: _page_3_Figure_1.jpeg (Seite ab 0) · pymupdf4llm: name.pdf-0004-01.png (Seite ab 1)
  const mk = /_page_(\d+)_(\w+?)_(\d+)\.\w+$/i.exec(file);
  if (mk) return `p${Number(mk[1]) + 1}-${mk[2].toLowerCase()}-${Number(mk[3]) + 1}${ext}`;
  const pm = /-(\d{4})-(\d{2,})\.\w+$/.exec(file);
  if (pm) return `p${Number(pm[1])}-bild-${Number(pm[2]) + 1}${ext}`;
  return `bild-${index + 1}${ext}`;
}

export interface PostOptions {
  /** alter Bildpfad (wie im Markdown) → neuer relativer Pfad */
  images: Map<string, string>;
  math: MathMode;
  pageMarkers: boolean;
}

/**
 * Räumt die Ausgabe der Umwandler auf, damit sie im Review-Editor gut lesbar und bearbeitbar ist:
 * Seitenmarken → <!-- page N -->, interne Links weg, Überschriftenebenen aus der Nummerierung,
 * über Seitengrenzen getrennte Absätze zusammen, Formeln je nach Einstellung als Code, Bildlinks auf <name>.assets/.
 */
export function postprocess(md: string, o: PostOptions): string {
  let s = md.replace(/\r\n?/g, '\n');

  // Seitentrenner: marker „{3}------…“ (Seite ab 0, steht am Seitenanfang),
  // pymupdf4llm „--- end of page.page_number=3 ---“ (ab 1, steht am Seitenende)
  const page = (n: number) => (o.pageMarkers ? `\n${PAGE(n)}\n` : '\n');
  s = s.replace(/^\{(\d+)\}-{20,}[ \t]*$/gm, (_, n) => page(Number(n) + 1));
  if (/^-{3,} end of page\.page_number=\d+ -{3,}[ \t]*$/m.test(s)) {
    s = s.replace(/^-{3,} end of page\.page_number=(\d+) -{3,}[ \t]*$/gm, (_, n) => page(Number(n) + 1));
    s = s.replace(/\n<!-- page \d+ -->\s*$/, '\n');
    if (o.pageMarkers) s = `${PAGE(1)}\n\n` + s;
  }

  // marker: Anker (<span id="page-3-1"></span>) und Links auf sie, z. B. Zitate „[\(Peters et al.,](#page-10-0)“
  s = s.replace(/<span id="[^"]*"><\/span>/g, '');
  s = s.replace(/\[((?:\\.|[^\]\\])*)\]\(#[^)\s]*\)/g, (_, text: string) => text.replace(/\\([()[\]])/g, '$1'));
  // docling: Platzhalter für nicht exportierte Bilder und Formeln
  s = s.replace(/^<!-- image -->$/gm, '');
  s = s.replace(/^<!-- formula-not-decoded -->$/gm, '*[Formel – siehe PDF]*');

  s = replaceImages(s, o.images);
  s = formulaTables(s);
  s = convertMath(s, o.math);
  s = fixHeadings(s);
  // Leerzeichen am Zeilenende (würden als harter Umbruch gelesen) und zu viele Leerzeilen
  s = s.replace(/[ \t]+$/gm, '');
  s = s.replace(/\n{3,}/g, '\n\n');
  s = joinSplitParagraphs(s);
  return s.trim() + '\n';
}

const PAGE = (n: number) => `<!-- page ${n} -->`;

const isSeparatorRow = (l: string) => /^\|(\s*:?-{3,}:?\s*\|)+\s*$/.test(l);

/** Zellen einer Tabellenzeile („| a | b |“); \| bleibt in der Zelle. */
function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim());
}

/**
 * marker setzt abgesetzte Formeln als Tabelle „| $…$ | (1) |“, oft mit doppelter Trennzeile. Daraus wird eine
 * Blockformel $$…\tag{1}$$ (convertMath macht daraus je nach Einstellung einen ```math-Block).
 * Doppelte Trennzeilen in echten Tabellen werden entfernt.
 */
export function formulaTables(s: string): string {
  const lines = s.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; ) {
    if (!lines[i].startsWith('|')) {
      out.push(lines[i++]);
      continue;
    }
    let j = i;
    while (j < lines.length && lines[j].startsWith('|')) j++;
    const block = lines.slice(i, j).filter((l, k, a) => !(isSeparatorRow(l) && k > 0 && isSeparatorRow(a[k - 1])));
    const rows = block.filter((l) => !isSeparatorRow(l)).map(cells);
    const formula =
      rows.length > 0 &&
      rows.length <= 8 &&
      rows.every((r) => r.length <= 2 && r[0].includes('$') && (r.length === 1 || /^(\(\s*\d+[a-z]?\s*\)|\d+[a-z]?)?$/.test(r[1])));
    if (formula) {
      for (const r of rows) {
        const tex = r[0].replace(/\$\$?/g, ' ').replace(/\s+/g, ' ').trim();
        const tag = r[1]?.replace(/[()\s]/g, '');
        out.push('', '$$', tex + (tag ? ` \\tag{${tag}}` : ''), '$$', '');
      }
    } else out.push(...block);
    i = j;
  }
  return out.join('\n');
}

/**
 * Überschriften: Fettdruck raus („## **1 Introduction**“), falsch erkannte Aufzählungen („## • Batch size“)
 * zurück in Listen, und bei nummerierten Abschnitten die Ebene aus der Nummer („2.1 …“ → ###).
 * Der Titel (erste Überschrift) wird #, alles andere beginnt bei ##.
 */
export function fixHeadings(s: string): string {
  const lines = s.split('\n');
  const re = /^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
  const num = /^(?:(?:\d+|[A-Z])(?:\.\d+)*\.?)[ \t]+\S/;
  let inFence = false;
  const heads: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^(```|~~~)/.test(lines[i])) inFence = !inFence;
    if (!inFence && re.test(lines[i])) heads.push(i);
  }
  const numbered = heads.filter((i) => num.test(stripBold(re.exec(lines[i])![2]))).length;
  heads.forEach((i, k) => {
    let text = stripBold(re.exec(lines[i])![2]);
    const bullet = /^[•·▪◦‣-][ \t]*(.*)$/.exec(text);
    if (bullet) {
      lines[i] = `- ${bullet[1]}`;
      return;
    }
    let level = Math.max(2, re.exec(lines[i])![1].length);
    if (k === 0 && !num.test(text)) level = 1;
    else if (numbered >= 3) {
      const m = /^((?:\d+|[A-Z])(?:\.\d+)*)\.?[ \t]/.exec(text);
      // nur echte Abschnittsnummern (keine Jahreszahlen o. Ä.)
      if (m && m[1].split('.').every((p) => p.length <= 2)) level = Math.min(6, 1 + m[1].split('.').length);
      else if (level > 2 && /^(abstract|references|bibliography|literatur(verzeichnis)?|acknowledge?ments?|danksagung|appendix|anhang|zusammenfassung|inhaltsverzeichnis|contents)\b/i.test(text)) level = 2;
    }
    lines[i] = `${'#'.repeat(level)} ${text}`;
  });
  return lines.join('\n');
}

const stripBold = (t: string) => t.replace(/^\*\*(.+)\*\*$/, '$1').replace(/^__(.+)__$/, '$1').trim();

/**
 * Ein Absatz, der mitten im Satz abbricht, geht nach einer Seitengrenze oder einer dazwischengesetzten Abbildung,
 * Tabelle oder Bildunterschrift weiter (typisch im Zweispaltensatz). Dann die beiden Teile zusammenfügen und
 * das Dazwischenliegende dahinter setzen, damit der Absatz im Editor ein Absatz bleibt.
 */
export function joinSplitParagraphs(s: string): string {
  const blocks = splitBlocks(s);
  const isText = (b: string) => !/^(#|\||- |\* |\+ |\d+\. |>|```|~~~|\$\$|<|!\[|\{)/.test(b) && !isCaption(b);
  for (let i = 0; i < blocks.length; i++) {
    const before = blocks[i];
    if (!isText(before) || !/[A-Za-zÀ-ÿ0-9,;\-–]$/.test(before)) continue;
    let j = i + 1;
    while (j < blocks.length && j - i <= 6 && isFloat(blocks[j])) j++;
    if (j === i + 1 && !(j < blocks.length && /^<!-- page \d+ -->$/.test(blocks[j]))) {
      // direkt aufeinanderfolgende Absätze nur über eine Seitenmarke hinweg (sonst hat der Umwandler wohl recht)
      continue;
    }
    const after = blocks[j];
    if (after === undefined || !isText(after)) continue;
    // klein weiter („masked | word“) oder, bei einem langen Absatz ohne Satzende, auch groß (deutsche Substantive)
    if (!/^[a-zà-ÿ(]/.test(after) && !(before.length > 80 && /[a-zà-ÿ,;]$/.test(before))) continue;
    // Trennstrich am Ende bleibt stehen („pre-training“ wäre ohne ihn falsch, „Pro-gramm“ ist nur unschön)
    const joined = /-$/.test(before) ? before + after : `${before} ${after}`;
    blocks.splice(i, j - i + 1, joined, ...blocks.slice(i + 1, j));
    i--; // der zusammengefügte Absatz kann noch einmal weitergehen
  }
  return blocks.join('\n\n');
}

const isCaption = (b: string) => /^(\*\*|\*|_)?(Figure|Fig\.|Table|Tab\.|Abbildung|Abb\.|Tabelle)\s*\d+[.:]/i.test(b);
const isFloat = (b: string) => /^<!-- page \d+ -->$/.test(b) || /^!\[[^\]]*\]\([^)]*\)$/.test(b) || b.startsWith('|') || isCaption(b);

/** Teilt an Leerzeilen, Codeblöcke bleiben ganz. */
function splitBlocks(s: string): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let fence = '';
  for (const line of s.split('\n')) {
    const f = /^(```|~~~)/.exec(line)?.[1];
    if (f && (!fence || fence === f)) fence = fence ? '' : f;
    if (!fence && !f && line.trim() === '') {
      if (cur.length) out.push(cur.join('\n'));
      cur = [];
    } else cur.push(line);
  }
  if (cur.length) out.push(cur.join('\n'));
  return out;
}

function replaceImages(s: string, images: Map<string, string>): string {
  if (!images.size) return s;
  s = s.replace(/!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?((?:\s+"[^"]*")?)\s*\)/g, (all, alt, src, title) => {
    const n = images.get(src);
    return n ? `![${alt}](${mdLink(n)}${title})` : all;
  });
  return s.replace(/(<img\b[^>]*\bsrc=")([^"]+)(")/g, (all, a, src, b) => {
    const n = images.get(src);
    return n ? a + mdLink(n) + b : all;
  });
}

/**
 * Formeln. markdown-it kennt kein LaTeX; `_` und `*` darin würden als Hervorhebung gelesen und die Formel
 * zerstören. `code`: $$…$$ → ```math-Block, $…$ → `$…$` (unteilbar im Review-Editor, GitHub zeigt ```math
 * gerendert an). `dollar`: unverändert lassen.
 */
export function convertMath(s: string, mode: MathMode): string {
  if (mode === 'dollar') return s;
  const parts = splitCode(s);
  return parts
    .map((p) => {
      if (p.code) return p.text;
      let t = p.text;
      // Blockformeln: $$…$$ (auch mehrzeilig) und \[…\]
      t = t.replace(/(^|\n)[ \t]*\$\$([\s\S]+?)\$\$[ \t]*(?=\n|$)/g, (_, pre, body) => `${pre}\n\`\`\`math\n${body.trim()}\n\`\`\`\n`);
      t = t.replace(/(^|\n)[ \t]*\\\[([\s\S]+?)\\\][ \t]*(?=\n|$)/g, (_, pre, body) => `${pre}\n\`\`\`math\n${body.trim()}\n\`\`\`\n`);
      // Blockformel mitten im Absatz
      t = t.replace(/\$\$([^$]+?)\$\$/g, (_, body) => inlineCode(`$$${body.trim()}$$`));
      // Inline: $…$ (kein Leerzeichen innen am Rand, keine Geldbeträge wie „$5 und $6“)
      t = t.replace(/(^|[^\\$`\w])\$(?=\S)((?:\\.|[^$\n\\])+?)(?<=\S)\$(?![\w$])/g, (all, pre, body) =>
        /^\d+([.,]\d+)?$/.test(body) ? all : pre + inlineCode(`$${body}$`),
      );
      return t;
    })
    .join('');
}

function inlineCode(s: string): string {
  const ticks = s.includes('`') ? '``' : '`';
  const pad = s.startsWith('`') || s.endsWith('`') ? ' ' : '';
  return ticks + pad + s + pad + ticks;
}

/** Teilt Markdown in Code (Fences, Inline-Code) und übrigen Text, damit Formel-Regeln Code nicht anfassen. */
function splitCode(s: string): { text: string; code: boolean }[] {
  const out: { text: string; code: boolean }[] = [];
  const re = /(^|\n)(```|~~~)[^\n]*\n[\s\S]*?\n\2[ \t]*(?=\n|$)|`+[^`\n]*?`+/g;
  let pos = 0;
  for (let m; (m = re.exec(s)); ) {
    const start = m.index + (m[1]?.length ?? 0);
    if (start > pos) out.push({ text: s.slice(pos, start), code: false });
    out.push({ text: s.slice(start, re.lastIndex), code: true });
    pos = re.lastIndex;
  }
  if (pos < s.length) out.push({ text: s.slice(pos), code: false });
  return out;
}

/** Sucht die Markdown-Datei in der Ausgabe (marker legt einen Unterordner an). */
export function pickMarkdown(files: string[], stem: string): string | undefined {
  const md = files.filter((f) => /\.md$/i.test(f));
  return md.find((f) => path.basename(f, path.extname(f)) === stem) ?? md.sort((a, b) => a.length - b.length)[0];
}

// ------------------------------------------------------------ VS Code

export function readSettings(): PdfSettings {
  const c = vscode.workspace.getConfiguration('mdReview.pdf');
  return {
    engine: c.get<PdfEngine>('engine') ?? 'marker',
    toolPath: c.get<string>('toolPath') ?? '',
    customCommand: c.get<string>('customCommand') ?? '',
    extraArgs: c.get<string[]>('extraArgs') ?? [],
    math: c.get<MathMode>('math') ?? 'code',
    pageMarkers: c.get<boolean>('pageMarkers') ?? true,
  };
}

/** PATH plus ~/.local/bin (uv/pipx installieren dorthin; VS Code aus dem Dock kennt das nicht). */
function searchPath(): string {
  const sep = process.platform === 'win32' ? ';' : ':';
  return [process.env.PATH ?? '', path.join(os.homedir(), '.local', 'bin')].join(sep);
}

function findEngine(s: PdfSettings): string | undefined {
  if (s.engine === 'custom') return s.customCommand.trim() ? 'custom' : undefined;
  return findTool(toolNames(s.engine), s.toolPath, process.platform, searchPath());
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const exists = (p: string) => fs.existsSync(p);

export interface PdfView {
  readonly uri: vscode.Uri;
  setState(busy: boolean, text?: string): void;
}

/** Eine Umwandlung pro PDF; der Zustand geht an alle Anzeigen dieser PDF. */
export class PdfConverter implements vscode.Disposable {
  private readonly running = new Map<string, { proc?: ChildProcess; cancel: () => void }>();
  private readonly views = new Set<PdfView>();

  dispose() {
    for (const r of this.running.values()) r.cancel();
  }

  addView(v: PdfView): vscode.Disposable {
    this.views.add(v);
    return { dispose: () => this.views.delete(v) };
  }

  isBusy(uri: vscode.Uri) {
    return this.running.has(uri.toString());
  }

  cancel(uri: vscode.Uri) {
    this.running.get(uri.toString())?.cancel();
  }

  private broadcast(uri: vscode.Uri, busy: boolean, text?: string) {
    for (const v of this.views) if (v.uri.toString() === uri.toString()) v.setState(busy, text);
  }

  /** Vorhandene .md zur PDF (für „Markdown öffnen“). */
  existing(pdf: vscode.Uri): vscode.Uri | undefined {
    const p = outputPaths(pdf.fsPath).md;
    return exists(p) ? vscode.Uri.file(p) : undefined;
  }

  async convert(pdf: vscode.Uri): Promise<vscode.Uri | undefined> {
    if (pdf.scheme !== 'file') {
      vscode.window.showWarningMessage('PDF-Umwandlung geht nur mit lokalen Dateien.');
      return;
    }
    const key = pdf.toString();
    if (this.running.has(key)) return;
    const s = readSettings();
    const bin = findEngine(s);
    if (!bin) {
      void showInstallHint(installHint(s.engine, process.platform));
      return;
    }
    const target = await chooseTarget(pdf.fsPath);
    if (!target) return;

    // realpath: unter macOS ist /var ein Link auf /private/var, die Umwandler schreiben teils den echten Pfad
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'md-review-pdf-')));
    let cancelled = false;
    const entry: { proc?: ChildProcess; cancel: () => void } = {
      cancel: () => {
        cancelled = true;
        entry.proc?.kill();
      },
    };
    this.running.set(key, entry);
    const name = path.basename(pdf.fsPath);
    this.broadcast(pdf, true, `Wandle um mit ${s.engine} …`);
    const t0 = Date.now();
    try {
      const { cmd, args } = engineCommand(s, bin, pdf.fsPath, tmp);
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `${name} → Markdown (${s.engine})`, cancellable: true },
        async (progress, token) => {
          token.onCancellationRequested(() => entry.cancel());
          // marker meldet ohne Terminal kaum Fortschritt: also wenigstens die Laufzeit und die letzte Meldung zeigen
          let detail = 'startet (beim ersten Mal werden die Modelle geladen)';
          const tick = () => {
            const sec = Math.round((Date.now() - t0) / 1000);
            const msg = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')} – ${detail}`;
            progress.report({ message: msg });
            this.broadcast(pdf, true, msg);
          };
          tick();
          const timer = setInterval(tick, 1000);
          try {
            await runTool(cmd, args, entry, (line) => {
              const p = parseProgress(line);
              if (p) detail = `${p.label} (${p.percent} %)`;
              else if (/\[(INFO|WARNING)\]|INFO|^\w[\w ]+:/.test(line)) detail = shortLine(line);
            });
          } finally {
            clearInterval(timer);
          }
          if (cancelled) return;
          progress.report({ message: 'Abbildungen und Markdown aufräumen …' });
          this.broadcast(pdf, true, 'Abbildungen und Markdown aufräumen …');
          await this.finish(pdf.fsPath, tmp, target, s);
        },
      );
      if (cancelled) {
        log.info('PDF-Umwandlung abgebrochen:', name);
        return;
      }
      log.info(`PDF-Umwandlung fertig in ${Math.round((Date.now() - t0) / 1000)} s: ${target.md}`);
      const md = vscode.Uri.file(target.md);
      await vscode.commands.executeCommand('vscode.openWith', md, 'mdReview.editor', { viewColumn: vscode.ViewColumn.Beside, preview: false });
      return md;
    } catch (e: any) {
      if (cancelled) return;
      log.error('PDF-Umwandlung fehlgeschlagen:', e?.message ?? e);
      const a = await vscode.window.showErrorMessage(`PDF-Umwandlung fehlgeschlagen: ${e?.message ?? e}`, 'Protokoll anzeigen', 'Einstellungen');
      if (a === 'Protokoll anzeigen') log.show();
      else if (a === 'Einstellungen') await vscode.commands.executeCommand('workbench.action.openSettings', 'mdReview.pdf');
    } finally {
      this.running.delete(key);
      this.broadcast(pdf, false, '');
      fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Ausgabe übernehmen: Markdown aufräumen, Bilder nach <name>.assets/. */
  private async finish(pdfPath: string, tmp: string, target: { md: string; assets: string; assetsName: string }, s: PdfSettings) {
    const files = walk(tmp);
    const stem = path.basename(pdfPath).replace(/\.pdf$/i, '');
    const mdFile = pickMarkdown(files, stem);
    if (!mdFile) throw new Error('Der Umwandler hat keine Markdown-Datei erzeugt (Details im Protokoll).');
    const raw = fs.readFileSync(mdFile, 'utf8');
    const mdDir = path.dirname(mdFile);

    const images = new Map<string, string>();
    const used = new Set<string>();
    const refs = imageRefs(raw);
    if (refs.length) fs.mkdirSync(target.assets, { recursive: true });
    refs.forEach((src, i) => {
      const from = path.resolve(mdDir, decodeURIComponent(src));
      if (!from.startsWith(tmp) || !exists(from)) {
        log.warn('Abbildung nicht gefunden:', src);
        return;
      }
      let name = figureName(src, i);
      for (let k = 2; used.has(name); k++) name = name.replace(/(-\d+)?(\.\w+)$/, `-${k}$2`);
      used.add(name);
      fs.copyFileSync(from, path.join(target.assets, name));
      images.set(src, `${target.assetsName}/${name}`);
    });
    log.info(`${refs.length} Abbildung(en) übernommen nach ${target.assets}`);

    const md = postprocess(raw, { images, math: s.math, pageMarkers: s.pageMarkers });
    fs.writeFileSync(target.md, md, 'utf8');
  }
}

/** Letzte Meldung kurz für die Fortschrittsanzeige: ohne Zeitstempel und Log-Level. */
export function shortLine(line: string): string {
  const s = line
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/^\s*\d{4}-\d\d-\d\d[ T][\d:,.]+\s*/, '')
    .replace(/^\[?(INFO|WARNING|DEBUG)\]?\s*/i, '')
    .replace(/^[\w.]+:\s*/, '')
    .trim();
  return s.length > 60 ? s.slice(0, 59) + '…' : s;
}

/** Startet den Umwandler, schreibt seine Ausgabe ins Protokoll und meldet Zeilen für den Fortschritt. */
function runTool(cmd: string, args: string[], entry: { proc?: ChildProcess }, onLine: (line: string) => void): Promise<void> {
  log.info('PDF-Umwandlung:', cmd, args.map((a) => (a.includes('\n') ? '<skript>' : a)).join(' '));
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, PATH: searchPath(), PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
    });
    entry.proc = proc;
    let tail = '';
    const onData = (b: Buffer) => {
      const text = b.toString();
      tail = (tail + text).slice(-4000);
      // tqdm schreibt mit \r, normale Meldungen mit \n
      for (const line of text.split(/[\r\n]+/)) {
        if (!line.trim()) continue;
        onLine(line);
        if (!parseProgress(line)) log.info('  ', line.trim());
      }
    };
    proc.stdout!.on('data', onData);
    proc.stderr!.on('data', onData);
    proc.on('error', (e) => reject(new Error(`${path.basename(cmd)} konnte nicht starten: ${e.message}`)));
    proc.on('close', (code, signal) => {
      if (code === 0 || signal) return resolve();
      const last = tail.trim().split(/[\r\n]+/).filter((l) => !parseProgress(l)).pop() ?? '';
      reject(new Error(`${path.basename(cmd)} endete mit Code ${code}${last ? `: ${last.slice(0, 300)}` : ''}`));
    });
  });
}

/** Gibt es die .md schon, fragen: überschreiben oder neue Datei. */
async function chooseTarget(pdfPath: string) {
  const first = outputPaths(pdfPath);
  if (!exists(first.md)) return first;
  let detail = 'Neue Datei legt eine weitere .md mit eigener Nummer an.';
  try {
    const n = scanMarkers(fs.readFileSync(first.md, 'utf8')).length;
    if (n) detail = `Achtung: Die vorhandene Datei enthält ${n} Marker (Hervorhebungen, Kommentare, Vorschläge), die beim Überschreiben verloren gehen. ` + detail;
  } catch {
    /* nicht lesbar – trotzdem fragen */
  }
  const a = await vscode.window.showWarningMessage(`„${path.basename(first.md)}“ gibt es schon.`, { modal: true, detail }, 'Überschreiben', 'Neue Datei');
  if (a === 'Neue Datei') return outputPaths(pdfPath, freeVariant(pdfPath, exists));
  if (a !== 'Überschreiben') return undefined;
  // alte Abbildungen in den Papierkorb, damit keine verwaisten Dateien bleiben
  if (exists(first.assets)) await vscode.workspace.fs.delete(vscode.Uri.file(first.assets), { recursive: true, useTrash: true });
  return first;
}

async function showInstallHint(hint: { text: string; command?: string }) {
  const actions = [hint.command ? 'Im Terminal installieren' : '', hint.command ? 'Befehl kopieren' : '', 'Einstellungen'].filter(Boolean);
  const a = await vscode.window.showWarningMessage(hint.text, ...actions);
  if (a === 'Im Terminal installieren' && hint.command) {
    const t = vscode.window.createTerminal('Markdown Review: PDF');
    t.show();
    t.sendText(hint.command);
  } else if (a === 'Befehl kopieren' && hint.command) await vscode.env.clipboard.writeText(hint.command);
  else if (a === 'Einstellungen') await vscode.commands.executeCommand('workbench.action.openSettings', 'mdReview.pdf');
}

// ------------------------------------------------------------ PDF-Anzeige

type ViewMsg = { type: 'ready' } | { type: 'convert' } | { type: 'cancel' } | { type: 'openMd' } | { type: 'log'; text: string };

/** Schreibgeschützte PDF-Anzeige mit pdf.js und dem Knopf „In Markdown umwandeln“. */
export class PdfViewerProvider implements vscode.CustomReadonlyEditorProvider {
  static readonly viewType = 'mdReview.pdf';

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly converter: PdfConverter,
  ) {}

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => undefined };
  }

  resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): void {
    const uri = document.uri;
    const w = panel.webview;
    const ext = this.context.extensionUri;
    w.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(ext, 'media'), vscode.Uri.joinPath(ext, 'dist', 'pdfjs'), vscode.Uri.joinPath(uri, '..')] };
    w.html = viewerHtml(w, ext);
    const view: PdfView = {
      uri,
      setState: (busy, text) => w.postMessage({ type: 'state', busy, text, mdExists: !!this.converter.existing(uri) }),
    };
    const subs = [
      this.converter.addView(view),
      w.onDidReceiveMessage(async (m: ViewMsg) => {
        switch (m.type) {
          case 'ready':
            w.postMessage({
              type: 'init',
              url: w.asWebviewUri(uri).toString(),
              pdfjs: w.asWebviewUri(vscode.Uri.joinPath(ext, 'dist', 'pdfjs')).toString(),
              mdExists: !!this.converter.existing(uri),
            });
            if (this.converter.isBusy(uri)) view.setState(true, 'Umwandlung läuft …');
            return;
          case 'convert':
            await this.converter.convert(uri);
            return;
          case 'cancel':
            this.converter.cancel(uri);
            return;
          case 'openMd': {
            const md = this.converter.existing(uri);
            if (md) await vscode.commands.executeCommand('vscode.openWith', md, 'mdReview.editor', { viewColumn: vscode.ViewColumn.Beside, preview: false });
            return;
          }
          case 'log':
            log.warn('pdf-Anzeige:', m.text);
            return;
        }
      }),
    ];
    panel.onDidDispose(() => subs.forEach((d) => d.dispose()));
  }
}

function viewerHtml(w: vscode.Webview, ext: vscode.Uri): string {
  const media = (f: string) => w.asWebviewUri(vscode.Uri.joinPath(ext, 'media', f));
  const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  // pdf.js braucht einen Worker (als blob: aus dem Modul gebaut) und WebAssembly für JPEG 2000/JBIG2
  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${w.cspSource} blob: data:; style-src ${w.cspSource} 'unsafe-inline'; font-src ${w.cspSource} data:; connect-src ${w.cspSource}; worker-src blob: ${w.cspSource}; script-src 'nonce-${nonce}' ${w.cspSource} 'wasm-unsafe-eval';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media('pdf.css')}">
<title>PDF</title>
</head>
<body>
<div id="app"></div>
<script type="module" nonce="${nonce}" src="${media('pdf.js')}"></script>
</body>
</html>`;
}
