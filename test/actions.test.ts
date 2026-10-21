import { describe, expect, it } from 'vitest';
import {
  allAction,
  commentOnly,
  deleteRanges,
  highlight,
  insertAt,
  markerAction,
  minimalEdit,
  replaceRanges,
  setMarkerColor,
  setMarkerComment,
} from '../src/actions';
import { scanMarkers } from '../src/criticmarkup';

const ctx = { author: 'EM', defaultColor: 'gelb' };
const sel = (doc: string, s: string, nth = 0) => {
  let i = -1;
  for (let k = 0; k <= nth; k++) i = doc.indexOf(s, i + 1);
  return { start: i, end: i + s.length };
};
const ok = (r: any) => {
  if (!('text' in r)) throw new Error(JSON.stringify(r));
  return r as { text: string; caret?: number };
};

const doc = 'Erster Satz hier. Zweiter Satz da.\n\nNoch ein Absatz.\n';

describe('Nutzergeschichten', () => {
  it('2: gelb hervorheben', () => {
    const r = ok(highlight(doc, [sel(doc, 'Erster Satz hier.')], 'gelb', ctx));
    expect(r.text).toBe('{==Erster Satz hier.==}{>>@gelb<<} Zweiter Satz da.\n\nNoch ein Absatz.\n');
  });

  it('3: hervorheben + kommentieren', () => {
    const r = ok(highlight(doc, [sel(doc, 'Zweiter Satz da.')], 'gelb', ctx, 'brauche ich für Folie 5'));
    expect(r.text).toContain('{==Zweiter Satz da.==}{>>EM @gelb: brauche ich für Folie 5<<}');
  });

  it('4: tippen ohne Auswahl → Einfügung, weiter tippen verlängert', () => {
    const at = doc.indexOf(' Zweiter');
    let r = ok(insertAt(doc, at, ' und', ctx));
    expect(r.text).toContain('hier.{++ und++} Zweiter');
    r = ok(insertAt(r.text, r.caret!, ' zwar', ctx));
    expect(r.text).toContain('hier.{++ und zwar++} Zweiter');
    // Backspace in eigener Einfügung löscht direkt
    const c = r.caret!;
    r = ok(deleteRanges(r.text, [{ start: c - 1, end: c }], 'back', ctx));
    expect(r.text).toContain('{++ und zwa++}');
  });

  it('5: markieren und tippen → Ersetzung, weiter tippen verlängert', () => {
    let r = ok(replaceRanges(doc, [sel(doc, 'Zweiter')], 'D', ctx));
    expect(r.text).toContain('{~~Zweiter~>D~~} Satz');
    r = ok(insertAt(r.text, r.caret!, 'ritter', ctx));
    expect(r.text).toContain('{~~Zweiter~>Dritter~~} Satz');
  });

  it('6: markieren und Backspace → Löschung; zusammenhängende Löschungen verschmelzen', () => {
    let r = ok(deleteRanges(doc, [sel(doc, 'hier')], 'back', ctx));
    expect(r.text).toContain('Satz {--hier--}.');
    // Backspace ohne Auswahl vor der Löschung: Zeichen davor (Leerzeichen) wird angehängt
    const c = r.caret!;
    expect(r.text.slice(c, c + 3)).toBe('{--');
    r = ok(deleteRanges(r.text, [{ start: c - 1, end: c }], 'back', ctx));
    expect(r.text).toContain('Satz{-- hier--}.');
  });

  it('7: Markierung entfernen', () => {
    const t = ok(highlight(doc, [sel(doc, 'Erster Satz hier.')], 'gelb', ctx, 'k')).text;
    const id = scanMarkers(t)[0].start;
    expect(ok(markerAction(t, id, 'remove', ctx)).text).toBe(doc);
  });

  it('8: Annehmen/Ablehnen einzeln', () => {
    const t = 'a {~~alt~>neu~~} b';
    const id = scanMarkers(t)[0].start;
    expect(ok(markerAction(t, id, 'accept', ctx)).text).toBe('a neu b');
    expect(ok(markerAction(t, id, 'reject', ctx)).text).toBe('a alt b');
  });
});

describe('Regeln', () => {
  it('mehrere Blöcke → ein Marker pro Block', () => {
    const r = ok(highlight(doc, [{ start: doc.indexOf('da.'), end: doc.indexOf('Zweiter') + 100 }].map(() => sel(doc, 'da.')).concat([sel(doc, 'Noch ein')]), 'blau', ctx));
    expect(scanMarkers(r.text).filter((m) => m.kind === 'highlight')).toHaveLength(2);
  });

  it('erneutes Hervorheben in anderer Farbe ändert nur die Farbe und behält den Kommentar', () => {
    const t = ok(highlight(doc, [sel(doc, 'Erster Satz hier.')], 'gelb', ctx, 'wichtig')).text;
    const r = ok(highlight(t, [sel(t, 'Satz')], 'blau', ctx));
    expect(r.text).toContain('{==Erster Satz hier.==}{>>EM @blau: wichtig<<}');
  });

  it('überlappende Hervorhebung wird aufgelöst (keine Verschachtelung)', () => {
    const t = ok(highlight(doc, [sel(doc, 'Satz hier')], 'gelb', ctx)).text;
    const r = ok(highlight(t, [{ start: t.indexOf('Erster'), end: t.indexOf('hier') + 2 }], 'rosa', ctx));
    expect(r.text.startsWith('{==Erster Satz hier==}{>>@rosa<<}')).toBe(true);
    expect(scanMarkers(r.text)).toHaveLength(1);
  });

  it('Auswahl über Vorschlag → Rückfrage', () => {
    const t = 'a {++neu++} b c';
    const r = highlight(t, [{ start: 0, end: t.length }], 'gelb', ctx);
    expect('conflicts' in r).toBe(true);
  });

  it('Formatierung wird nicht zerschnitten', () => {
    const t = 'Ein **fetter Satz** hier.';
    const r = ok(highlight(t, [{ start: t.indexOf('Satz'), end: t.indexOf('hier') + 4 }], 'gelb', ctx));
    expect(r.text).toBe('Ein {==**fetter Satz** hier==}{>>@gelb<<}.');
  });

  it('Kommentar ohne Bezugstext', () => {
    const r = ok(commentOnly(doc, doc.indexOf(' Zweiter'), 'Quelle?', 'gelb', ctx));
    expect(r.text).toContain('hier.{>>EM: Quelle?<<} Zweiter');
    const r2 = ok(commentOnly(doc, doc.indexOf(' Zweiter'), 'Quelle?', 'blau', ctx));
    expect(r2.text).toContain('{>>EM @blau: Quelle?<<}');
  });

  it('Farbe ändern und Kommentar bearbeiten', () => {
    let t = ok(highlight(doc, [sel(doc, 'Erster')], 'gelb', ctx)).text;
    const id = scanMarkers(t)[0].start;
    t = ok(setMarkerColor(t, id, 'gruen', ctx)).text;
    expect(t).toContain('{==Erster==}{>>@gruen<<}');
    t = ok(setMarkerComment(t, id, 'erledigt', ctx)).text;
    expect(t).toContain('{==Erster==}{>>EM @gruen: erledigt<<}');
  });

  it('Alle annehmen / ablehnen / Hervorhebungen entfernen', () => {
    const t = 'a {++b++} {--c--} {~~d~>e~~} {==f==}{>>@gelb<<}';
    expect(ok(allAction(t, 'accept', ctx)).text).toBe('a b  e {==f==}{>>@gelb<<}');
    expect(ok(allAction(t, 'reject', ctx)).text).toBe('a  c d {==f==}{>>@gelb<<}');
    expect(ok(allAction(t, 'removeHighlights', ctx)).text).toBe('a {++b++} {--c--} {~~d~>e~~} f');
  });

  it('Tippen in Tabelle/Code wird verweigert', () => {
    const t = '| a | b |\n|---|---|\n| c | d |\n';
    expect('error' in insertAt(t, t.indexOf('c'), 'x', ctx)).toBe(true);
  });

  it('minimaler Edit', () => {
    expect(minimalEdit('abcdef', 'abXdef')).toEqual({ start: 2, end: 3, text: 'X' });
    expect(minimalEdit('same', 'same')).toBeNull();
  });
});
