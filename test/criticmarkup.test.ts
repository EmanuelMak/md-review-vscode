import { describe, expect, it } from 'vitest';
import {
  acceptEdits,
  applyEdits,
  countMarkers,
  formatComment,
  parseComment,
  rejectEdits,
  removeEdits,
  scanMarkers,
} from '../src/criticmarkup';

const accept = (s: string) => applyEdits(s, scanMarkers(s).flatMap(acceptEdits)).text;
const reject = (s: string) => applyEdits(s, scanMarkers(s).flatMap(rejectEdits)).text;

describe('scanMarkers', () => {
  it('findet alle fünf Formen', () => {
    const s = 'a {++ins++} b {--del--} c {~~alt~>neu~~} d {==hl==}{>>EM @blau: frage<<} e {>>EM: lose<<}';
    const ms = scanMarkers(s);
    expect(ms.map((m) => m.kind)).toEqual(['insert', 'delete', 'subst', 'highlight', 'comment']);
    const sub = ms[2];
    expect(s.slice(sub.textStart, sub.textEnd)).toBe('alt');
    expect(s.slice(sub.newStart!, sub.newEnd!)).toBe('neu');
    const hl = ms[3];
    expect(s.slice(hl.textStart, hl.textEnd)).toBe('hl');
    expect(hl.comment).toMatchObject({ author: 'EM', color: 'blau', text: 'frage' });
    expect(s.slice(hl.start, hl.end)).toBe('{==hl==}{>>EM @blau: frage<<}');
    expect(ms[4].comment).toMatchObject({ author: 'EM', text: 'lose' });
  });

  it('überspringt Code', () => {
    const s = 'x `{++nein++}` y\n\n```\n{==auch nicht==}\n```\n\n{++ja++}';
    expect(scanMarkers(s).map((m) => s.slice(m.start, m.end))).toEqual(['{++ja++}']);
  });

  it('Marker gehen nicht über Leerzeilen', () => {
    expect(scanMarkers('{++a\n\nb++}')).toHaveLength(0);
    expect(scanMarkers('{++a\nb++}')).toHaveLength(1);
  });

  it('liest ==Obsidian== als Hervorhebung', () => {
    const ms = scanMarkers('ein ==wichtiger== Satz, a == b, x === y');
    expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({ kind: 'highlight', obsidian: true });
  });

  it('zählt', () => {
    const s = '{==a==}{>>@gelb<<} {==b==}{>>EM: c<<} {>>EM: d<<} {++e++} {~~f~>g~~}';
    expect(countMarkers(scanMarkers(s))).toEqual({ comments: 2, suggestions: 2, highlights: 2 });
  });
});

describe('Kommentar-Kopf', () => {
  const p = (body: string) => parseComment(`{>>${body}<<}`, 0, body.length + 6);
  it('parst Varianten', () => {
    expect(p('@gelb')).toMatchObject({ color: 'gelb', text: '' });
    expect(p('EM @gelb: brauche ich für Folie 5')).toMatchObject({ author: 'EM', color: 'gelb', text: 'brauche ich für Folie 5' });
    expect(p('EM: nur Text')).toMatchObject({ author: 'EM', color: undefined, text: 'nur Text' });
    expect(p('EM @gelb p.7: Seite')).toMatchObject({ page: 'p.7', text: 'Seite' });
    expect(p('EM @gelb ink:2026-10-21-01')).toMatchObject({ ink: '2026-10-21-01', text: '' });
    expect(p('Normaler Kommentar ohne Kopf').author).toBeUndefined();
    expect(p('Normaler Kommentar ohne Kopf').text).toBe('Normaler Kommentar ohne Kopf');
  });
  it('formatiert wie in der Spec', () => {
    expect(formatComment({ color: 'gelb' })).toBe('{>>@gelb<<}');
    expect(formatComment({ author: 'EM', color: 'gelb', text: 'brauche ich für Folie 5' })).toBe('{>>EM @gelb: brauche ich für Folie 5<<}');
    expect(formatComment({ author: 'EM', text: 'x' })).toBe('{>>EM: x<<}');
  });
});

describe('Annehmen/Ablehnen/Entfernen', () => {
  it('Spec-Tabelle', () => {
    expect(accept('a {++b++} c')).toBe('a b c');
    expect(reject('a {++b++} c')).toBe('a  c');
    expect(accept('a {--b--} c')).toBe('a  c');
    expect(reject('a {--b--} c')).toBe('a b c');
    expect(accept('{~~alt~>neu~~}')).toBe('neu');
    expect(reject('{~~alt~>neu~~}')).toBe('alt');
  });
  it('Entfernen lässt Text stehen', () => {
    const s = 'x {==Satz==}{>>EM @gelb: k<<} y {>>EM: lose<<}z';
    expect(applyEdits(s, scanMarkers(s).flatMap(removeEdits)).text).toBe('x Satz y z');
  });
  it('Offsets im Inhalt bleiben gültig', () => {
    const s = 'ab {==cdef==} g';
    const out = applyEdits(s, removeEdits(scanMarkers(s)[0]));
    expect(out.text).toBe('ab cdef g');
    expect(out.map(s.indexOf('e'))).toBe(out.text.indexOf('e'));
    expect(out.map(s.indexOf('g'))).toBe(out.text.indexOf('g'));
  });
});
