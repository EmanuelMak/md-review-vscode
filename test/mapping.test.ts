import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyze, blockAt, snapRange } from '../src/mapping';
import { renderDocument } from '../src/render';

const fixture = readFileSync(new URL('./fixtures/beispiel.md', import.meta.url), 'utf8');

const decode = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

/** Prüft: jeder <span data-s="n">text</span> steht genau so an Offset n in der Datei. */
function checkSpans(text: string) {
  const { html } = renderDocument(text, { defaultColor: 'gelb' });
  const re = /<span data-s="(\d+)">([^<]*)<\/span>/g;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(html))) {
    const off = Number(m[1]);
    const t = decode(m[2]);
    expect(text.slice(off, off + t.length), `Span bei ${off}`).toBe(t);
    n++;
  }
  return n;
}

describe('Offsets im gerenderten HTML', () => {
  it('stimmen für die Beispieldatei', () => {
    expect(checkSpans(fixture)).toBeGreaterThan(60);
  });

  it('stimmen für Sonderfälle', () => {
    const doc = [
      '---',
      'title: x',
      '---',
      '# Titel mit **fett** und `code`',
      '',
      '- Punkt *eins* mit [Link **fett**](http://x.de "t") danach',
      '  zweite Zeile \\* escaped &amp; entity',
      '  1. tief verschachtelt {++neu++} und {--weg--}',
      '',
      '> Zitat {~~alt~>neu~~} mit {==hl **fett**==}{>>EM @blau: frage<<}',
      '> zweite Zeile <https://auto.link> ![bild](a.png) Ende',
      '',
      '| a | b |',
      '|---|---|',
      '| c | d |',
      '',
      'Setext',
      '======',
      '',
      'Absatz mit ==obsidian== und {>>EM: lose<<} Kommentar.',
    ].join('\n');
    expect(checkSpans(doc)).toBeGreaterThan(20);
  });

  it('liefert Blöcke mit Formatierungsgrenzen', () => {
    const doc = 'Ein **fetter Satz** hier.';
    const a = analyze(doc);
    expect(a.blocks).toHaveLength(1);
    const b = blockAt(a, 5)!;
    // Auswahl "Satz hier" schneidet ** → wird auf das ganze **…** erweitert
    const r = snapRange(doc, b, { start: doc.indexOf('Satz'), end: doc.indexOf('hier') + 4 })!;
    expect(doc.slice(r.start, r.end)).toBe('**fetter Satz** hier');
    // Auswahl innen bleibt innen
    const r2 = snapRange(doc, b, { start: doc.indexOf('fetter'), end: doc.indexOf('fetter') + 6 })!;
    expect(doc.slice(r2.start, r2.end)).toBe('fetter');
  });
});
