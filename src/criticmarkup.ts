// CriticMarkup: Erkennen, Formatieren, Annehmen/Ablehnen. Reine Funktionen ohne vscode-Abhängigkeit.

export type MarkerKind = 'insert' | 'delete' | 'subst' | 'highlight' | 'comment';

export interface CommentInfo {
  /** Offsets des gesamten {>>…<<} */
  start: number;
  end: number;
  /** Offsets des Kommentarinhalts (zwischen {>> und <<}) */
  bodyStart: number;
  bodyEnd: number;
  author?: string;
  color?: string;
  page?: string;
  ink?: string;
  /** Kommentartext ohne Kopf */
  text: string;
}

export interface Marker {
  kind: MarkerKind;
  /** Offsets des gesamten Markers inkl. angehängtem Kommentar */
  start: number;
  end: number;
  /** insert/delete/highlight: Inhalt; subst: alter Text */
  textStart: number;
  textEnd: number;
  /** subst: neuer Text */
  newStart?: number;
  newEnd?: number;
  /** highlight: angehängter Kommentar; comment: der Kommentar selbst */
  comment?: CommentInfo;
  /** ==text== (Obsidian): nur lesen, nie schreiben */
  obsidian?: boolean;
  /** steht in einem Codeblock (dort gibt es nur Hervorhebungen und Kommentare) */
  inCode?: boolean;
}

/** Farben, die gelten, wenn keine Konfiguration übergeben wird. */
export const DEFAULT_COLORS = ['gelb', 'gruen', 'blau', 'rosa', 'orange'];

export interface ScanOptions {
  obsidian?: boolean;
  /** bekannte Farbnamen; in Codeblöcken zählen nur Marker mit einer dieser Farben */
  colors?: string[];
}

export interface Edit {
  start: number;
  end: number;
  text: string;
}

const OPEN: Record<string, { kind: MarkerKind; close: string }> = {
  '{++': { kind: 'insert', close: '++}' },
  '{--': { kind: 'delete', close: '--}' },
  '{~~': { kind: 'subst', close: '~~}' },
  '{==': { kind: 'highlight', close: '==}' },
  '{>>': { kind: 'comment', close: '<<}' },
};

/** Sucht `needle` ab `from`, aber nicht über eine Leerzeile (Blockgrenze) hinweg. */
function findInBlock(src: string, needle: string, from: number, max: number): number {
  const idx = src.indexOf(needle, from);
  if (idx < 0 || idx + needle.length > max) return -1;
  const between = src.slice(from, idx);
  if (/\n[ \t]*\n/.test(between)) return -1;
  return idx;
}

/**
 * Erkennt einen Marker, der genau bei `pos` beginnt. `max` begrenzt die Suche (Blockende).
 * Wird vom Scanner und vom markdown-it-Plugin gemeinsam benutzt.
 */
export function matchMarkerAt(src: string, pos: number, max = src.length): Marker | null {
  if (src.charCodeAt(pos) !== 0x7b /* { */) return null;
  const open = src.slice(pos, pos + 3);
  const def = OPEN[open];
  if (!def) return null;
  const close = findInBlock(src, def.close, pos + 3, max);
  if (close < 0) return null;
  const textStart = pos + 3;
  const textEnd = close;
  let end = close + 3;
  const m: Marker = { kind: def.kind, start: pos, end, textStart, textEnd };
  if (def.kind === 'subst') {
    const arrow = src.indexOf('~>', textStart);
    if (arrow < 0 || arrow > textEnd) return null;
    m.textEnd = arrow;
    m.newStart = arrow + 2;
    m.newEnd = textEnd;
  } else if (def.kind === 'comment') {
    m.comment = parseComment(src, pos, end);
  } else if (def.kind === 'highlight') {
    // direkt folgender Kommentar gehört zur Hervorhebung
    if (src.startsWith('{>>', end)) {
      const cClose = findInBlock(src, '<<}', end + 3, max);
      if (cClose >= 0) {
        m.comment = parseComment(src, end, cClose + 3);
        end = cClose + 3;
        m.end = end;
      }
    }
  }
  return m;
}

/**
 * Marker in Codeblöcken: nur Hervorhebungen mit Farbkommentar und Kommentare mit Farbe, und nur mit einer
 * bekannten Farbe. So bleiben CriticMarkup-Beispiele in Code (Doku, Spezifikationen) normaler Code.
 */
export function matchCodeMarkerAt(src: string, pos: number, max: number, colors: string[]): Marker | null {
  const m = matchMarkerAt(src, pos, max);
  if (!m || (m.kind !== 'highlight' && m.kind !== 'comment')) return null;
  if (!m.comment?.color || !colors.includes(m.comment.color)) return null;
  m.inCode = true;
  return m;
}

/** Alle Code-Marker in src[start, end). */
export function scanCode(src: string, start: number, end: number, colors: string[]): Marker[] {
  const out: Marker[] = [];
  let pos = start;
  while (pos < end) {
    const idx = src.indexOf('{', pos);
    if (idx < 0 || idx >= end) break;
    const m = matchCodeMarkerAt(src, idx, end, colors);
    if (m) {
      out.push(m);
      pos = m.end;
    } else pos = idx + 1;
  }
  return out;
}

/** `==text==` (Obsidian) – wird nur gelesen. */
export function matchObsidianAt(src: string, pos: number, max = src.length): Marker | null {
  if (!src.startsWith('==', pos) || src.charCodeAt(pos + 2) === 0x3d /* = */) return null;
  if (pos > 0 && (src[pos - 1] === '{' || src[pos - 1] === '=')) return null;
  const close = findInBlock(src, '==', pos + 2, max);
  if (close < 0 || close === pos + 2) return null;
  if (src[close + 2] === '}' || src[close + 2] === '=') return null;
  if (/\s/.test(src[pos + 2]) || /\s/.test(src[close - 1])) return null;
  return { kind: 'highlight', start: pos, end: close + 2, textStart: pos + 2, textEnd: close, obsidian: true };
}

const HEAD_RE =
  /^\s*(?:([A-ZÄÖÜ]{1,4})(?=[\s:@]|$))?\s*(?:@([\p{L}\d_-]+))?\s*(?:(p\.\s?\d+))?\s*(?:ink:([\w.-]+))?\s*(:\s*|$)/u;

/** Parst `{>>…<<}` zwischen start und end. */
export function parseComment(src: string, start: number, end: number): CommentInfo {
  const bodyStart = start + 3;
  const bodyEnd = end - 3;
  const body = src.slice(bodyStart, bodyEnd);
  const info: CommentInfo = { start, end, bodyStart, bodyEnd, text: body };
  const h = HEAD_RE.exec(body);
  // Kopf nur anerkennen, wenn er etwas enthält und mit ':' oder Ende abschließt
  if (h && (h[1] || h[2] || h[3] || h[4]) && (h[5].startsWith(':') || h[0].length === body.length)) {
    info.author = h[1];
    info.color = h[2];
    info.page = h[3]?.replace(/\s/g, '');
    info.ink = h[4];
    info.text = body.slice(h[0].length);
  }
  return info;
}

export function formatComment(c: { author?: string; color?: string; page?: string; ink?: string; text?: string }): string {
  const head = [c.author, c.color ? '@' + c.color : '', c.page, c.ink ? 'ink:' + c.ink : '']
    .filter(Boolean)
    .join(' ');
  const text = (c.text ?? '').replace(/<<\}/g, '<< }');
  if (!head) return `{>>${text}<<}`;
  return text ? `{>>${head}: ${text}<<}` : `{>>${head}<<}`;
}

/** Länge eines Backtick-Laufs ab pos. */
function runLength(src: string, pos: number, ch: string): number {
  let n = 0;
  while (src[pos + n] === ch) n++;
  return n;
}

/**
 * Findet alle Marker im Dokument. Inline-Code wird übersprungen; in Fenced Codeblöcken zählen nur
 * Hervorhebungen und Kommentare mit bekannter Farbe (siehe matchCodeMarkerAt).
 */
export function scanMarkers(src: string, opts: ScanOptions = {}): Marker[] {
  const colors = opts.colors ?? DEFAULT_COLORS;
  const out: Marker[] = [];
  let pos = 0;
  let lineStart = true;
  while (pos < src.length) {
    if (lineStart) {
      const lineEnd = src.indexOf('\n', pos) < 0 ? src.length : src.indexOf('\n', pos);
      const f = /^ {0,3}(`{3,}|~{3,})/.exec(src.slice(pos, lineEnd));
      if (f) {
        // Codeblock bis zum schließenden Zaun
        const fence = f[1];
        const contentStart = Math.min(lineEnd + 1, src.length);
        let p = contentStart;
        let contentEnd = src.length;
        let after = src.length;
        while (p < src.length) {
          const e = src.indexOf('\n', p) < 0 ? src.length : src.indexOf('\n', p);
          const line = src.slice(p, e);
          const c = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
          if (c && c[1][0] === fence[0] && c[1].length >= fence.length) {
            contentEnd = p;
            after = e + 1;
            break;
          }
          p = e + 1;
        }
        out.push(...scanCode(src, contentStart, contentEnd, colors));
        pos = after;
        continue;
      }
      lineStart = false;
    }
    const ch = src[pos];
    if (ch === '\n') {
      lineStart = true;
      pos++;
      continue;
    }
    if (ch === '\\') {
      pos += 2;
      continue;
    }
    if (ch === '`') {
      const n = runLength(src, pos, '`');
      let search = pos + n;
      let closeAt = -1;
      while (true) {
        const idx = src.indexOf('`'.repeat(n), search);
        if (idx < 0) break;
        const blk = src.slice(pos, idx);
        if (/\n[ \t]*\n/.test(blk)) break;
        if (runLength(src, idx, '`') === n) {
          closeAt = idx;
          break;
        }
        search = idx + runLength(src, idx, '`');
      }
      pos = closeAt >= 0 ? closeAt + n : pos + n;
      continue;
    }
    if (ch === '{') {
      const m = matchMarkerAt(src, pos);
      if (m) {
        out.push(m);
        pos = m.end;
        continue;
      }
    }
    if (ch === '=' && opts.obsidian !== false) {
      const m = matchObsidianAt(src, pos);
      if (m) {
        out.push(m);
        pos = m.end;
        continue;
      }
    }
    pos++;
  }
  return out;
}

export function isSuggestion(m: Marker): boolean {
  return m.kind === 'insert' || m.kind === 'delete' || m.kind === 'subst';
}

/** Entfernt die Klammern um [keepStart, keepEnd) und lässt den Inhalt stehen (zwei Edits, Positionen im Inhalt bleiben gültig). */
function keepOnly(m: Marker, keepStart: number, keepEnd: number): Edit[] {
  return [
    { start: m.start, end: keepStart, text: '' },
    { start: keepEnd, end: m.end, text: '' },
  ];
}

function dropAll(m: Marker): Edit[] {
  return [{ start: m.start, end: m.end, text: '' }];
}

/** Annehmen: insert → Text, delete → nichts, subst → neu. Hervorhebung/Kommentar → entfernen. */
export function acceptEdits(m: Marker): Edit[] {
  switch (m.kind) {
    case 'insert':
      return keepOnly(m, m.textStart, m.textEnd);
    case 'delete':
      return dropAll(m);
    case 'subst':
      return keepOnly(m, m.newStart!, m.newEnd!);
    default:
      return removeEdits(m);
  }
}

/** Ablehnen: insert → nichts, delete → Text, subst → alt. Hervorhebung/Kommentar → entfernen. */
export function rejectEdits(m: Marker): Edit[] {
  switch (m.kind) {
    case 'insert':
      return dropAll(m);
    case 'delete':
    case 'subst':
      return keepOnly(m, m.textStart, m.textEnd);
    default:
      return removeEdits(m);
  }
}

/** Markierung entfernen: Text bleibt, Marker und Kommentar verschwinden. Bei Vorschlägen = Ablehnen. */
export function removeEdits(m: Marker): Edit[] {
  if (m.kind === 'highlight') return keepOnly(m, m.textStart, m.textEnd);
  if (m.kind === 'comment') return dropAll(m);
  return rejectEdits(m);
}

/** Wendet nicht überlappende Edits an. Liefert neuen Text und eine Funktion, die alte Offsets umrechnet. */
export function applyEdits(src: string, edits: Edit[]): { text: string; map: (p: number, bias?: 'left' | 'right') => number } {
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  let out = '';
  let last = 0;
  for (const e of sorted) {
    if (e.start < last) throw new Error('Überlappende Änderungen');
    out += src.slice(last, e.start) + e.text;
    last = e.end;
  }
  out += src.slice(last);
  const map = (p: number, bias: 'left' | 'right' = 'right') => {
    let delta = 0;
    for (const e of sorted) {
      if (p < e.start || (p === e.start && bias === 'left')) break;
      if (p < e.end || (p === e.end && e.start === e.end && bias === 'left')) {
        // innerhalb des ersetzten Bereichs: ans Ende (rechts) bzw. an den Anfang
        return e.start + delta + (bias === 'right' ? e.text.length : 0);
      }
      delta += e.text.length - (e.end - e.start);
    }
    return p + delta;
  };
  return { text: out, map };
}

export interface Stats {
  comments: number;
  suggestions: number;
  highlights: number;
}

export function countMarkers(markers: Marker[]): Stats {
  let comments = 0;
  let suggestions = 0;
  let highlights = 0;
  for (const m of markers) {
    if (isSuggestion(m)) suggestions++;
    else if (m.kind === 'highlight') {
      highlights++;
      if (m.comment && m.comment.text.trim()) comments++;
    } else if (m.kind === 'comment') comments++;
  }
  return { comments, suggestions, highlights };
}
