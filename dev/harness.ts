// Browser-Harness: bildet den Provider nach, damit die Webview ohne VS Code getestet werden kann.
import {
  allAction, commentOnly, deleteRanges, enterAt, highlight, insertAt, markerAction,
  replaceRanges, resolveMarkers, Result, setMarkerColor, setMarkerComment,
} from '../src/actions';
import { renderDocument } from '../src/render';

const config = {
  author: 'EM',
  colors: { gelb: '#ffe066', gruen: '#8ce99a', blau: '#74c0fc', rosa: '#faa2c1', orange: '#ffc078' },
  defaultColor: 'gelb',
  showGutter: true,
};
const ctx = { author: 'EM', defaultColor: 'gelb', colors: Object.keys(config.colors) };
const w = window as any;
let text: string = w.__initialText ?? '';
let version = 1;
let state: any = {};
const history: string[] = [];

function render(caret?: number) {
  const r = renderDocument(text, { defaultColor: ctx.defaultColor });
  window.postMessage({ type: 'render', v: version, html: r.html, markers: r.markers, stats: r.stats, config, inkBase: '', readonly: false, caret }, '*');
  const src = document.getElementById('src');
  if (src) src.textContent = text;
}

function run(fn: (t: string, map: (p: number) => number) => Result) {
  let t = text;
  let map = (p: number) => p;
  let r = fn(t, map);
  if ('conflicts' in r) {
    const accept = confirm('Konflikt: Vorschläge annehmen? (Abbrechen = ablehnen)');
    const res = resolveMarkers(t, r.conflicts, accept ? 'accept' : 'reject');
    map = (p) => res.map(p);
    t = res.text;
    r = fn(t, map);
  }
  if ('error' in r) { window.postMessage({ type: 'toast', text: r.error }, '*'); return render(); }
  if ('conflicts' in r) return render();
  if (r.text !== text) { history.push(text); text = r.text; version++; }
  setTimeout(() => render(r.caret), 10);
}

w.__mockVscode = {
  getState: () => state,
  setState: (s: any) => (state = s),
  postMessage(m: any) {
    w.__log = w.__log || [];
    w.__log.push(m);
    if ('v' in m && m.v !== version) { window.postMessage({ type: 'toast', text: 'Version veraltet' }, '*'); return render(); }
    const mr = (rs: any[], map: any) => rs.map((r) => ({ start: map(r.start), end: map(r.end) }));
    switch (m.type) {
      case 'ready': case 'rerender': return render();
      case 'insert': return run((t, map) => insertAt(t, map(m.at), m.text, ctx));
      case 'replace': return run((t, map) => replaceRanges(t, mr(m.ranges, map), m.text, ctx));
      case 'delete': return run((t, map) => deleteRanges(t, mr(m.ranges, map), m.dir, ctx));
      case 'enter': return run((t, map) => enterAt(t, map(m.at), ctx));
      case 'highlight': return run((t, map) => highlight(t, mr(m.ranges, map), m.color, ctx, m.comment));
      case 'commentOnly': return run((t, map) => commentOnly(t, map(m.at), m.text, m.color, ctx));
      case 'marker': return run((t) => markerAction(t, m.id, m.action, ctx));
      case 'markerColor': return run((t) => setMarkerColor(t, m.id, m.color, ctx));
      case 'markerComment': return run((t) => setMarkerComment(t, m.id, m.text, ctx));
      case 'all': if (confirm('Alle?')) run((t) => allAction(t, m.action, ctx)); return;
      case 'dictate': return mockDictation(m.action);
    }
  },
};
// Diktieren ohne Mikrofon: w.__dictationText bzw. w.__dictationError steuern das Ergebnis.
let dictTimer: any;
function mockDictation(action: 'start' | 'stop' | 'cancel') {
  const send = (m: any) => window.postMessage({ type: 'dictation', ...m }, '*');
  clearTimeout(dictTimer);
  if (action === 'start') dictTimer = setTimeout(() => send({ state: 'recording' }), 150);
  else if (action === 'stop') {
    send({ state: 'transcribing' });
    dictTimer = setTimeout(() => {
      if (w.__dictationError) send({ state: 'error', message: w.__dictationError });
      else send({ state: 'done', text: w.__dictationText ?? 'Das ist ein diktierter Kommentar.' });
    }, 400);
  }
}
w.__getText = () => text;
w.__setText = (t: string) => { text = t; version++; render(); };
w.__undo = () => { const t = history.pop(); if (t != null) { text = t; version++; render(); } };
document.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'z') { e.preventDefault(); w.__undo(); } }, true);
