// Review-Aktionen als reine Funktionen: alter Text + Aktion → neuer Text + Cursorposition.
// Der Provider schreibt das Ergebnis als ein WorkspaceEdit (minimaler Diff) zurück.

import {
  acceptEdits,
  applyEdits,
  Edit,
  formatComment,
  isSuggestion,
  Marker,
  rejectEdits,
  removeEdits,
  scanMarkers,
} from './criticmarkup';
import { analyze, blockAt, BlockInfo, snapPoint, snapRange, Span } from './mapping';

export interface Ctx {
  author: string;
  defaultColor: string;
  /** konfigurierte Farbnamen (Marker in Codeblöcken zählen nur mit einer davon) */
  colors?: string[];
}

const scan = (text: string, ctx: Ctx) => scanMarkers(text, { colors: ctx.colors });

const NO_TYPING = 'In Tabellen und Codeblöcken geht nur Hervorheben und Kommentieren (Text markieren → H oder K).';

/** Kommentartext so anpassen, dass er den Block nicht zerstört: in Tabellen kein „|“. */
function safeComment(b: BlockInfo | undefined, body: string | undefined): string | undefined {
  if (body === undefined || b?.kind !== 'table') return body;
  return body.replace(/\|/g, '¦');
}

/** Codeblöcke: Auswahl an Leerzeilen teilen (Marker dürfen keine Leerzeile enthalten). */
function splitCodeRanges(text: string, ranges: Span[]): Span[] {
  const a = analyze(text);
  const out: Span[] = [];
  for (const r of ranges) {
    const b = blockAt(a, r.start);
    if (b?.kind !== 'code') {
      out.push(r);
      continue;
    }
    let s = r.start;
    const re = /\n[ \t]*\n/g;
    re.lastIndex = r.start;
    const part = text.slice(0, r.end);
    let m: RegExpExecArray | null;
    while ((m = re.exec(part))) {
      out.push({ start: s, end: m.index });
      s = m.index + m[0].length;
    }
    out.push({ start: s, end: r.end });
  }
  return out.filter((r) => r.end > r.start);
}

export type Result =
  | { text: string; caret?: number; info?: string }
  | { error: string }
  /** Auswahl überschneidet Marker, die erst aufgelöst werden müssen (Nutzer fragen). */
  | { conflicts: Marker[] };

export type ConflictChoice = 'accept' | 'reject';

const overlaps = (r: Span, m: Marker) => r.start < m.end && m.start < r.end;
const within = (p: number, s: number, e: number) => s <= p && p <= e;

/** Marker, der nur Text ohne Kommentar hervorhebt, darf beim Bearbeiten stillschweigend entfernt werden. */
const silentlyRemovable = (m: Marker) => m.kind === 'highlight' && !m.comment?.text.trim() && !m.comment?.ink;

/** Löst Marker auf (Vorschläge annehmen/ablehnen, Hervorhebungen entfernen) und bildet Offsets um. */
export function resolveMarkers(text: string, markers: Marker[], choice: ConflictChoice) {
  const edits: Edit[] = [];
  for (const m of markers) edits.push(...(choice === 'accept' ? acceptEdits(m) : rejectEdits(m)));
  return applyEdits(text, edits);
}

function color(ctx: Ctx, c?: string) {
  return c || ctx.defaultColor;
}

// ---------------------------------------------------------------- Hervorheben / Kommentieren

/**
 * Hervorheben (optional mit Kommentar). Mehrere Bereiche (je Block einer) werden von hinten nach vorne
 * verarbeitet, damit die Offsets davor gültig bleiben.
 */
export function highlight(text: string, ranges: Span[], col: string, ctx: Ctx, comment?: string): Result {
  const sorted = splitCodeRanges(text, ranges).sort((a, b) => b.start - a.start);
  let caret: number | undefined;
  let applied = 0;
  for (let i = 0; i < sorted.length; i++) {
    const r = highlightOne(text, sorted[i], col, ctx, i === sorted.length - 1 ? comment : undefined);
    if ('error' in r) {
      if (sorted.length === 1) return r;
      continue;
    }
    if ('conflicts' in r) return r;
    text = r.text;
    caret = r.caret;
    applied++;
  }
  if (!applied) return { error: 'Auswahl lässt sich hier nicht hervorheben.' };
  return { text, caret };
}

function highlightOne(text: string, range: Span, col: string, ctx: Ctx, comment?: string): Result {
  const a0 = analyze(text);
  const b0 = blockAt(a0, range.start);
  if (!b0) return { error: 'Auswahl liegt nicht in einem bearbeitbaren Absatz.' };
  if (comment !== undefined) comment = safeComment(b0, comment);
  let r = snapRange(text, b0, range);
  if (!r) return { error: 'Leere Auswahl.' };

  const hits = scan(text, ctx).filter((m) => overlaps(r!, m));
  const suggestions = hits.filter(isSuggestion);
  if (suggestions.length) return { conflicts: suggestions };

  // Nur Farbe/Kommentar ändern, wenn genau eine Hervorhebung getroffen ist und die Auswahl in ihr liegt
  const hl = hits.filter((m) => m.kind === 'highlight');
  if (hl.length === 1 && hl[0].textStart <= r.start && r.end <= hl[0].textEnd && !hl[0].obsidian) {
    const m = hl[0];
    const c = m.comment;
    const newComment = formatComment({
      author: comment !== undefined ? c?.author || ctx.author : c?.author,
      color: col,
      page: c?.page,
      ink: c?.ink,
      text: comment !== undefined ? joinComments(c?.text, comment) : c?.text,
    });
    const edit: Edit = c ? { start: c.start, end: c.end, text: newComment } : { start: m.end, end: m.end, text: newComment };
    const out = applyEdits(text, [edit]);
    return { text: out.text, caret: out.map(m.end) };
  }

  // Getroffene Hervorhebungen/Kommentare auflösen, Kommentartexte übernehmen
  const old = hits.filter((m) => !isSuggestion(m));
  let keptComment: string | undefined;
  let keptPage: string | undefined;
  if (old.length) {
    for (const m of old) {
      if (m.kind === 'highlight') {
        r = { start: Math.min(r.start, m.textStart), end: Math.max(r.end, m.textEnd) };
      }
      if (m.comment?.text.trim()) keptComment = joinComments(keptComment, m.comment.text);
      keptPage = keptPage || m.comment?.page;
    }
    const edits = old.flatMap((m) => removeEdits(m));
    const out = applyEdits(text, edits);
    r = { start: out.map(r.start, 'right'), end: out.map(r.end, 'left') };
    text = out.text;
    const a1 = analyze(text);
    const b1 = blockAt(a1, r.start);
    if (!b1) return { error: 'Auswahl liegt nicht in einem bearbeitbaren Absatz.' };
    r = snapRange(text, b1, r);
    if (!r) return { error: 'Leere Auswahl.' };
  }

  const fullComment = comment !== undefined ? joinComments(keptComment, comment) : keptComment;
  const head = formatComment({
    author: fullComment ? ctx.author : undefined,
    color: col,
    page: keptPage,
    text: fullComment,
  });
  const out = applyEdits(text, [
    { start: r.start, end: r.start, text: '{==' },
    { start: r.end, end: r.end, text: '==}' + head },
  ]);
  return { text: out.text, caret: r.end + 3 + 3 + head.length };
}

function joinComments(a: string | undefined, b: string | undefined): string | undefined {
  const parts = [a, b].map((x) => x?.trim()).filter(Boolean);
  return parts.length ? parts.join(' / ') : undefined;
}

/** Kommentar ohne Bezugstext an einer Position einfügen. */
export function commentOnly(text: string, at: number, body: string, col: string, ctx: Ctx): Result {
  const a = analyze(text);
  const b = blockAt(a, at);
  if (!b) return { error: 'Cursor steht nicht in einem bearbeitbaren Absatz.' };
  let p = snapPoint(b, at);
  // nicht in einen Marker hinein
  for (const m of scan(text, ctx)) if (m.start < p && p < m.end) p = m.end;
  // in Code braucht der Kommentar immer eine Farbe, sonst gilt er dort nicht als Marker
  const c = formatComment({
    author: ctx.author,
    color: col === ctx.defaultColor && b.kind !== 'code' ? undefined : col,
    text: safeComment(b, body),
  });
  const out = applyEdits(text, [{ start: p, end: p, text: c }]);
  return { text: out.text, caret: p + c.length };
}

// ---------------------------------------------------------------- Marker bearbeiten

export function findMarker(text: string, id: number, ctx: Ctx): Marker | undefined {
  return scan(text, ctx).find((m) => m.start === id);
}

export type MarkerAction = 'accept' | 'reject' | 'remove';

export function markerAction(text: string, id: number, action: MarkerAction, ctx: Ctx): Result {
  const m = findMarker(text, id, ctx);
  if (!m) return { error: 'Marker nicht gefunden (Datei wurde inzwischen geändert?).' };
  const edits = action === 'accept' ? acceptEdits(m) : action === 'reject' ? rejectEdits(m) : removeEdits(m);
  const out = applyEdits(text, edits);
  return { text: out.text, caret: out.map(m.start, 'left') };
}

export function setMarkerColor(text: string, id: number, col: string, ctx: Ctx): Result {
  const m = findMarker(text, id, ctx);
  if (!m || (m.kind !== 'highlight' && m.kind !== 'comment')) return { error: 'Keine Hervorhebung.' };
  if (m.obsidian) {
    // ==text== in CriticMarkup umwandeln, damit die Farbe gespeichert werden kann
    const inner = text.slice(m.textStart, m.textEnd);
    const repl = `{==${inner}==}${formatComment({ color: col })}`;
    const out = applyEdits(text, [{ start: m.start, end: m.end, text: repl }]);
    return { text: out.text };
  }
  const c = m.comment;
  const repl = formatComment({ author: c?.author, color: col, page: c?.page, ink: c?.ink, text: c?.text });
  const edit: Edit = c ? { start: c.start, end: c.end, text: repl } : { start: m.end, end: m.end, text: repl };
  return { text: applyEdits(text, [edit]).text };
}

export function setMarkerComment(text: string, id: number, body: string, ctx: Ctx): Result {
  const m = findMarker(text, id, ctx);
  if (!m || (m.kind !== 'highlight' && m.kind !== 'comment')) return { error: 'Keine Hervorhebung.' };
  const c = m.comment;
  if (m.kind === 'comment' && !body.trim() && !c?.ink) return markerAction(text, id, 'remove', ctx);
  body = safeComment(blockAt(analyze(text), m.start), body) ?? '';
  let base = m;
  let src = text;
  if (m.obsidian) {
    const inner = text.slice(m.textStart, m.textEnd);
    src = applyEdits(text, [{ start: m.start, end: m.end, text: `{==${inner}==}` }]).text;
    base = scan(src, ctx).find((x) => x.start === m.start)!;
  }
  const repl = formatComment({
    author: body.trim() ? c?.author || ctx.author : undefined,
    color: c?.color || (base.kind === 'highlight' ? ctx.defaultColor : undefined),
    page: c?.page,
    ink: c?.ink,
    text: body.trim() || undefined,
  });
  const edit: Edit = c ? { start: c.start, end: c.end, text: repl } : { start: base.end, end: base.end, text: repl };
  return { text: applyEdits(src, [edit]).text };
}

export type AllAction = 'accept' | 'reject' | 'removeHighlights';

export function allAction(text: string, action: AllAction, ctx: Ctx): Result {
  const markers = scan(text, ctx).filter((m) =>
    action === 'removeHighlights' ? m.kind === 'highlight' || m.kind === 'comment' : isSuggestion(m),
  );
  if (!markers.length) return { error: 'Nichts zu tun.' };
  const edits = markers.flatMap((m) => (action === 'accept' ? acceptEdits(m) : action === 'reject' ? rejectEdits(m) : removeEdits(m)));
  return { text: applyEdits(text, edits).text, info: `${markers.length} Marker bearbeitet.` };
}

// ---------------------------------------------------------------- Tippen

/** Text an Cursorposition einfügen: verlängert eine eigene Einfügung oder legt {++…++} an. */
export function insertAt(text: string, at: number, str: string, ctx: Ctx): Result {
  const a = analyze(text);
  const b = blockAt(a, at);
  if (!b) return { error: 'Cursor steht nicht in einem bearbeitbaren Absatz.' };
  if (b.readonly) return { error: NO_TYPING };
  const markers = scan(text, ctx);

  // 1. In einer Einfügung bzw. im neuen Teil einer Ersetzung: einfach weiterschreiben
  for (const m of markers) {
    if (m.kind === 'insert' && within(at, m.textStart, m.textEnd)) return raw(text, at, str);
    if (m.kind === 'subst' && within(at, m.newStart!, m.newEnd!)) return raw(text, at, str);
  }
  // 2. Direkt vor/hinter einer Einfügung: an sie anhängen
  for (const m of markers) {
    if (m.kind === 'insert' && at === m.end) return raw(text, m.textEnd, str);
    if (m.kind === 'insert' && at === m.start) return raw(text, m.textStart, str);
    if (m.kind === 'subst' && at === m.end) return raw(text, m.newEnd!, str);
  }
  // 3. In anderen Markern: an den Rand schieben bzw. ablehnen
  let p = at;
  for (const m of markers) {
    if (!(m.start < p && p < m.end)) continue;
    if (m.kind === 'delete' || m.kind === 'subst') p = p <= m.textStart ? m.start : m.end;
    else if (m.kind === 'comment') p = m.end;
    else if (m.kind === 'highlight') {
      if (p <= m.textStart) p = m.start;
      else if (p >= m.textEnd) p = m.end;
      else if (silentlyRemovable(m)) {
        const out = applyEdits(text, removeEdits(m));
        return insertAt(out.text, out.map(at), str, ctx);
      }
      else return { error: 'Tippen in einer kommentierten Hervorhebung geht nicht (Marker werden nicht verschachtelt). Erst die Markierung entfernen.' };
    }
  }
  p = snapPoint(b, p);
  const ins = `{++${str}++}`;
  const out = applyEdits(text, [{ start: p, end: p, text: ins }]);
  return { text: out.text, caret: p + 3 + str.length };
}

function raw(text: string, at: number, str: string): Result {
  return { text: text.slice(0, at) + str + text.slice(at), caret: at + str.length };
}

/** Auswahl durch getippten Text ersetzen: {~~alt~>neu~~}. Weitere Blöcke der Auswahl werden gelöscht. */
export function replaceRanges(text: string, ranges: Span[], str: string, ctx: Ctx): Result {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  // hintere Blöcke zuerst löschen, dann im ersten ersetzen
  for (let i = sorted.length - 1; i >= 1; i--) {
    const r = deleteOne(text, sorted[i], 'fwd', ctx);
    if ('conflicts' in r) return r;
    if ('text' in r) text = r.text;
  }
  return replaceOne(text, sorted[0], str, ctx);
}

function replaceOne(text: string, range: Span, str: string, ctx: Ctx): Result {
  const a = analyze(text);
  const b = blockAt(a, range.start);
  if (!b) return { error: 'Auswahl liegt nicht in einem bearbeitbaren Absatz.' };
  if (b.readonly) return { error: NO_TYPING };
  const markers = scan(text, ctx);
  // ganz innerhalb einer eigenen Einfügung: direkt ersetzen
  for (const m of markers) {
    if (m.kind === 'insert' && m.textStart <= range.start && range.end <= m.textEnd) return rawReplace(text, range, str, ctx);
    if (m.kind === 'subst' && m.newStart! <= range.start && range.end <= m.newEnd!) return rawReplace(text, range, str, ctx);
  }
  const r = snapRange(text, b, range, false);
  if (!r) return insertAt(text, range.start, str, ctx);
  const hits = markers.filter((m) => overlaps(r, m));
  const blocking = hits.filter((m) => !silentlyRemovable(m));
  if (blocking.length) return { conflicts: blocking };
  let t = text;
  let rr = r;
  if (hits.length) {
    const out = applyEdits(text, hits.flatMap((m) => removeEdits(m)));
    t = out.text;
    rr = { start: out.map(r.start, 'right'), end: out.map(r.end, 'left') };
  }
  const old = t.slice(rr.start, rr.end);
  const ins = `{~~${old}~>${str}~~}`;
  const out = applyEdits(t, [{ start: rr.start, end: rr.end, text: ins }]);
  return { text: out.text, caret: rr.start + 3 + old.length + 2 + str.length };
}

function rawReplace(text: string, r: Span, str: string, ctx: Ctx): Result {
  const t = text.slice(0, r.start) + str + text.slice(r.end);
  return cleanupEmpty(t, r.start + str.length, ctx);
}

// ---------------------------------------------------------------- Löschen

export type Dir = 'back' | 'fwd';

/** Bereiche löschen: {--…--}, eigene Einfügungen werden direkt gekürzt, angrenzende Löschungen verschmolzen. */
export function deleteRanges(text: string, ranges: Span[], dir: Dir, ctx: Ctx): Result {
  const sorted = [...ranges].sort((a, b) => b.start - a.start);
  let caret: number | undefined;
  let any = false;
  let firstError: string | undefined;
  for (const range of sorted) {
    const r = deleteOne(text, range, dir, ctx);
    if ('conflicts' in r) return r;
    if ('error' in r) {
      firstError = firstError ?? r.error;
      continue;
    }
    text = r.text;
    caret = r.caret; // letzter (vorderster) Bereich bestimmt den Cursor
    any = true;
  }
  if (!any) return { error: firstError ?? 'Nichts zu löschen.' };
  return { text, caret };
}

function deleteOne(text: string, range: Span, dir: Dir, ctx: Ctx): Result {
  const a = analyze(text);
  const b = blockAt(a, range.start);
  if (!b) return { error: 'Auswahl liegt nicht in einem bearbeitbaren Absatz.' };
  if (b.readonly) return { error: NO_TYPING };
  const markers = scan(text, ctx);

  // ganz in eigener Einfügung / neuem Teil einer Ersetzung: Zeichen wirklich entfernen
  for (const m of markers) {
    const inIns = m.kind === 'insert' && m.textStart <= range.start && range.end <= m.textEnd;
    const inNew = m.kind === 'subst' && m.newStart! <= range.start && range.end <= m.newEnd!;
    if (inIns || inNew) return rawReplace(text, range, '', ctx);
  }
  // ganz in einer Löschung (oder altem Teil einer Ersetzung): nichts zu tun, Cursor über den Marker setzen
  for (const m of markers) {
    if ((m.kind === 'delete' || m.kind === 'subst') && m.textStart <= range.start && range.end <= m.textEnd)
      return { text, caret: dir === 'back' ? m.start : m.end };
  }

  const r = snapRange(text, b, range, false);
  if (!r) return { text, caret: dir === 'back' ? range.start : range.end };
  const hits = markers.filter((m) => overlaps(r, m));
  // Löschungen in der Auswahl einfach mit aufnehmen, Hervorhebungen ohne Kommentar entfernen, Rest: fragen
  const blocking = hits.filter((m) => m.kind !== 'delete' && !silentlyRemovable(m));
  if (blocking.length) return { conflicts: blocking };
  let t = text;
  let rr = r;
  if (hits.length) {
    // bestehende Löschungen und schlichte Hervorhebungen auflösen; Bereich auf ganze Löschungen erweitern
    for (const m of hits) if (m.kind === 'delete') rr = { start: Math.min(rr.start, m.start), end: Math.max(rr.end, m.end) };
    const out = applyEdits(text, hits.flatMap((m) => removeEdits(m)));
    t = out.text;
    rr = { start: out.map(rr.start, 'right'), end: out.map(rr.end, 'left') };
  }
  // Nachbarn verschmelzen: {--a--} direkt davor/dahinter
  const after = scan(t, ctx);
  const prev = after.find((m) => m.kind === 'delete' && m.end === rr.start);
  const next = after.find((m) => m.kind === 'delete' && m.start === rr.end);
  let s = rr.start;
  let e = rr.end;
  let body = t.slice(rr.start, rr.end);
  if (prev) {
    body = t.slice(prev.textStart, prev.textEnd) + body;
    s = prev.start;
  }
  if (next) {
    body = body + t.slice(next.textStart, next.textEnd);
    e = next.end;
  }
  const del = `{--${body}--}`;
  const out = applyEdits(t, [{ start: s, end: e, text: del }]);
  return { text: out.text, caret: dir === 'back' ? s : s + del.length };
}

/** Leere Einfügungen/Ersetzungen nach dem Kürzen aufräumen. */
function cleanupEmpty(text: string, caret: number, ctx: Ctx): Result {
  for (const m of scan(text, ctx)) {
    if (m.kind === 'insert' && m.textStart === m.textEnd && m.start <= caret && caret <= m.end) {
      const out = applyEdits(text, [{ start: m.start, end: m.end, text: '' }]);
      return { text: out.text, caret: m.start };
    }
    if (m.kind === 'subst' && m.newStart === m.newEnd && m.start <= caret && caret <= m.end) {
      const repl = `{--${text.slice(m.textStart, m.textEnd)}--}`;
      const out = applyEdits(text, [{ start: m.start, end: m.end, text: repl }]);
      return { text: out.text, caret: m.start };
    }
  }
  // leere Ersetzung {++…++} gibt es nicht; Text unverändert zurück
  return { text, caret };
}

/** Enter: in einer Einfügung Zeilenumbruch im Marker, sonst nichts (Absatzumbruch kommt in v0.2). */
export function enterAt(text: string, at: number, ctx: Ctx): Result {
  for (const m of scan(text, ctx)) {
    if ((m.kind === 'insert' && within(at, m.textStart, m.textEnd)) || (m.kind === 'subst' && within(at, m.newStart!, m.newEnd!)))
      return raw(text, at, '\n');
  }
  return { error: 'Zeilenumbruch geht in v0.1 nur innerhalb einer eigenen Einfügung.' };
}

/** Kleinster Edit, der `a` in `b` überführt (für ein sauberes WorkspaceEdit/Undo). */
export function minimalEdit(a: string, b: string): Edit | null {
  if (a === b) return null;
  let s = 0;
  const max = Math.min(a.length, b.length);
  while (s < max && a.charCodeAt(s) === b.charCodeAt(s)) s++;
  let ea = a.length;
  let eb = b.length;
  while (ea > s && eb > s && a.charCodeAt(ea - 1) === b.charCodeAt(eb - 1)) {
    ea--;
    eb--;
  }
  return { start: s, end: ea, text: b.slice(s, eb) };
}

export type { BlockInfo };
