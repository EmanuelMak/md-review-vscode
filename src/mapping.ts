// Vorschau ↔ Quelltext: markdown-it parsen und für jedes Inline-Token den Quelltext-Offset bestimmen.
// Reine Funktionen ohne vscode-Abhängigkeit.

import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs';
import { matchMarkerAt, matchObsidianAt, Marker } from './criticmarkup';

export interface Span {
  start: number;
  end: number;
}

/** Formatierung, die Text umschließt (**…**, [..](..), Marker): Auswahl darf sie nur ganz oder innen treffen. */
export interface Wrapper extends Span {
  innerStart: number;
  innerEnd: number;
}

export type BlockKind = 'text' | 'table' | 'code';

export interface BlockInfo extends Span {
  id: number;
  kind: BlockKind;
  /** kein Tippen (Tabellen, Code); Hervorheben und Kommentieren gehen trotzdem */
  readonly: boolean;
  /** unteilbare Stellen (Code, Bilder, Escapes, Entities, HTML) */
  atomics: Span[];
  wrappers: Wrapper[];
}

export interface Positioned {
  token: Token;
  /** Offsets im Quelltext der Datei, -1 wenn nicht zuordenbar */
  start: number;
  end: number;
  /** nur bei Text: Offset des ersten Zeichens; Text ist im Quelltext zusammenhängend */
  linear: boolean;
}

/** Abbildung Inhalts-Offset (Inline-String) → Datei-Offset */
export type OffsetMap = (i: number) => number;

// ---------------------------------------------------------------- markdown-it

function criticRule(state: StateInline, silent: boolean): boolean {
  const pos = state.pos;
  const ch = state.src.charCodeAt(pos);
  let m: Marker | null = null;
  if (ch === 0x7b /* { */) m = matchMarkerAt(state.src, pos, state.posMax);
  else if (ch === 0x3d /* = */) m = matchObsidianAt(state.src, pos, state.posMax);
  if (!m) return false;
  if (!silent) {
    const t = state.push('critic', '', 0);
    t.meta = m; // Offsets relativ zu state.src
    t.content = state.src.slice(m.start, m.end);
  }
  state.pos = m.end;
  return true;
}

export function createMd(): MarkdownIt {
  const md = new MarkdownIt({ html: true, linkify: false, typographer: false });
  // text_special-Token (Escapes, Entities) nicht mit Text verschmelzen: sonst wären Texte im Quelltext nicht zusammenhängend
  md.core.ruler.disable('text_join');
  md.inline.ruler.before('text', 'critic', criticRule);
  return md;
}

// ---------------------------------------------------------------- Zeilen/Offsets

export function lineStarts(text: string): number[] {
  const out = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) out.push(i + 1);
  return out;
}

/** YAML-Frontmatter durch Leerzeilen ersetzen (Zeilennummern bleiben gleich). */
export function stripFrontmatter(text: string): { body: string; frontmatter: string | null } {
  const m = /^---\r?\n([\s\S]*?)\r?\n(---|\.\.\.)[ \t]*(\r?\n|$)/.exec(text);
  if (!m) return { body: text, frontmatter: null };
  const blank = m[0].replace(/[^\n]/g, '');
  return { body: blank + text.slice(m[0].length), frontmatter: m[1] };
}

/**
 * Sucht die Zeilen eines Inhalts im Dateitext ab `from` und liefert eine Abbildung
 * Inhalts-Offset → Datei-Offset. markdown-it entfernt nur Einrückung, Listen-/Zitatmarker
 * und Überschriftenzeichen; jede Inhaltszeile ist daher ein Teilstring ihrer Dateizeile.
 * `code`: Leerzeilen im Inhalt sind erlaubt (Codeblöcke).
 */
export function contentMap(text: string, content: string, from: number, code = false): OffsetMap | null {
  const lines = content.split('\n');
  const starts: number[] = []; // Inhalts-Offset jeder Zeile
  const fileStarts: number[] = [];
  let ci = 0;
  let cursor = from;
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k];
    if (k > 0) {
      const nl = text.indexOf('\n', cursor);
      if (nl < 0) return null;
      cursor = nl + 1;
    }
    const idx = line.length ? text.indexOf(line, cursor) : cursor;
    if (idx < 0) return null;
    // muss in derselben Dateizeile liegen
    if (text.slice(cursor, idx).includes('\n')) return null;
    starts.push(ci);
    fileStarts.push(idx);
    ci += line.length + 1;
    cursor = idx + line.length;
  }
  if (!code && lines.length > 1 && lines.some((l) => !l.trim())) return null;
  return (i: number) => {
    let k = starts.length - 1;
    while (k > 0 && starts[k] > i) k--;
    return fileStarts[k] + (i - starts[k]);
  };
}

/** Inhalt eines Codeblocks ohne abschließenden Zeilenumbruch und seine Abbildung. */
export function codeContent(text: string, tok: Token, ls: number[]): { content: string; map: OffsetMap } | null {
  if (!tok.map) return null;
  const firstLine = tok.type === 'fence' ? tok.map[0] + 1 : tok.map[0];
  if (firstLine >= ls.length) return null;
  const content = tok.content.replace(/\n$/, '');
  const map = contentMap(text, content, ls[firstLine], true);
  return map ? { content, map } : null;
}

/**
 * Durchläuft die Block-Token und ruft `onInline` für Absätze/Überschriften/Listenpunkte/Tabellenzellen und
 * `onCode` für Codeblöcke auf, jeweils mit der Abbildung auf Datei-Offsets.
 */
export function walkBlocks(
  text: string,
  tokens: Token[],
  onInline: (tok: Token, map: OffsetMap | null, kind: BlockKind) => void,
  onCode: (tok: Token, code: { content: string; map: OffsetMap } | null) => void,
) {
  const ls = lineStarts(text);
  let inTable = false;
  let rowCursor = 0;
  for (const tok of tokens) {
    if (tok.type === 'table_open') inTable = true;
    else if (tok.type === 'table_close') inTable = false;
    else if (tok.type === 'tr_open' && tok.map) rowCursor = ls[tok.map[0]];
    else if (tok.type === 'fence' || tok.type === 'code_block') onCode(tok, codeContent(text, tok, ls));
    else if (tok.type === 'inline') {
      if (inTable) {
        // Zellen haben keine eigene Position: nacheinander in der Zeile suchen
        let map: OffsetMap | null = null;
        if (tok.content) {
          map = contentMap(text, tok.content, rowCursor);
          if (map) rowCursor = map(tok.content.length);
        }
        onInline(tok, map, 'table');
      } else {
        onInline(tok, tok.map ? contentMap(text, tok.content, ls[tok.map[0]]) : null, 'text');
      }
    }
  }
}

// ---------------------------------------------------------------- Positionen der Inline-Token

function findClosingRun(src: string, from: number, run: string): number {
  let i = from;
  while (true) {
    const idx = src.indexOf(run, i);
    if (idx < 0) return -1;
    let n = 0;
    while (src[idx + n] === '`') n++;
    if (n === run.length) return idx;
    i = idx + n;
  }
}

/** Schließende Klammer passend zu src[open] ('(' oder '[') */
function matchBracket(src: string, open: number): number {
  const o = src[open];
  const c = o === '(' ? ')' : ']';
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (o === '(' && quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (o === '(' && (ch === '"' || ch === "'") && src[i - 1] === ' ') {
      quote = ch;
      continue;
    }
    if (ch === o) depth++;
    else if (ch === c) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Ende eines Links/Bilds ab der schließenden Label-Klammer `]`. */
function linkTail(src: string, closeBracket: number): number {
  const next = src[closeBracket + 1];
  if (next === '(') {
    const e = matchBracket(src, closeBracket + 1);
    return e < 0 ? closeBracket + 1 : e + 1;
  }
  if (next === '[') {
    const e = src.indexOf(']', closeBracket + 2);
    return e < 0 ? closeBracket + 1 : e + 1;
  }
  return closeBracket + 1;
}

export interface InlineLayout {
  items: { token: Token; start: number; end: number }[]; // Inhalts-Offsets, -1 = unbekannt
  atomics: Span[];
  wrappers: Wrapper[];
}

/**
 * Bestimmt für jedes Kind-Token eines Inline-Tokens seine Position im Inline-Quelltext `src`
 * durch sequentielle Suche. Text-Token sind in markdown-it zusammenhängende Ausschnitte von `src`.
 */
export function layoutInline(children: Token[], src: string): InlineLayout {
  const items: InlineLayout['items'] = [];
  const atomics: Span[] = [];
  const wrappers: Wrapper[] = [];
  const stack: { type: string; start: number; end: number }[] = [];
  let cur = 0;

  const put = (token: Token, start: number, end: number) => {
    items.push({ token, start, end });
    if (start >= 0) cur = end;
  };

  for (const t of children) {
    switch (t.type) {
      case 'text': {
        const idx = t.content ? src.indexOf(t.content, cur) : cur;
        put(t, idx, idx < 0 ? -1 : idx + t.content.length);
        break;
      }
      case 'text_special':
      case 'html_inline': {
        const needle = t.type === 'text_special' ? t.markup : t.content;
        const idx = src.indexOf(needle, cur);
        put(t, idx, idx < 0 ? -1 : idx + needle.length);
        if (idx >= 0) atomics.push({ start: idx, end: idx + needle.length });
        break;
      }
      case 'softbreak':
      case 'hardbreak': {
        const idx = src.indexOf('\n', cur);
        put(t, idx, idx < 0 ? -1 : idx + 1);
        break;
      }
      case 'code_inline': {
        const s = src.indexOf(t.markup, cur);
        const e = s < 0 ? -1 : findClosingRun(src, s + t.markup.length, t.markup);
        if (s < 0 || e < 0) put(t, -1, -1);
        else {
          put(t, s, e + t.markup.length);
          atomics.push({ start: s, end: e + t.markup.length });
        }
        break;
      }
      case 'image': {
        const s = src.indexOf('![', cur);
        const close = s < 0 ? -1 : matchBracket(src, s + 1);
        if (s < 0 || close < 0) put(t, -1, -1);
        else {
          const e = linkTail(src, close);
          put(t, s, e);
          atomics.push({ start: s, end: e });
        }
        break;
      }
      case 'critic': {
        const m = t.meta as Marker;
        put(t, m.start, m.end);
        break;
      }
      case 'link_open': {
        const auto = t.markup === 'autolink';
        const s = src.indexOf(auto ? '<' : '[', cur);
        put(t, s, s < 0 ? -1 : s + 1);
        stack.push({ type: 'link', start: s, end: s + 1 });
        break;
      }
      case 'link_close': {
        const open = stack.pop();
        const auto = t.markup === 'autolink';
        if (auto) {
          const e = src.indexOf('>', cur);
          put(t, e, e < 0 ? -1 : e + 1);
          if (open && open.start >= 0 && e >= 0) atomics.push({ start: open.start, end: e + 1 });
        } else {
          const b = src.indexOf(']', cur);
          const e = b < 0 ? -1 : linkTail(src, b);
          put(t, b, e);
          if (open && open.start >= 0 && b >= 0)
            wrappers.push({ start: open.start, end: e, innerStart: open.end, innerEnd: b });
        }
        break;
      }
      default: {
        if (t.nesting !== 0 && t.markup) {
          // em/strong/s: öffnend oder schließend
          const s = src.indexOf(t.markup, cur);
          put(t, s, s < 0 ? -1 : s + t.markup.length);
          if (t.nesting === 1) stack.push({ type: t.type, start: s, end: s + t.markup.length });
          else {
            const open = stack.pop();
            if (open && open.start >= 0 && s >= 0)
              wrappers.push({ start: open.start, end: s + t.markup.length, innerStart: open.end, innerEnd: s });
          }
        } else {
          put(t, -1, -1);
        }
      }
    }
  }
  return { items, atomics, wrappers };
}

// ---------------------------------------------------------------- Blockanalyse

export interface Analysis {
  blocks: BlockInfo[];
}

/**
 * Analysiert das Dokument: Blöcke mit Inline-Inhalt und deren Strukturstellen in Datei-Offsets.
 * Wird von den Aktionen benutzt, um Auswahlbereiche an Formatierungsgrenzen auszurichten.
 */
export function analyze(text: string, md = createMd()): Analysis {
  const { body } = stripFrontmatter(text);
  const tokens = md.parse(body, {});
  const blocks: BlockInfo[] = [];
  walkBlocks(
    text,
    tokens,
    (tok, map, kind) => {
      if (!map) return;
      const b: BlockInfo = {
        id: blocks.length,
        kind,
        start: map(0),
        end: map(tok.content.length),
        readonly: kind !== 'text',
        atomics: [],
        wrappers: [],
      };
      collect(md, tok.children ?? [], tok.content, map, b);
      blocks.push(b);
    },
    (tok, code) => {
      if (!code) return;
      blocks.push({
        id: blocks.length,
        kind: 'code',
        start: code.map(0),
        end: code.map(code.content.length),
        readonly: true,
        atomics: [],
        wrappers: [],
      });
    },
  );
  return { blocks };
}

function collect(md: MarkdownIt, children: Token[], src: string, map: OffsetMap, b: BlockInfo) {
  const lay = layoutInline(children, src);
  for (const a of lay.atomics) b.atomics.push({ start: map(a.start), end: map(a.end) });
  for (const w of lay.wrappers)
    b.wrappers.push({ start: map(w.start), end: map(w.end), innerStart: map(w.innerStart), innerEnd: map(w.innerEnd) });
  // Strukturen innerhalb von Markern
  for (const it of lay.items) {
    if (it.token.type !== 'critic') continue;
    const m = it.token.meta as Marker;
    const parts: [number, number][] = [[m.textStart, m.textEnd]];
    if (m.kind === 'subst') parts.push([m.newStart!, m.newEnd!]);
    for (const [s, e] of parts) {
      const inner = src.slice(s, e);
      const sub = md.parseInline(inner, {})[0]?.children ?? [];
      collect(md, sub, inner, (i) => map(s + i), b);
    }
  }
}

export function blockAt(a: Analysis, offset: number): BlockInfo | undefined {
  return a.blocks.find((b) => b.start <= offset && offset <= b.end);
}

/**
 * Richtet einen Auswahlbereich an Formatierungsgrenzen aus: teilweise getroffene Formatierungen
 * (**fett**, Links) werden ganz einbezogen, unteilbare Stellen (Code, Bilder) ebenso.
 * Leerraum am Rand wird abgeschnitten. Liefert null, wenn nichts übrig bleibt.
 */
export function snapRange(text: string, b: BlockInfo, range: Span, trim = true): Span | null {
  let a = Math.max(b.start, Math.min(range.start, range.end));
  let e = Math.min(b.end, Math.max(range.start, range.end));
  // Leerraum trimmen
  while (trim && a < e && /\s/.test(text[a])) a++;
  while (trim && e > a && /\s/.test(text[e - 1])) e--;
  if (a >= e) return null;
  let changed = true;
  while (changed) {
    changed = false;
    for (const x of b.atomics) {
      if (x.start < e && a < x.end && (a > x.start || e < x.end)) {
        a = Math.min(a, x.start);
        e = Math.max(e, x.end);
        changed = true;
      }
    }
    for (const w of b.wrappers) {
      const outside = e <= w.start || a >= w.end;
      const inside = w.innerStart <= a && e <= w.innerEnd;
      const covers = a <= w.start && e >= w.end;
      if (!outside && !inside && !covers) {
        a = Math.min(a, w.start);
        e = Math.max(e, w.end);
        changed = true;
      }
    }
  }
  return { start: a, end: e };
}

/** Einfügeposition so verschieben, dass sie nicht in einer unteilbaren Stelle oder Formatierungszeichen liegt. */
export function snapPoint(b: BlockInfo, p: number): number {
  let changed = true;
  while (changed) {
    changed = false;
    for (const x of b.atomics)
      if (x.start < p && p < x.end) {
        p = x.end;
        changed = true;
      }
    for (const w of b.wrappers) {
      if (w.start < p && p < w.innerStart) {
        p = w.innerStart;
        changed = true;
      } else if (w.innerEnd < p && p < w.end) {
        p = w.end;
        changed = true;
      }
    }
  }
  return p;
}
