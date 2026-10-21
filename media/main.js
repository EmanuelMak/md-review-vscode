// Webview des Markdown Review Mode. Kein Framework. Die Vorschau ist contenteditable, damit es einen
// echten Cursor gibt, aber jede Eingabe wird abgefangen und als Aktion an die Extension geschickt.
// Die Datei wird nie aus dem DOM zurückgeschrieben: Offsets stehen in data-s / data-a.
// @ts-check
(function () {
  // @ts-ignore
  const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : window.__mockVscode;
  const saved = vscode.getState() || {};

  /** @type {{v:number, markers:any[], config:any, activeColor:string|null, focusedId:number|null, busy:boolean, typeBuffer:string, mode:string, readonly:boolean, inkBase:string, busyTimer:any, composition:any, pendingBack:number, collapsed:boolean, gutterHidden:boolean, uiLoaded:boolean}} */
  const S = {
    v: -1,
    markers: [],
    config: { colors: {}, author: 'EM', defaultColor: 'gelb', showGutter: true },
    activeColor: saved.activeColor || null,
    focusedId: null,
    busy: false,
    typeBuffer: '',
    mode: saved.mode || 'markers',
    readonly: false,
    inkBase: '',
    busyTimer: null,
    composition: null,
    pendingBack: 0,
    collapsed: false,
    gutterHidden: false,
    uiLoaded: false,
  };

  // ------------------------------------------------------------------ Gerüst
  const app = /** @type {HTMLElement} */ (document.getElementById('app'));
  app.innerHTML = `
    <div id="toolbar" role="toolbar">
      <button class="tb-arrow" id="tbLeft" hidden title="Weiter links">‹</button>
      <div id="tbScroll">
        <div class="group" id="swatches" title="Farbe (1–5 ohne Cursor, ⌥1–⌥5 immer)"></div>
        <span class="sep"></span>
        <button data-act="highlight" title="Auswahl hervorheben (H)"><span class="ico">▍</span><span class="lbl">Markieren</span></button>
        <button data-act="comment" title="Auswahl hervorheben und kommentieren (K)"><span class="ico">💬</span><span class="lbl">Kommentar</span></button>
        <button data-act="commentOnly" title="Kommentar ohne Bezugstext an der Cursorposition (⌥K)"><span class="ico">✚</span><span class="lbl">Notiz</span></button>
        <button data-act="remove" title="Markierung am Cursor entfernen / Vorschlag ablehnen (Entf bei fokussierter Markierung)"><span class="ico">⌫</span><span class="lbl">Entfernen</span></button>
        <span class="sep"></span>
        <button data-act="acceptAll" title="Alle Vorschläge annehmen"><span class="ico">✓</span><span class="lbl">Alle annehmen</span></button>
        <button data-act="rejectAll" title="Alle Vorschläge ablehnen"><span class="ico">✗</span><span class="lbl">Alle ablehnen</span></button>
        <span class="sep"></span>
        <div class="seg" id="modes" title="Ansicht – ändert die Datei nicht">
          <button data-mode="original" title="Ohne Änderungsvorschläge">Original</button><button data-mode="markers" title="Mit allen Markern (bearbeiten)">Marker</button><button data-mode="accepted" title="Als wären alle Vorschläge angenommen">Angenommen</button>
        </div>
        <span class="sep"></span>
        <button data-act="gutter" id="gutterBtn" title="Randspalte mit Kommentaren ein/aus"><span class="ico">▥</span><span class="lbl">Rand</span></button>
        <button data-act="source" title="Quelltext daneben öffnen"><span class="ico">⟨⟩</span><span class="lbl">Quelltext</span></button>
        <span class="spacer"></span>
        <span id="stats"></span>
        <button id="author" data-act="settings" title="Autorenkürzel (Einstellung mdReview.author)"></button>
      </div>
      <button class="tb-arrow" id="tbRight" hidden title="Weiter rechts">›</button>
      <button id="collapse" data-act="collapse" title="Werkzeugleiste einklappen (⌥T)">⌃</button>
    </div>
    <button id="expand" hidden title="Werkzeugleiste ausklappen (⌥T)">☰</button>
    <div id="scroll">
      <div id="page">
        <div id="doc" spellcheck="false"></div>
        <div id="gutter"></div>
      </div>
    </div>
    <div id="hoverbar" hidden></div>
    <div id="popup" hidden></div>
    <div id="ctxmenu" hidden></div>
    <div id="toast" hidden></div>`;

  const $ = (/** @type {string} */ s) => /** @type {HTMLElement} */ (document.querySelector(s));
  const doc = $('#doc');
  const gutter = $('#gutter');
  const page = $('#page');
  const scroller = $('#scroll');
  const hoverbar = $('#hoverbar');
  const popup = $('#popup');
  const ctxmenu = $('#ctxmenu');
  const toastEl = $('#toast');

  const post = (/** @type {any} */ m) => vscode.postMessage(m);
  window.addEventListener('error', (e) => post({ type: 'log', text: `${e.message} @ ${e.lineno}:${e.colno}` }));
  window.addEventListener('unhandledrejection', (e) => post({ type: 'log', text: String(e.reason) }));
  const colorNames = () => Object.keys(S.config.colors);
  const activeColor = () => (S.activeColor && S.config.colors[S.activeColor] ? S.activeColor : S.config.defaultColor);
  const editable = () => !S.readonly && S.mode === 'markers';

  function persist() {
    vscode.setState({ activeColor: S.activeColor, mode: S.mode });
  }

  let toastTimer = 0;
  function toast(/** @type {string} */ text) {
    toastEl.textContent = text;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.hidden = true), 3200);
  }

  // ------------------------------------------------------------------ DOM ↔ Datei-Offsets

  /** @param {Element} el */
  const startOf = (el) => (el.hasAttribute('data-s') ? +(/** @type {any} */ (el).dataset.s) : +String(el.getAttribute('data-a')).split(',')[0]);
  /** @param {Element} el */
  const endOf = (el) =>
    el.hasAttribute('data-s') ? +(/** @type {any} */ (el).dataset.s) + (el.textContent || '').length : +String(el.getAttribute('data-a')).split(',')[1];

  /** zuordenbare Elemente eines Blocks in Dokumentreihenfolge (ohne verschachtelte) */
  function itemsOf(/** @type {Element} */ blk) {
    return [...blk.querySelectorAll('[data-s],[data-a]')].filter((el) => {
      const outer = el.parentElement && el.parentElement.closest('[data-a]');
      return !outer || !blk.contains(outer);
    });
  }

  function blockOf(/** @type {Node|null} */ node) {
    const el = node && (node.nodeType === 1 ? /** @type {Element} */ (node) : node.parentElement);
    return el ? el.closest('.blk[data-b]') : null;
  }

  /** DOM-Punkt → Datei-Offset (oder null außerhalb bearbeitbarer Blöcke) */
  function pointToOffset(/** @type {Node} */ node, /** @type {number} */ off) {
    const blk = blockOf(node);
    if (!blk) return null;
    let last = +(/** @type {any} */ (blk).dataset.from);
    for (const el of itemsOf(blk)) {
      const r = document.createRange();
      r.selectNodeContents(el);
      let cmp;
      try {
        cmp = r.comparePoint(node, off);
      } catch {
        continue;
      }
      if (cmp < 0) return startOf(el);
      if (cmp === 0) {
        const pre = document.createRange();
        pre.setStart(el, 0);
        pre.setEnd(node, off);
        const k = pre.toString().length;
        if (el.hasAttribute('data-s')) return startOf(el) + Math.min(k, (el.textContent || '').length);
        return k === 0 ? startOf(el) : endOf(el);
      }
      last = endOf(el);
    }
    return last;
  }

  function currentRange() {
    const sel = getSelection();
    if (!sel || !sel.rangeCount) return null;
    const r = sel.getRangeAt(0);
    if (!doc.contains(r.commonAncestorContainer)) return null;
    return r;
  }

  /** Auswahl → ein Bereich pro Block */
  function selectionRanges(range = currentRange()) {
    if (!range || range.collapsed) return [];
    /** @type {{start:number,end:number}[]} */
    const out = [];
    for (const b of doc.querySelectorAll('.blk[data-b]')) {
      if (!range.intersectsNode(b)) continue;
      const bd = /** @type {any} */ (b).dataset;
      const s = b.contains(range.startContainer) ? pointToOffset(range.startContainer, range.startOffset) : +bd.from;
      const e = b.contains(range.endContainer) ? pointToOffset(range.endContainer, range.endOffset) : +bd.to;
      if (s != null && e != null && e > s) out.push({ start: s, end: e });
    }
    return out;
  }

  function caretOffset() {
    const r = currentRange();
    if (!r || !r.collapsed) return null;
    return pointToOffset(r.startContainer, r.startOffset);
  }

  function rangeFromStatic(/** @type {StaticRange} */ sr) {
    const r = document.createRange();
    try {
      r.setStart(sr.startContainer, sr.startOffset);
      r.setEnd(sr.endContainer, sr.endOffset);
    } catch {
      return null;
    }
    return r;
  }

  /** Cursor an Datei-Offset setzen */
  function placeCaret(/** @type {number} */ off) {
    /** @type {{el:Element,k:number}|null} */
    let hit = null;
    /** @type {{el:Element,k:number}|null} */
    let atEnd = null;
    /** @type {{el:Element,k:number}|null} */
    let after = null;
    for (const el of doc.querySelectorAll('[data-s]')) {
      const s = startOf(el);
      const len = (el.textContent || '').length;
      if (off >= s && off < s + len) {
        hit = { el, k: off - s };
        break;
      }
      if (off === s + len && !atEnd) atEnd = { el, k: len };
      if (s > off && !after) after = { el, k: 0 };
    }
    const t = hit || atEnd || after;
    if (!t) return;
    const node = t.el.firstChild || t.el;
    const sel = getSelection();
    if (!sel) return;
    const r = document.createRange();
    r.setStart(node, node.nodeType === 3 ? t.k : 0);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  }

  // ------------------------------------------------------------------ Senden mit Puffer

  function send(/** @type {any} */ m) {
    S.busy = true;
    clearTimeout(S.busyTimer);
    S.busyTimer = setTimeout(() => {
      S.busy = false;
      S.typeBuffer = '';
      S.pendingBack = 0;
    }, 2500);
    post({ ...m, v: S.v });
  }

  function typeText(/** @type {string} */ text, /** @type {any} */ snapshot) {
    if (!editable()) return viewOnly();
    if (!text) return;
    text = text.replace(/\r/g, '').replace(/\n[ \t]*\n+/g, '\n');
    if (S.busy) {
      S.typeBuffer += text;
      return;
    }
    const ranges = snapshot ? snapshot.ranges : selectionRanges();
    if (ranges.length) return send({ type: 'replace', ranges, text });
    const at = snapshot ? snapshot.at : caretOffset();
    if (at == null) return toast('Erst in den Text klicken.');
    send({ type: 'insert', at, text });
  }

  function viewOnly() {
    toast(S.readonly ? 'Datei ist zu groß (> 2 MB): nur Vorschau.' : 'In dieser Ansicht kann nicht bearbeitet werden – auf „Mit Markern“ umschalten.');
  }

  // ------------------------------------------------------------------ Aktionen

  function doHighlight(/** @type {string=} */ color) {
    if (!editable()) return viewOnly();
    const ranges = selectionRanges();
    if (!ranges.length) {
      if (S.focusedId != null && markerById(S.focusedId)?.kind === 'highlight')
        return send({ type: 'markerColor', id: S.focusedId, color: color || activeColor() });
      return toast('Erst Text markieren.');
    }
    send({ type: 'highlight', ranges, color: color || activeColor() });
  }

  function doComment() {
    if (!editable()) return viewOnly();
    const range = currentRange();
    const ranges = selectionRanges(range);
    if (!ranges.length) {
      const m = S.focusedId != null ? markerById(S.focusedId) : null;
      if (m && (m.kind === 'highlight' || m.kind === 'comment')) return editComment(m.id);
      return toast('Erst Text markieren (oder ⌥K für einen Kommentar ohne Bezugstext).');
    }
    openPopup({
      title: 'Kommentar',
      rect: range ? range.getBoundingClientRect() : null,
      withColors: true,
      onSubmit: (/** @type {string} */ text, /** @type {string} */ color) =>
        send({ type: 'highlight', ranges, color, comment: text }),
    });
  }

  function doCommentOnly() {
    if (!editable()) return viewOnly();
    const range = currentRange();
    let at = caretOffset();
    if (at == null && range) {
      const rs = selectionRanges(range);
      if (rs.length) at = rs[rs.length - 1].end;
    }
    if (at == null) return toast('Erst den Cursor in den Text setzen.');
    const pos = at;
    openPopup({
      title: 'Kommentar ohne Bezugstext',
      rect: range ? range.getBoundingClientRect() : null,
      withColors: true,
      onSubmit: (/** @type {string} */ text, /** @type {string} */ color) => {
        if (text.trim()) send({ type: 'commentOnly', at: pos, text, color });
      },
    });
  }

  function editComment(/** @type {number} */ id) {
    const m = markerById(id);
    if (!m) return;
    const el = doc.querySelector(`[data-m="${id}"]`);
    openPopup({
      title: m.kind === 'comment' ? 'Kommentar bearbeiten' : 'Kommentar zur Hervorhebung',
      rect: el ? el.getBoundingClientRect() : null,
      initial: m.comment || '',
      onSubmit: (/** @type {string} */ text) => send({ type: 'markerComment', id, text }),
    });
  }

  function markerAction(/** @type {number} */ id, /** @type {'accept'|'reject'|'remove'} */ action) {
    if (!editable()) return viewOnly();
    S.focusedId = null;
    send({ type: 'marker', id, action });
  }

  /** Marker unter dem Cursor bzw. fokussiert */
  function markerAtCaret() {
    if (S.focusedId != null && markerById(S.focusedId)) return markerById(S.focusedId);
    const r = currentRange();
    const node = r ? r.startContainer : null;
    const el = node && (node.nodeType === 1 ? /** @type {Element} */ (node) : node.parentElement)?.closest('[data-m]');
    if (el) return markerById(+(/** @type {any} */ (el).dataset.m));
    const at = caretOffset();
    if (at != null) return S.markers.find((m) => m.start <= at && at <= m.end) || null;
    return null;
  }

  function removeAtCaret() {
    const m = markerAtCaret();
    if (!m) return toast('Kein Marker am Cursor. Auf eine Markierung klicken oder mit ⌥↓ ansteuern.');
    markerAction(m.id, m.suggestion ? 'reject' : 'remove');
  }

  const markerById = (/** @type {number} */ id) => S.markers.find((m) => m.id === id) || null;

  function setFocus(/** @type {number|null} */ id, scroll = false) {
    S.focusedId = id;
    doc.querySelectorAll('.focused').forEach((e) => e.classList.remove('focused'));
    gutter.querySelectorAll('.card.active').forEach((e) => e.classList.remove('active'));
    if (id == null) return;
    const el = doc.querySelector(`[data-m="${id}"]`);
    if (el) {
      el.classList.add('focused');
      if (scroll) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    gutter.querySelector(`.card[data-id="${id}"]`)?.classList.add('active');
  }

  function navigate(/** @type {1|-1} */ dir) {
    const els = [...doc.querySelectorAll('[data-m]')];
    if (!els.length) return toast('Keine Marker.');
    const ids = els.map((e) => +(/** @type {any} */ (e).dataset.m));
    let cur = S.focusedId;
    if (cur == null) {
      const at = caretOffset();
      cur = at == null ? (dir > 0 ? -1 : Infinity) : at;
    }
    const next = dir > 0 ? ids.find((i) => i > /** @type {number} */ (cur)) : [...ids].reverse().find((i) => i < /** @type {number} */ (cur));
    const target = next ?? (dir > 0 ? ids[0] : ids[ids.length - 1]);
    setFocus(target, true);
    const el = doc.querySelector(`[data-m="${target}"]`);
    if (el) showHoverbar(el);
  }

  function setColor(/** @type {string} */ name) {
    S.activeColor = name;
    persist();
    renderSwatches();
  }

  // ------------------------------------------------------------------ Eingaben

  doc.addEventListener('beforeinput', (e) => {
    e.preventDefault();
    if (S.composition) return;
    const t = e.inputType;
    if (t === 'insertText' || t === 'insertReplacementText' || t === 'insertFromPaste') {
      const text = e.data ?? e.dataTransfer?.getData('text/plain') ?? '';
      typeText(text);
    } else if (t === 'insertParagraph' || t === 'insertLineBreak') {
      if (!editable()) return viewOnly();
      if (S.busy) {
        S.typeBuffer += '\n';
        return;
      }
      const at = caretOffset();
      if (at != null) send({ type: 'enter', at });
    } else if (t.startsWith('delete')) {
      onDelete(e);
    }
    // alles andere (Formatierung, historyUndo …) ignorieren; Undo kommt von VS Code
  });

  function onDelete(/** @type {InputEvent} */ e) {
    if (!editable()) return viewOnly();
    const back = !/Forward/.test(e.inputType);
    if (S.busy) {
      // während die Extension noch schreibt: im Puffer verrechnen oder nachholen
      if (back && S.typeBuffer) S.typeBuffer = S.typeBuffer.slice(0, -1);
      else if (back) S.pendingBack++;
      return;
    }
    let ranges = selectionRanges();
    if (!ranges.length) {
      const sr = e.getTargetRanges()[0];
      const r = sr ? rangeFromStatic(sr) : null;
      if (r) ranges = selectionRanges(r);
    }
    if (!ranges.length) return;
    send({ type: 'delete', ranges, dir: back ? 'back' : 'fwd' });
  }

  doc.addEventListener('compositionstart', () => {
    S.composition = { ranges: selectionRanges(), at: caretOffset() };
  });
  doc.addEventListener('compositionend', (e) => {
    const snap = S.composition;
    S.composition = null;
    if (e.data) typeText(e.data, snap);
    else post({ type: 'rerender' });
  });

  doc.addEventListener('paste', (e) => {
    e.preventDefault();
    typeText(e.clipboardData?.getData('text/plain') || '');
  });
  doc.addEventListener('cut', (e) => {
    e.preventDefault();
    const sel = getSelection();
    e.clipboardData?.setData('text/plain', sel ? sel.toString() : '');
    if (!editable()) return;
    const ranges = selectionRanges();
    if (ranges.length) send({ type: 'delete', ranges, dir: 'fwd' });
  });
  doc.addEventListener('dragstart', (e) => e.preventDefault());
  doc.addEventListener('drop', (e) => e.preventDefault());

  document.addEventListener('keydown', (e) => {
    if (!popup.hidden || e.isComposing) return;
    const mod = e.metaKey || e.ctrlKey;
    if (!ctxmenu.hidden && e.key === 'Escape') return hideMenu();
    if (e.key === 'Escape') {
      hideHoverbar();
      setFocus(null);
      getSelection()?.removeAllRanges();
      return;
    }
    if (mod && e.key === 'Enter') {
      e.preventDefault();
      const m = markerAtCaret();
      if (m && m.suggestion) markerAction(m.id, 'accept');
      else toast('Kein Vorschlag am Cursor.');
      return;
    }
    if (e.altKey && !mod) {
      if (e.code === 'KeyH') {
        e.preventDefault();
        return doHighlight();
      }
      if (e.code === 'KeyK') {
        e.preventDefault();
        return selectionRanges().length && !e.shiftKey ? doComment() : doCommentOnly();
      }
      const d = /^Digit([1-9])$/.exec(e.code);
      if (d) {
        e.preventDefault();
        const name = colorNames()[+d[1] - 1];
        if (name) {
          setColor(name);
          if (selectionRanges().length) doHighlight(name);
        }
        return;
      }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') e.preventDefault(); // Navigation über VS Code-Keybinding
      return;
    }
    if (mod) return;
    const hasSel = selectionRanges().length > 0;
    if (hasSel && editable()) {
      const k = e.key.toLowerCase();
      if (k === 'h') {
        e.preventDefault();
        return doHighlight();
      }
      if (k === 'k') {
        e.preventDefault();
        return doComment();
      }
    }
    // Ziffern wählen die Farbe, solange kein Cursor im Text steht
    if (/^[1-9]$/.test(e.key) && !currentRange()) {
      const name = colorNames()[+e.key - 1];
      if (name) {
        e.preventDefault();
        setColor(name);
      }
      return;
    }
    if ((e.key === 'Backspace' || e.key === 'Delete') && S.focusedId != null && !hasSel) {
      const m = markerById(S.focusedId);
      if (m && (!m.suggestion || !currentRange() || isFocusedOnly(m))) {
        e.preventDefault();
        markerAction(m.id, m.suggestion ? 'reject' : 'remove');
        return;
      }
    }
    // Tabellen und Code: kein Tippen, nur Hervorheben/Kommentieren
    const typing = e.key.length === 1 || e.key === 'Backspace' || e.key === 'Delete' || e.key === 'Enter';
    if (typing && inReadonlyArea()) {
      e.preventDefault();
      toast('In Tabellen und Codeblöcken geht nur Hervorheben und Kommentieren: Text markieren → H oder K.');
    }
  });

  function inReadonlyArea() {
    const r = currentRange();
    const n = r && r.startContainer;
    const el = n && (n.nodeType === 1 ? /** @type {Element} */ (n) : n.parentElement);
    return !!el && !!el.closest('.ro');
  }

  /** Bei Vorschlägen löscht Backspace normal, außer der Vorschlag wurde gezielt (⌥↓, Karte) fokussiert. */
  function isFocusedOnly(/** @type {any} */ m) {
    return focusVia === 'nav' && S.focusedId === m.id;
  }
  let focusVia = '';

  // Fokus einer angeklickten Markierung lösen, sobald der Cursor sie verlässt
  document.addEventListener('selectionchange', () => {
    if (S.focusedId == null || focusVia !== 'click') return;
    const r = currentRange();
    const el = doc.querySelector(`[data-m="${S.focusedId}"]`);
    if (r && el && !el.contains(r.startContainer)) setFocus(null);
  });

  // Klicks auf Marker: Hervorhebungen und Kommentare fokussieren
  doc.addEventListener('click', (e) => {
    hideMenu();
    const el = /** @type {Element} */ (e.target).closest('[data-m]');
    if (el && (el.classList.contains('cm-hl') || el.classList.contains('cm-com'))) {
      focusVia = 'click';
      setFocus(+(/** @type {any} */ (el).dataset.m));
      if (el.classList.contains('cm-com')) editComment(+(/** @type {any} */ (el).dataset.m));
    } else {
      setFocus(null);
    }
  });

  // ------------------------------------------------------------------ Hover-Leiste
  let hoverTimer = 0;
  /** @type {Element|null} */
  let hoverEl = null;

  doc.addEventListener('mouseover', (e) => {
    const el = /** @type {Element} */ (e.target).closest('[data-m]');
    if (el && el !== hoverEl) showHoverbar(el);
    if (el) clearTimeout(hoverTimer);
  });
  doc.addEventListener('mouseout', (e) => {
    const el = /** @type {Element} */ (e.target).closest('[data-m]');
    if (el) scheduleHideHoverbar();
  });
  hoverbar.addEventListener('mouseenter', () => clearTimeout(hoverTimer));
  hoverbar.addEventListener('mouseleave', scheduleHideHoverbar);
  hoverbar.addEventListener('mousedown', (e) => e.preventDefault());

  function scheduleHideHoverbar() {
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(hideHoverbar, 500);
  }
  function hideHoverbar() {
    hoverbar.hidden = true;
    hoverEl = null;
  }

  function showHoverbar(/** @type {Element} */ el) {
    if (S.mode !== 'markers') return;
    const id = +(/** @type {any} */ (el).dataset.m);
    const m = markerById(id);
    if (!m) return;
    hoverEl = el;
    let html = '';
    if (m.suggestion) {
      const label = { insert: 'Einfügung', delete: 'Löschung', subst: 'Ersetzung' }[/** @type {'insert'} */ (m.kind)];
      html = `<span class="hb-label">${label}</span><button data-hb="accept" title="Annehmen (⌘↵)">✓ Annehmen</button><button data-hb="reject" title="Ablehnen">✗ Ablehnen</button>`;
    } else {
      const sw = colorNames()
        .map((n) => `<button class="sw${n === m.color ? ' on' : ''}" data-hb="color" data-color="${n}" title="${n}" style="--hl: var(--c-${n})"></button>`)
        .join('');
      html =
        (m.kind === 'highlight' ? `<span class="hb-colors">${sw}</span>` : '') +
        `<button data-hb="comment">${m.comment ? '✎ Kommentar' : '💬 Kommentar'}</button>` +
        `<button data-hb="remove" title="Markierung entfernen (Entf)">⌫ Entfernen</button>`;
    }
    hoverbar.innerHTML = html;
    hoverbar.hidden = false;
    const r = el.getBoundingClientRect();
    const rects = el.getClientRects();
    const first = rects[0] || r;
    const hb = hoverbar.getBoundingClientRect();
    let top = first.top - hb.height - 6;
    const minTop = (S.collapsed ? 0 : $('#toolbar').getBoundingClientRect().bottom) + 4;
    if (top < minTop) top = r.bottom + 6;
    const left = Math.max(8, Math.min(first.left, window.innerWidth - hb.width - 8));
    hoverbar.style.top = `${top}px`;
    hoverbar.style.left = `${left}px`;
    hoverbar.dataset.id = String(id);
  }

  hoverbar.addEventListener('click', (e) => {
    const b = /** @type {HTMLElement} */ (e.target).closest('[data-hb]');
    if (!b) return;
    const id = +(hoverbar.dataset.id || -1);
    const act = /** @type {HTMLElement} */ (b).dataset.hb;
    hideHoverbar();
    if (act === 'accept' || act === 'reject' || act === 'remove') markerAction(id, act);
    else if (act === 'color') {
      if (!editable()) return viewOnly();
      send({ type: 'markerColor', id, color: /** @type {HTMLElement} */ (b).dataset.color });
    } else if (act === 'comment') editComment(id);
  });

  // ------------------------------------------------------------------ Popup (Kommentar-Eingabe)
  /** @type {any} */
  let popupState = null;

  function openPopup(/** @type {any} */ o) {
    hideHoverbar();
    if (dict.state !== 'idle') post({ type: 'dictate', action: 'cancel' });
    dict.state = 'idle';
    popupState = { ...o, color: activeColor() };
    const sw = o.withColors
      ? `<div class="pp-colors">${colorNames()
          .map((n, i) => `<button class="sw${n === popupState.color ? ' on' : ''}" data-color="${n}" title="${i + 1}: ${n}" style="--hl: var(--c-${n})"></button>`)
          .join('')}</div>`
      : '';
    popup.innerHTML = `<div class="pp-head"><span>${o.title}</span>${sw}</div>
      <textarea rows="3" placeholder="Kommentar … (Enter speichert, Shift+Enter neue Zeile, ⌥M diktiert, Esc bricht ab)"></textarea>
      <div class="pp-foot"><button data-pp="mic" class="mic" title="Diktieren (⌥M)"><span class="mic-ico">🎙</span><span class="mic-lbl"></span></button><span class="hint">${S.config.author}</span><button data-pp="cancel">Abbrechen</button><button data-pp="ok" class="primary">Speichern</button></div>`;
    popup.hidden = false;
    const ta = /** @type {HTMLTextAreaElement} */ (popup.querySelector('textarea'));
    ta.value = o.initial || '';
    const rect = o.rect && o.rect.width + o.rect.height > 0 ? o.rect : { left: window.innerWidth / 2 - 160, bottom: 120, top: 120 };
    const pr = popup.getBoundingClientRect();
    let top = rect.bottom + 8;
    if (top + pr.height > window.innerHeight - 8) top = Math.max(48, rect.top - pr.height - 8);
    popup.style.top = `${top}px`;
    popup.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - pr.width - 8))}px`;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }

  function closePopup() {
    if (dict.state !== 'idle') post({ type: 'dictate', action: 'cancel' });
    setDict('idle');
    popup.hidden = true;
    popupState = null;
    doc.focus({ preventScroll: true });
  }

  function submitPopup() {
    if (!popupState) return;
    if (dict.state !== 'idle') return toggleDictation();
    const ta = /** @type {HTMLTextAreaElement} */ (popup.querySelector('textarea'));
    const st = popupState;
    closePopup();
    st.onSubmit(ta.value.replace(/\n[ \t]*\n+/g, '\n').trim(), st.color);
  }

  popup.addEventListener('keydown', (e) => {
    if (e.altKey && !e.metaKey && !e.ctrlKey && e.code === 'KeyM') {
      e.preventDefault();
      toggleDictation();
    } else if (e.key === 'Escape' && dict.state !== 'idle') {
      e.preventDefault();
      cancelDictation();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closePopup();
    } else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submitPopup();
    } else if (e.altKey && /^Digit[1-9]$/.test(e.code) && popupState?.withColors) {
      e.preventDefault();
      const n = colorNames()[+e.code.slice(5) - 1];
      if (n) pickPopupColor(n);
    }
  });
  popup.addEventListener('click', (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    const b = /** @type {HTMLElement | null} */ (t.closest('[data-pp]'));
    if (b?.dataset.pp === 'mic') toggleDictation();
    else if (t.dataset.pp === 'cancel') closePopup();
    else if (t.dataset.pp === 'ok') submitPopup();
    else if (t.dataset.color) pickPopupColor(t.dataset.color);
  });
  function pickPopupColor(/** @type {string} */ n) {
    if (!popupState) return;
    popupState.color = n;
    popup.querySelectorAll('.sw').forEach((b) => b.classList.toggle('on', /** @type {HTMLElement} */ (b).dataset.color === n));
    popup.querySelector('textarea')?.focus();
  }

  // ------------------------------------------------------------------ Diktieren
  // Aufnahme und Transkription laufen im Extension-Host (Webviews haben kein Mikrofon). Ablauf:
  // idle → starting → recording → transcribing → idle; das Ergebnis landet an der Cursorposition der Textarea.
  const dict = { state: 'idle', t0: 0, timer: /** @type {any} */ (null) };

  function toggleDictation() {
    if (!popupState) return;
    if (dict.state === 'idle') {
      setDict('starting');
      post({ type: 'dictate', action: 'start' });
    } else if (dict.state === 'recording') {
      setDict('transcribing');
      post({ type: 'dictate', action: 'stop' });
    }
    popup.querySelector('textarea')?.focus();
  }

  function cancelDictation() {
    post({ type: 'dictate', action: 'cancel' });
    setDict('idle');
    popup.querySelector('textarea')?.focus();
  }

  function setDict(/** @type {string} */ state) {
    dict.state = state;
    clearInterval(dict.timer);
    const btn = /** @type {HTMLElement | null} */ (popup.querySelector('[data-pp="mic"]'));
    const hint = /** @type {HTMLElement | null} */ (popup.querySelector('.pp-foot .hint'));
    if (!btn || !hint) return;
    btn.className = `mic ${state}`;
    const lbl = /** @type {HTMLElement} */ (btn.querySelector('.mic-lbl'));
    const texts = {
      idle: ['', 'Diktieren (⌥M)', S.config.author],
      starting: ['…', 'Aufnahme startet', 'Mikrofon wird geöffnet …'],
      recording: ['Stopp', 'Aufnahme beenden (Enter oder ⌥M), Esc verwirft', ''],
      transcribing: ['…', 'Wird transkribiert (Esc bricht ab)', 'Transkribiere …'],
    };
    const [l, title, h] = texts[/** @type {'idle'} */ (state)] || texts.idle;
    lbl.textContent = l;
    btn.title = title;
    hint.textContent = h;
    hint.classList.toggle('live', state !== 'idle');
    if (state === 'recording') {
      dict.t0 = Date.now();
      const tick = () => {
        const sec = Math.floor((Date.now() - dict.t0) / 1000);
        hint.textContent = `● ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')} · Enter stoppt`;
      };
      tick();
      dict.timer = setInterval(tick, 500);
    }
  }

  function onDictation(/** @type {any} */ m) {
    if (!popupState || dict.state === 'idle') return;
    if (m.state === 'recording' || m.state === 'transcribing') return setDict(m.state);
    setDict('idle');
    if (m.state === 'error') return toast(m.message);
    if (m.state !== 'done' || !m.text) return;
    const ta = /** @type {HTMLTextAreaElement} */ (popup.querySelector('textarea'));
    const before = ta.value.slice(0, ta.selectionStart);
    const after = ta.value.slice(ta.selectionEnd);
    const pre = before && !/\s$/.test(before) ? ' ' : '';
    const postSp = after && !/^[\s.,;:!?]/.test(after) ? ' ' : '';
    ta.value = before + pre + m.text + postSp + after;
    const caret = before.length + pre.length + m.text.length;
    ta.focus();
    ta.setSelectionRange(caret, caret);
  }

  // ------------------------------------------------------------------ Kontextmenü
  doc.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const target = /** @type {Element} */ (e.target).closest('[data-m]');
    const m = target ? markerById(+(/** @type {any} */ (target).dataset.m)) : null;
    const hasSel = selectionRanges().length > 0;
    /** @type {[string,string][]} */
    const items = [];
    if (hasSel) {
      items.push(['highlight', `Hervorheben (${activeColor()})  H`]);
      for (const n of colorNames()) if (n !== activeColor()) items.push([`hl:${n}`, `Hervorheben: ${n}`]);
      items.push(['comment', 'Kommentieren …  K']);
      items.push(['delete', 'Löschung vorschlagen  ⌫']);
    }
    if (m) {
      if (items.length) items.push(['-', '']);
      if (m.suggestion) {
        items.push([`accept:${m.id}`, 'Vorschlag annehmen  ⌘↵']);
        items.push([`reject:${m.id}`, 'Vorschlag ablehnen']);
      } else {
        items.push([`edit:${m.id}`, m.comment ? 'Kommentar bearbeiten …' : 'Kommentar hinzufügen …']);
        items.push([`remove:${m.id}`, 'Markierung entfernen']);
      }
    }
    if (!hasSel) {
      if (items.length) items.push(['-', '']);
      items.push(['commentOnly', 'Kommentar hier …  ⌥K']);
    }
    items.push(['-', '']);
    items.push(['source', 'Quelltext daneben anzeigen']);
    ctxmenu.innerHTML = items
      .map(([k, l]) => (k === '-' ? '<hr>' : `<button data-cm="${k}">${l.replace(/  (.+)$/, '<kbd>$1</kbd>')}</button>`))
      .join('');
    ctxmenu.hidden = false;
    const r = ctxmenu.getBoundingClientRect();
    ctxmenu.style.left = `${Math.min(e.clientX, window.innerWidth - r.width - 6)}px`;
    ctxmenu.style.top = `${Math.min(e.clientY, window.innerHeight - r.height - 6)}px`;
  });
  ctxmenu.addEventListener('mousedown', (e) => e.preventDefault());
  ctxmenu.addEventListener('click', (e) => {
    const b = /** @type {HTMLElement} */ (e.target).closest('[data-cm]');
    if (!b) return;
    const k = /** @type {string} */ (/** @type {HTMLElement} */ (b).dataset.cm);
    hideMenu();
    const [a, arg] = k.split(':');
    if (a === 'highlight') doHighlight();
    else if (a === 'hl') doHighlight(arg);
    else if (a === 'comment') doComment();
    else if (a === 'delete') {
      if (!editable()) return viewOnly();
      send({ type: 'delete', ranges: selectionRanges(), dir: 'fwd' });
    } else if (a === 'accept' || a === 'reject' || a === 'remove') markerAction(+arg, a);
    else if (a === 'edit') editComment(+arg);
    else if (a === 'commentOnly') doCommentOnly();
    else if (a === 'source') post({ type: 'showSource' });
  });
  function hideMenu() {
    ctxmenu.hidden = true;
  }
  document.addEventListener('mousedown', (e) => {
    if (!ctxmenu.contains(/** @type {Node} */ (e.target))) hideMenu();
  });
  scroller.addEventListener('scroll', () => {
    hideMenu();
    hideHoverbar();
  });

  // ------------------------------------------------------------------ Toolbar
  const toolbar = $('#toolbar');
  toolbar.addEventListener('mousedown', (e) => {
    // Auswahl im Text behalten
    if (/** @type {HTMLElement} */ (e.target).closest('button')) e.preventDefault();
  });
  toolbar.addEventListener('click', (e) => {
    const b = /** @type {HTMLElement} */ (e.target).closest('button');
    if (!b) return;
    if (b.dataset.color) {
      setColor(b.dataset.color);
      if (selectionRanges().length) doHighlight(b.dataset.color);
      else if (S.focusedId != null && markerById(S.focusedId)?.kind === 'highlight') doHighlight(b.dataset.color);
      return;
    }
    if (b.dataset.mode) return setMode(b.dataset.mode);
    switch (b.dataset.act) {
      case 'highlight':
        return doHighlight();
      case 'comment':
        return doComment();
      case 'commentOnly':
        return doCommentOnly();
      case 'remove':
        return removeAtCaret();
      case 'acceptAll':
        return post({ type: 'all', action: 'accept' });
      case 'rejectAll':
        return post({ type: 'all', action: 'reject' });
      case 'source':
        return post({ type: 'showSource' });
      case 'settings':
        return post({ type: 'openSettings' });
      case 'gutter':
        S.gutterHidden = !S.gutterHidden;
        applyUi(true);
        return;
      case 'collapse':
        return setCollapsed(true);
    }
  });

  function renderSwatches() {
    const el = $('#swatches');
    el.innerHTML = colorNames()
      .map(
        (n, i) =>
          `<button class="sw${n === activeColor() ? ' on' : ''}" data-color="${n}" title="${i + 1}: ${n}" style="--hl: var(--c-${n})"><span>${i + 1}</span></button>`,
      )
      .join('');
  }

  function setMode(/** @type {string} */ mode) {
    S.mode = mode;
    persist();
    document.body.dataset.mode = mode;
    doc.contentEditable = editable() ? 'true' : 'false';
    $('#modes')
      .querySelectorAll('button')
      .forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
    hideHoverbar();
    requestAnimationFrame(layoutGutter);
  }

  // ------------------------------------------------------------------ Randspalte
  const escHtml = (/** @type {string} */ s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function renderGutter() {
    document.body.classList.toggle('no-gutter', !S.config.showGutter || S.gutterHidden);
    const cards = S.markers.filter((m) => (m.kind === 'highlight' || m.kind === 'comment') && ((m.comment && m.comment.trim()) || m.ink));
    gutter.innerHTML = cards
      .map((m) => {
        const ink = m.ink
          ? `<img class="ink" src="${escHtml(S.inkBase)}/${escHtml(m.ink)}.svg" alt="Handschrift ${escHtml(m.ink)}" data-png="${escHtml(S.inkBase)}/${escHtml(m.ink)}.png">`
          : '';
        const meta = [m.page ? escHtml(m.page.replace('p.', 'S. ')) : '', m.ink ? 'Handschrift' + (m.comment ? ' (transkribiert)' : '') : '']
          .filter(Boolean)
          .join(' · ');
        return `<div class="card" data-id="${m.id}" style="--hl: var(--c-${escHtml(m.color || S.config.defaultColor)})" title="Klick: zur Stelle · Doppelklick: bearbeiten">
          <div class="card-head"><span class="dot"></span><b>${escHtml(m.author || '')}</b><span class="meta">${meta}</span></div>
          ${m.comment ? `<div class="card-body">${escHtml(m.comment)}</div>` : ''}${ink}</div>`;
      })
      .join('');
    gutter.querySelectorAll('img.ink').forEach((img) =>
      img.addEventListener('error', function onErr() {
        const i = /** @type {HTMLImageElement} */ (img);
        if (i.dataset.png && !i.src.endsWith('.png')) i.src = i.dataset.png;
        else i.replaceWith(Object.assign(document.createElement('div'), { className: 'ink-missing', textContent: 'Bild nicht gefunden' }));
      }),
    );
    layoutGutter();
  }

  function layoutGutter() {
    const base = gutter.getBoundingClientRect().top;
    let lastBottom = 0;
    const cards = [...gutter.querySelectorAll('.card')].map((c) => {
      const id = /** @type {HTMLElement} */ (c).dataset.id;
      const anchor = doc.querySelector(`[data-m="${id}"]`);
      const top = anchor ? anchor.getBoundingClientRect().top - base : 0;
      return { c: /** @type {HTMLElement} */ (c), top, visible: !!anchor && /** @type {HTMLElement} */ (anchor).offsetParent !== null };
    });
    cards.sort((a, b) => a.top - b.top);
    for (const x of cards) {
      x.c.style.display = x.visible ? '' : 'none';
      if (!x.visible) continue;
      const y = Math.max(x.top, lastBottom + 6);
      x.c.style.top = `${y}px`;
      lastBottom = y + x.c.offsetHeight;
    }
    gutter.style.minHeight = `${lastBottom}px`;
  }

  gutter.addEventListener('click', (e) => {
    const c = /** @type {HTMLElement} */ (e.target).closest('.card');
    if (!c) return;
    focusVia = 'nav';
    setFocus(+(/** @type {any} */ (c).dataset.id), true);
  });
  gutter.addEventListener('dblclick', (e) => {
    const c = /** @type {HTMLElement} */ (e.target).closest('.card');
    if (c) editComment(+(/** @type {any} */ (c).dataset.id));
  });
  new ResizeObserver(() => layoutGutter()).observe(doc);

  // ------------------------------------------------------------------ Nachrichten von der Extension
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (m.type === 'render') onRender(m);
    else if (m.type === 'toast') toast(m.text);
    else if (m.type === 'dictation') onDictation(m);
    else if (m.type === 'command') {
      if (m.name === 'next') {
        focusVia = 'nav';
        navigate(1);
      } else if (m.name === 'prev') {
        focusVia = 'nav';
        navigate(-1);
      } else if (m.name === 'accept' || m.name === 'reject') {
        const mk = markerAtCaret();
        if (mk && mk.suggestion) markerAction(mk.id, m.name);
        else toast('Kein Vorschlag am Cursor.');
      }
    }
  });

  function onRender(/** @type {any} */ m) {
    const hadFocus = document.activeElement === doc;
    const prevCaret = m.caret == null ? caretOffset() : null;
    const scrollTop = scroller.scrollTop;
    S.v = m.v;
    S.markers = m.markers;
    S.config = m.config;
    S.readonly = m.readonly;
    S.inkBase = m.inkBase;
    const root = document.documentElement;
    for (const [n, hex] of Object.entries(S.config.colors)) root.style.setProperty(`--c-${n}`, String(hex));
    doc.innerHTML = m.html;
    renderSwatches();
    setMode(S.mode);
    $('#author').textContent = S.config.author;
    const st = m.stats;
    $('#stats').textContent = `💬 ${st.comments}  ± ${st.suggestions}  ▍ ${st.highlights}`;
    $('#stats').title = `${st.comments} Kommentare · ${st.suggestions} Vorschläge · ${st.highlights} Hervorhebungen`;
    if (!S.uiLoaded && m.ui) {
      S.collapsed = !!m.ui.toolbarCollapsed;
      S.gutterHidden = !!m.ui.gutterHidden;
    }
    S.uiLoaded = true;
    applyUi(false);
    renderGutter();
    scroller.scrollTop = scrollTop;
    if (S.focusedId != null && !markerById(S.focusedId)) S.focusedId = null;
    setFocus(S.focusedId);
    hideHoverbar();
    const caret = m.caret ?? prevCaret;
    if (caret != null && editable() && (hadFocus || m.caret != null)) {
      doc.focus({ preventScroll: true });
      placeCaret(caret);
    }
    S.busy = false;
    clearTimeout(S.busyTimer);
    if (S.pendingBack && editable()) {
      const n = S.pendingBack;
      S.pendingBack = 0;
      const sel = getSelection();
      if (sel && currentRange()) {
        for (let i = 0; i < n; i++) /** @type {any} */ (sel).modify('extend', 'backward', 'character');
        const ranges = selectionRanges();
        if (ranges.length) return send({ type: 'delete', ranges, dir: 'back' });
      }
    }
    if (S.typeBuffer) {
      const buf = S.typeBuffer;
      S.typeBuffer = '';
      if (buf === '\n') {
        const at = caretOffset();
        if (at != null) send({ type: 'enter', at });
      } else typeText(buf);
    }
  }

  // ------------------------------------------------------------------ Einklappen, Randspalte, Querscrollen
  const tbScroll = $('#tbScroll');
  const tbLeft = $('#tbLeft');
  const tbRight = $('#tbRight');
  const expandBtn = $('#expand');

  /** Zustand anzeigen; `save`: an die Extension melden, damit er für alle Dateien gilt */
  function applyUi(/** @type {boolean} */ save) {
    document.body.classList.toggle('tb-collapsed', S.collapsed);
    expandBtn.hidden = !S.collapsed;
    document.body.classList.toggle('no-gutter', !S.config.showGutter || S.gutterHidden);
    $('#gutterBtn').classList.toggle('on', !S.gutterHidden && S.config.showGutter);
    if (save) post({ type: 'ui', ui: { toolbarCollapsed: S.collapsed, gutterHidden: S.gutterHidden } });
    requestAnimationFrame(() => {
      updateArrows();
      layoutGutter();
    });
  }

  function setCollapsed(/** @type {boolean} */ c) {
    S.collapsed = c;
    hideHoverbar();
    applyUi(true);
  }

  function updateArrows() {
    const max = tbScroll.scrollWidth - tbScroll.clientWidth;
    tbLeft.hidden = tbScroll.scrollLeft <= 1;
    tbRight.hidden = tbScroll.scrollLeft >= max - 1;
  }

  tbScroll.addEventListener('scroll', updateArrows);
  new ResizeObserver(updateArrows).observe(tbScroll);
  tbScroll.addEventListener(
    'wheel',
    (e) => {
      // Mausrad scrollt die Leiste quer
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && tbScroll.scrollWidth > tbScroll.clientWidth) {
        tbScroll.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    },
    { passive: false },
  );
  tbLeft.addEventListener('click', () => tbScroll.scrollBy({ left: -220, behavior: 'smooth' }));
  tbRight.addEventListener('click', () => tbScroll.scrollBy({ left: 220, behavior: 'smooth' }));
  expandBtn.addEventListener('mousedown', (e) => e.preventDefault());
  expandBtn.addEventListener('click', () => setCollapsed(false));
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.altKey && !e.metaKey && !e.ctrlKey && e.code === 'KeyT') {
        e.preventDefault();
        e.stopPropagation();
        setCollapsed(!S.collapsed);
      }
    },
    true,
  );

  setMode(S.mode);
  post({ type: 'ready' });
})();
