import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));
vi.mock('../src/provider', () => ({ log: { info() {}, warn() {}, error() {} } }));
const {
  convertMath, engineCommand, figureName, fixHeadings, formulaTables, freeVariant, imageRefs, installHint, joinSplitParagraphs, mdLink,
  outputPaths, parseProgress, pickMarkdown, postprocess, shortLine, splitArgs,
} = await import('../src/pdf');
const { renderDocument } = await import('../src/render');

const settings = { engine: 'marker' as const, toolPath: '', customCommand: '', extraArgs: [], math: 'code' as const, pageMarkers: true };

describe('Zielpfade', () => {
  it('legt .md und .assets neben die PDF', () => {
    expect(outputPaths('/a/b/Paper 1.pdf')).toEqual({ md: '/a/b/Paper 1.md', assets: '/a/b/Paper 1.assets', assetsName: 'Paper 1.assets' });
    expect(outputPaths('/a/x.PDF', 3).md).toBe('/a/x-3.md');
  });

  it('findet die erste freie Nummer', () => {
    const taken = new Set(['/a/x-2.md', '/a/x-3.assets']);
    expect(freeVariant('/a/x.pdf', (p) => taken.has(p))).toBe(4);
  });
});

describe('Aufruf', () => {
  it('marker mit Seitentrennern', () => {
    expect(engineCommand(settings, '/bin/marker_single', '/p/a.pdf', '/tmp/o')).toEqual({
      cmd: '/bin/marker_single',
      args: ['/p/a.pdf', '--output_dir', '/tmp/o', '--output_format', 'markdown', '--paginate_output'],
    });
  });

  it('docling und zusätzliche Argumente', () => {
    const c = engineCommand({ ...settings, engine: 'docling', extraArgs: ['--enrich-formula'] }, 'docling', '/p/a.pdf', '/tmp/o');
    expect(c.args).toEqual(['/p/a.pdf', '--to', 'md', '--image-export-mode', 'referenced', '--output', '/tmp/o', '--enrich-formula']);
  });

  it('pymupdf4llm über python -c', () => {
    const c = engineCommand({ ...settings, engine: 'pymupdf4llm' }, 'python3', '/p/a.pdf', '/tmp/o');
    expect(c.cmd).toBe('python3');
    expect(c.args[0]).toBe('-c');
    expect(c.args[1]).toContain('pymupdf4llm.to_markdown');
    expect(c.args.slice(2)).toEqual(['/p/a.pdf', '/tmp/o']);
  });

  it('eigener Befehl mit Platzhaltern und Anführungszeichen', () => {
    const c = engineCommand({ ...settings, engine: 'custom', customCommand: `"/Programme/My Tool/run" {input} --out '{output}' -x` }, '', '/p/a b.pdf', '/tmp/o');
    expect(c).toEqual({ cmd: '/Programme/My Tool/run', args: ['/p/a b.pdf', '--out', '/tmp/o', '-x'] });
    expect(splitArgs(`a "b \\" c" 'd e'`)).toEqual(['a', 'b " c', 'd e']);
  });
});

describe('Installationshinweis', () => {
  it('macOS: uv über Homebrew', () => {
    const h = installHint('marker', 'darwin');
    expect(h.command).toBe('brew install uv && uv tool install --python 3.12 marker-pdf');
    expect(h.text).toContain('marker');
  });

  it('Windows: winget', () => {
    expect(installHint('docling', 'win32').command).toContain('winget install --id astral-sh.uv');
  });

  it('custom: kein Befehl', () => {
    expect(installHint('custom', 'darwin').command).toBeUndefined();
  });
});

describe('Fortschritt', () => {
  it('liest tqdm-Zeilen', () => {
    expect(parseProgress('Recognizing Layout:  40%|████      | 2/5 [00:03<00:04,  1.2it/s]')).toEqual({ label: 'Recognizing Layout 2/5', percent: 40 });
  });

  it('liest pymupdf4llm', () => {
    expect(parseProgress('===[=====          ] ( 2/16)')).toEqual({ label: 'Seiten 2/16', percent: 13 });
  });

  it('kürzt Log-Zeilen', () => {
    expect(shortLine("2026-10-21 16:53:04,537 [INFO] marker: Table processing stats: {'tables_pdftext': 9}")).toBe("Table processing stats: {'tables_pdftext': 9}");
    expect(shortLine('2026-10-21 16:44:50,066\tINFO\tdocling.models.vlm: Running inference on 5 image(s) on cpu (max_new_tokens=2048)...')).toBe(
      'Running inference on 5 image(s) on cpu (max_new_tokens=2048…',
    );
  });

  it('ignoriert normale Meldungen', () => {
    expect(parseProgress('2026-10-21 [INFO] marker: Saved markdown')).toBeUndefined();
  });
});

describe('Abbildungen', () => {
  it('findet Bildlinks, auch absolute und Windows-Pfade', () => {
    expect(imageRefs('![](_page_2_Figure_0.jpeg) ![x](a/b.png "t") <img src="c.png"> ![](https://x/y.png) ![](C:\\t\\d.png)')).toEqual([
      '_page_2_Figure_0.jpeg',
      'a/b.png',
      'C:\\t\\d.png',
      'c.png',
    ]);
  });

  it('benennt nach Seite', () => {
    expect(figureName('_page_2_Figure_0.jpeg', 0)).toBe('p3-figure-1.jpg');
    expect(figureName('_page_14_Diagram_1.jpeg', 4)).toBe('p15-diagram-2.jpg');
    expect(figureName('/tmp/x/images/bert.pdf-0005-00.png', 1)).toBe('p5-bild-1.png');
    expect(figureName('bert_artifacts/image_000003_9ebd.png', 3)).toBe('bild-4.png');
  });

  it('kodiert Links', () => {
    expect(mdLink('Mein Paper (2024).assets/p1-figure-1.jpg')).toBe('Mein%20Paper%20(2024).assets/p1-figure-1.jpg'.replace('(', '%28').replace(')', '%29'));
  });
});

describe('Formeln', () => {
  it('Inline als Code, Block als ```math', () => {
    const s = convertMath('Mit $d_k$ und $x^2 * y$ gilt\n\n$$\n\\mathrm{softmax}(QK^T)\n$$\n\nEnde.', 'code');
    expect(s).toContain('Mit `$d_k$` und `$x^2 * y$` gilt');
    expect(s).toContain('```math\n\\mathrm{softmax}(QK^T)\n```');
  });

  it('lässt Geldbeträge, Code und Escapes in Ruhe', () => {
    expect(convertMath('kostet $5 und $6', 'code')).toBe('kostet $5 und $6');
    expect(convertMath('`$a_b$` und\n```\n$x_y$\n```', 'code')).toBe('`$a_b$` und\n```\n$x_y$\n```');
    expect(convertMath('\\$a$ b', 'code')).toBe('\\$a$ b');
  });

  it('dollar: unverändert', () => {
    expect(convertMath('$a_b$', 'dollar')).toBe('$a_b$');
  });
});

describe('Überschriften', () => {
  it('Ebenen aus der Nummerierung, Titel als #', () => {
    const s = fixHeadings('# **Ein Titel**\n\n# Abstract\n\n#### 1 Introduction\n\n# 2.1 Related\n\n## 2.1.3 Deep\n\n# A Appendix\n\n## A.2 Mehr\n\n## • Batch size: 16');
    expect(s.split('\n\n')).toEqual(['# Ein Titel', '## Abstract', '## 1 Introduction', '### 2.1 Related', '#### 2.1.3 Deep', '## A Appendix', '### A.2 Mehr', '- Batch size: 16']);
  });

  it('ohne Nummern bleiben die Ebenen (mindestens ##)', () => {
    expect(fixHeadings('## Titel\n\n# Teil\n\n### Unterteil')).toBe('# Titel\n\n## Teil\n\n### Unterteil');
  });

  it('nicht in Codeblöcken', () => {
    expect(fixHeadings('```\n# Kommentar\n```')).toBe('```\n# Kommentar\n```');
  });
});

describe('Seitengrenzen', () => {
  it('fügt einen getrennten Absatz zusammen und schiebt die Marke dahinter', () => {
    const de = 'Am Ende des Kapitels steht fest, dass sich die Ergebnisse der beiden Verfahren nur in der';
    expect(joinSplitParagraphs(`${de}\n\n<!-- page 2 -->\n\nGenauigkeit unterscheiden.\n\nNeu.`)).toBe(`${de} Genauigkeit unterscheiden.\n\n<!-- page 2 -->\n\nNeu.`);
    expect(joinSplitParagraphs('the id of the masked\n\n<!-- page 2 -->\n\nword based only on its context.')).toBe(
      'the id of the masked word based only on its context.\n\n<!-- page 2 -->',
    );
  });

  it('setzt Abbildung und Bildunterschrift hinter den Absatz', () => {
    expect(joinSplitParagraphs('The output is computed as a weighted sum\n\n<!-- page 4 -->\n\n![](a.jpg)\n\nFigure 2: Zwei Teile.\n\nof the values, where.')).toBe(
      'The output is computed as a weighted sum of the values, where.\n\n<!-- page 4 -->\n\n![](a.jpg)\n\nFigure 2: Zwei Teile.',
    );
  });

  it('nicht über Formeln und nicht ohne Unterbrechung', () => {
    for (const s of ['we compute\n\n```math\nx\n```\n\nwhere x is', 'ein Absatz ohne Punkt\n\nnoch einer']) expect(joinSplitParagraphs(s)).toBe(s);
  });

  it('lässt abgeschlossene Absätze, Überschriften und Tabellen getrennt', () => {
    for (const s of ['Satz zu Ende.\n\n<!-- page 2 -->\n\nneuer', '## 1 Intro\n\n<!-- page 2 -->\n\ntext', 'a\n\n<!-- page 2 -->\n\n| x |', 'Kurze Zeile\n\n<!-- page 2 -->\n\nNeuer Absatz'])
      expect(joinSplitParagraphs(s)).toBe(s);
  });
});

describe('postprocess (marker-Ausgabe)', () => {
  const marker = [
    '',
    '{0}------------------------------------------------',
    '',
    '# Ein Paper über Dinge',
    '',
    '# Abstract',
    '',
    'Wie gezeigt [\\(Peters et al.,](#page-10-0) [2018a;](#page-10-0) [Rad](#page-10-1)[ford et al.,](#page-10-1) [2018\\)](#page-10-1), gilt $a_i = b_i$ für',
    '',
    '{1}------------------------------------------------',
    '',
    'alle Werte.[<sup>1</sup>](#page-2-1)',
    '',
    '# <span id="page-2-5"></span>1 Einleitung',
    '',
    '<span id="page-2-0"></span>![](_page_1_Figure_0.jpeg)',
    '',
    'Figure 1: Eine Abbildung.',
    '',
    '<span id="page-2-1"></span><sup>1</sup> https://example.org',
    '',
  ].join('\n');
  const images = new Map([['_page_1_Figure_0.jpeg', 'Ein Paper.assets/p2-figure-1.jpg']]);
  const out = postprocess(marker, { images, math: 'code', pageMarkers: true });

  it('räumt auf', () => {
    expect(out).toBe(
      [
        '<!-- page 1 -->',
        '',
        '# Ein Paper über Dinge',
        '',
        '## Abstract',
        '',
        'Wie gezeigt (Peters et al., 2018a; Radford et al., 2018), gilt `$a_i = b_i$` für alle Werte.<sup>1</sup>',
        '',
        '<!-- page 2 -->',
        '',
        '## 1 Einleitung',
        '',
        '![](Ein%20Paper.assets/p2-figure-1.jpg)',
        '',
        'Figure 1: Eine Abbildung.',
        '',
        '<sup>1</sup> https://example.org',
        '',
      ].join('\n'),
    );
  });

  it('wird im Review-Editor mit Bild, Seitenmarke und Formel gerendert', () => {
    const r = renderDocument(out, { defaultColor: 'gelb', resolveImage: (s) => 'vscode-resource:/doc/' + decodeURI(s) });
    expect(r.html).toContain('src="vscode-resource:/doc/Ein Paper.assets/p2-figure-1.jpg"');
    expect(r.html).toContain('class="page-mark"');
    expect(r.html).toContain('<code data-a=');
    expect(r.html).toContain('$a_i = b_i$');
    expect(r.html).not.toContain('<em>');
  });

  it('pymupdf4llm: Seitenende → Seitenanfang', () => {
    const s = postprocess('Eins.\n\n--- end of page.page_number=1 ---\n\nZwei.\n\n--- end of page.page_number=2 ---\n', { images: new Map(), math: 'code', pageMarkers: true });
    expect(s).toBe('<!-- page 1 -->\n\nEins.\n\n<!-- page 2 -->\n\nZwei.\n');
  });

  it('ohne Seitenmarken', () => {
    const s = postprocess(marker, { images, math: 'dollar', pageMarkers: false });
    expect(s).not.toContain('<!-- page');
    expect(s).toContain('$a_i = b_i$');
  });
});

describe('Ausgabedatei', () => {
  it('nimmt die .md mit dem Namen der PDF', () => {
    expect(pickMarkdown(['/t/a/a.md', '/t/a/notes.md', '/t/a/x.png'], 'a')).toBe('/t/a/a.md');
    expect(pickMarkdown(['/t/a/sub/deep.md', '/t/a/b.md'], 'zzz')).toBe('/t/a/b.md');
    expect(pickMarkdown(['/t/x.png'], 'a')).toBeUndefined();
  });
});

describe('Formel-Tabellen (marker)', () => {
  it('werden zu Blockformeln mit Nummer', () => {
    const s = formulaTables('Text:\n\n| Attention( $Q, K, V$ ) = softmax( $\\frac{QK^T}{\\sqrt{d_k}}$ )V | (1) |\n|---|---|\n|---|---|\n\nWeiter.');
    expect(s).toContain('$$\nAttention( Q, K, V ) = softmax( \\frac{QK^T}{\\sqrt{d_k}} )V \\tag{1}\n$$');
    expect(convertMath(s, 'code')).toContain('```math\nAttention( Q, K, V ) = softmax( \\frac{QK^T}{\\sqrt{d_k}} )V \\tag{1}\n```');
  });

  it('mehrzeilig ohne Nummer', () => {
    const s = formulaTables('| $PE_{(pos,2i)} = \\sin(x)$ |\n|---|\n| $PE_{(pos,2i+1)} = \\cos(x)$ |');
    expect(s.match(/\$\$/g)?.length).toBe(4);
  });

  it('echte Tabellen bleiben, doppelte Trennzeilen fallen weg', () => {
    expect(formulaTables('| a | b |\n|---|---|\n|---|---|\n| 1 | 2 |')).toBe('| a | b |\n|---|---|\n| 1 | 2 |');
    expect(formulaTables('| Kosten | $5 |\n|---|---|\n| x | y |')).toBe('| Kosten | $5 |\n|---|---|\n| x | y |');
  });
});
