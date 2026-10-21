import { describe, expect, it } from 'vitest';
import { commentOnly, highlight, insertAt, markerAction, setMarkerComment } from '../src/actions';
import { scanMarkers } from '../src/criticmarkup';
import { analyze } from '../src/mapping';
import { renderDocument } from '../src/render';

const ctx = { author: 'EM', defaultColor: 'gelb', colors: ['gelb', 'gruen', 'blau', 'rosa', 'orange'] };
const ok = (r: any) => {
  if (!('text' in r)) throw new Error(JSON.stringify(r));
  return r as { text: string; caret?: number };
};
const at = (doc: string, s: string, nth = 0) => {
  let i = -1;
  for (let k = 0; k <= nth; k++) i = doc.indexOf(s, i + 1);
  return { start: i, end: i + s.length };
};

const table = ['Vorher.', '', '| Loop | Stufen | Loop |', '|---|---|---|', '| OODA | **4** Stufen | OODA |', '| MAPE-K | 4 + K | x |', ''].join('\n');

const code = ['Text.', '', '```python', 'def loop():', '    sense()', '', '    act()', '```', ''].join('\n');

describe('Tabellen', () => {
  it('jede Zelle ist ein eigener Block, auch bei gleichem Inhalt', () => {
    const cells = analyze(table).blocks.filter((b) => b.kind === 'table');
    expect(cells.map((b) => table.slice(b.start, b.end))).toEqual(['Loop', 'Stufen', 'Loop', 'OODA', '**4** Stufen', 'OODA', 'MAPE-K', '4 + K', 'x']);
    // zweites "OODA" liegt hinter dem ersten
    expect(cells[5].start).toBeGreaterThan(cells[3].start);
  });

  it('Zelle hervorheben und kommentieren', () => {
    const r = ok(highlight(table, [at(table, 'OODA', 1)], 'blau', ctx, 'Boyd | 1996'));
    expect(r.text).toContain('| OODA | **4** Stufen | {==OODA==}{>>EM @blau: Boyd ¦ 1996<<} |');
    expect(scanMarkers(r.text)).toHaveLength(1);
  });

  it('Auswahl über mehrere Zellen → ein Marker pro Zelle', () => {
    const r = ok(highlight(table, [at(table, 'MAPE-K'), at(table, '4 + K')], 'gelb', ctx));
    expect(r.text).toContain('| {==MAPE-K==}{>>@gelb<<} | {==4 + K==}{>>@gelb<<} |');
  });

  it('Formatierung in Zellen wird nicht zerschnitten', () => {
    const s0 = table.indexOf('4** St');
    const r = ok(highlight(table, [{ start: s0, end: table.indexOf('Stufen', s0) + 6 }], 'gelb', ctx));
    expect(r.text).toContain('| {==**4** Stufen==}{>>@gelb<<} |');
  });

  it('Kommentar ohne Bezugstext in einer Zelle, Bearbeiten ersetzt |', () => {
    let t = ok(commentOnly(table, at(table, 'x').end, 'a|b', 'gelb', ctx)).text;
    expect(t).toContain('| x{>>EM: a¦b<<} |');
    const id = scanMarkers(t)[0].start;
    t = ok(setMarkerComment(t, id, 'c|d', ctx)).text;
    expect(t).toContain('{>>EM: c¦d<<}');
  });

  it('Tippen bleibt in Tabellen gesperrt', () => {
    const r = insertAt(table, at(table, 'MAPE-K').end, 'x', ctx);
    expect('error' in r && r.error).toMatch(/Hervorheben und Kommentieren/);
  });

  it('gerenderte Zellen tragen Offsets', () => {
    const { html } = renderDocument(table, { defaultColor: 'gelb' });
    const off = at(table, 'OODA', 1).start;
    expect(html).toContain(`<span data-s="${off}">OODA</span>`);
  });
});

describe('Codeblöcke', () => {
  it('Code-Zeile hervorheben → Marker im Codeblock, mit Farbe', () => {
    const r = ok(highlight(code, [at(code, 'sense()')], 'gelb', ctx, 'warum hier?'));
    expect(r.text).toContain('    {==sense()==}{>>EM @gelb: warum hier?<<}\n');
    const ms = scanMarkers(r.text);
    expect(ms).toHaveLength(1);
    expect(ms[0].inCode).toBe(true);
  });

  it('Auswahl über eine Leerzeile wird geteilt, Kommentar am ersten Teil', () => {
    const r = ok(highlight(code, [{ start: code.indexOf('sense'), end: code.indexOf('act()') + 5 }], 'rosa', ctx, 'k'));
    expect(r.text).toContain('{==sense()==}{>>EM @rosa: k<<}\n\n    {==act()==}{>>@rosa<<}');
  });

  it('Kommentar ohne Bezug im Code trägt immer eine Farbe', () => {
    const r = ok(commentOnly(code, at(code, 'def loop():').end, 'Einstieg', 'gelb', ctx));
    expect(r.text).toContain('def loop():{>>EM @gelb: Einstieg<<}');
    expect(scanMarkers(r.text)).toHaveLength(1);
  });

  it('Entfernen stellt den Code wieder her', () => {
    const t = ok(highlight(code, [at(code, 'act()')], 'blau', ctx)).text;
    expect(ok(markerAction(t, scanMarkers(t)[0].start, 'remove', ctx)).text).toBe(code);
  });

  it('CriticMarkup-Beispiele in Code bleiben Code', () => {
    const doc = '```\n{==Text==}{>>EM @farbe: Kommentar<<} {++neu++} {~~a~>b~~} {>>EM: x<<}\n```\n';
    expect(scanMarkers(doc)).toHaveLength(0);
  });

  it('Rendering: Offsets stimmen, Marker als <mark> im <pre>', () => {
    const t = ok(highlight(code, [at(code, 'sense()')], 'gelb', ctx)).text;
    const { html, markers } = renderDocument(t, { defaultColor: 'gelb' });
    expect(markers).toHaveLength(1);
    expect(html).toMatch(/<pre><code class="language-python"><span class="blk code"[^>]*>.*<mark class="cm cm-hl"/s);
    const re = /<span data-s="(\d+)">([^<]*)<\/span>/g;
    let m: RegExpExecArray | null;
    let n = 0;
    while ((m = re.exec(html))) {
      const s = m[2].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
      expect(t.slice(+m[1], +m[1] + s.length)).toBe(s);
      n++;
    }
    expect(n).toBeGreaterThan(4);
  });

  it('Tippen bleibt im Code gesperrt', () => {
    expect('error' in insertAt(code, at(code, 'sense').start, 'x', ctx)).toBe(true);
  });
});
