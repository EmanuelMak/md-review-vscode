// PDF-Anzeige mit pdf.js und dem Knopf „In Markdown umwandeln“. Kein Framework. Seiten werden erst gezeichnet,
// wenn sie in Sichtweite kommen; die Umwandlung selbst läuft im Extension-Host (src/pdf.ts).
// @ts-check
// @ts-ignore
const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : window.__mockVscode;
const saved = vscode.getState() || {};

const app = /** @type {HTMLElement} */ (document.getElementById('app'));
app.innerHTML = `
  <div id="pdfbar" role="toolbar">
    <button id="convert" class="primary" title="Markdown-Datei mit Text, Abbildungen und Tabellen daneben anlegen und im Review-Editor öffnen">
      <span class="ico">⇢</span><span class="lbl">In Markdown umwandeln</span></button>
    <button id="cancel" hidden title="Umwandlung abbrechen">Abbrechen</button>
    <button id="openMd" hidden title="Vorhandene Markdown-Datei im Review-Editor öffnen">Markdown öffnen</button>
    <span id="status" aria-live="polite"></span>
    <span class="spacer"></span>
    <button id="zoomOut" title="Verkleinern (⌘−)">−</button>
    <button id="zoomFit" title="Seitenbreite (⌘0)">Breite</button>
    <button id="zoomIn" title="Vergrößern (⌘+)">+</button>
    <span id="pageInfo"></span>
  </div>
  <div id="pdfscroll"><div id="pages"></div><div id="pdfmsg"></div></div>`;

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
const scrollEl = $('pdfscroll');
const pagesEl = $('pages');
const statusEl = $('status');
const convertBtn = /** @type {HTMLButtonElement} */ ($('convert'));

/** @type {any} */
let pdf = null;
/** @type {{w:number,h:number}[]} */
let sizes = [];
/** null = Seitenbreite */
let zoom = typeof saved.zoom === 'number' ? saved.zoom : null;
let scale = 1;
/** @type {Map<number, any>} laufende Render-Tasks */
const tasks = new Map();
const rendered = new Set();

const post = (/** @type {any} */ m) => vscode.postMessage(m);

// Fehler der Anzeige ins Ausgabefenster „Markdown Review“ (Webview-Entwicklertools braucht man dann nicht)
window.addEventListener('securitypolicyviolation', (e) => post({ type: 'log', text: `CSP blockiert ${e.violatedDirective}: ${e.blockedURI}` }));
window.addEventListener('error', (e) => !/^ResizeObserver loop/.test(e.message) && post({ type: 'log', text: 'Fehler: ' + e.message }));
window.addEventListener('unhandledrejection', (e) => post({ type: 'log', text: 'Fehler: ' + (e.reason?.stack ?? e.reason) }));
for (const level of /** @type {const} */ (['warn', 'error'])) {
  const orig = console[level].bind(console);
  console[level] = (/** @type {any[]} */ ...args) => {
    orig(...args);
    post({ type: 'log', text: args.map(String).join(' ') });
  };
}

convertBtn.onclick = () => post({ type: 'convert' });
$('cancel').onclick = () => post({ type: 'cancel' });
$('openMd').onclick = () => post({ type: 'openMd' });
$('zoomIn').onclick = () => setZoom((zoom ?? scale) * 1.2);
$('zoomOut').onclick = () => setZoom((zoom ?? scale) / 1.2);
$('zoomFit').onclick = () => setZoom(null);
document.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey)) return;
  if (e.key === '+' || e.key === '=') setZoom((zoom ?? scale) * 1.2);
  else if (e.key === '-') setZoom((zoom ?? scale) / 1.2);
  else if (e.key === '0') setZoom(null);
  else return;
  e.preventDefault();
});

window.addEventListener('message', (ev) => {
  const m = ev.data;
  if (m.type === 'init') void load(m);
  else if (m.type === 'state') setState(m);
});
post({ type: 'ready' });

/** @param {{busy:boolean, text?:string, mdExists?:boolean}} m */
function setState(m) {
  convertBtn.disabled = m.busy;
  convertBtn.classList.toggle('busy', m.busy);
  $('cancel').hidden = !m.busy;
  if (m.mdExists !== undefined) $('openMd').hidden = !m.mdExists || m.busy;
  statusEl.textContent = m.text ?? '';
}

/** @param {{url:string, pdfjs:string, mdExists:boolean}} m */
async function load(m) {
  setState({ busy: false, mdExists: m.mdExists });
  const slow = setTimeout(() => {
    $('pdfmsg').textContent = 'PDF lädt noch … (Details im Ausgabefenster „Markdown Review“)';
    post({ type: 'log', text: 'pdf.js: nach 10 s noch nicht geladen' });
  }, 10000);
  try {
    const lib = await import(m.pdfjs + '/pdf.min.mjs');
    lib.GlobalWorkerOptions.workerSrc = m.pdfjs + '/pdf.worker.min.mjs';
    // Im VS-Code-Webview liegt der Worker auf einem anderen Ursprung; ein Worker von dort startet nicht
    // (pdf.js wartet dann endlos). Deshalb den Worker-Code holen und als blob: starten.
    try {
      const code = await (await fetch(m.pdfjs + '/pdf.worker.min.mjs')).text();
      const blobUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      lib.GlobalWorkerOptions.workerPort = new Worker(blobUrl, { type: 'module' });
    } catch (e) {
      post({ type: 'log', text: 'pdf.js-Worker als blob: fehlgeschlagen, nutze Standardweg: ' + e });
    }
    pdf = await lib.getDocument({
      url: m.url,
      cMapUrl: m.pdfjs + '/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: m.pdfjs + '/standard_fonts/',
      wasmUrl: m.pdfjs + '/wasm/',
      iccUrl: m.pdfjs + '/iccs/',
      isEvalSupported: false,
      // Fetches aus dem blob:-Worker laufen nicht über VS Codes Ressourcen-Service-Worker und hängen
      useWorkerFetch: false,
    }).promise;
  } catch (e) {
    const err = /** @type {any} */ (e);
    $('pdfmsg').textContent = 'PDF konnte nicht angezeigt werden: ' + (err?.message ?? err);
    post({ type: 'log', text: 'pdf.js: ' + (err?.stack ?? err) });
    return;
  } finally {
    clearTimeout(slow);
  }
  $('pdfmsg').textContent = '';
  sizes = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const vp = (await pdf.getPage(i)).getViewport({ scale: 1 });
    sizes.push({ w: vp.width, h: vp.height });
  }
  layout();
  if (saved.scrollRatio) scrollEl.scrollTop = saved.scrollRatio * scrollEl.scrollHeight;
  new ResizeObserver(() => zoom === null && layout()).observe(scrollEl);
}

function setZoom(/** @type {number|null} */ z) {
  const ratio = scrollEl.scrollTop / Math.max(1, scrollEl.scrollHeight);
  zoom = z === null ? null : Math.min(5, Math.max(0.25, z));
  vscode.setState({ ...vscode.getState(), zoom });
  layout();
  scrollEl.scrollTop = ratio * scrollEl.scrollHeight;
}

/** Platzhalter in der richtigen Größe anlegen; gezeichnet wird erst beim Sichtbarwerden. */
function layout() {
  if (!pdf) return;
  const maxW = Math.max(...sizes.map((s) => s.w));
  const fit = (scrollEl.clientWidth - 32) / maxW;
  const next = zoom ?? Math.max(0.25, Math.min(fit, 3));
  if (Math.abs(next - scale) < 0.001 && pagesEl.childElementCount === sizes.length) return;
  scale = next;
  for (const t of tasks.values()) t.cancel();
  tasks.clear();
  rendered.clear();
  pagesEl.textContent = '';
  observer.disconnect();
  sizes.forEach((s, i) => {
    const div = document.createElement('div');
    div.className = 'pdfpage';
    div.dataset.page = String(i + 1);
    div.style.width = `${Math.floor(s.w * scale)}px`;
    div.style.height = `${Math.floor(s.h * scale)}px`;
    pagesEl.appendChild(div);
    observer.observe(div);
  });
  updatePageInfo();
}

const observer = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      const n = Number(/** @type {HTMLElement} */ (e.target).dataset.page);
      if (e.isIntersecting) void renderPage(n, /** @type {HTMLElement} */ (e.target));
    }
  },
  { root: scrollEl, rootMargin: '600px 0px' },
);

async function renderPage(/** @type {number} */ n, /** @type {HTMLElement} */ div) {
  if (rendered.has(n) || tasks.has(n)) return;
  const page = await pdf.getPage(n);
  const dpr = window.devicePixelRatio || 1;
  const vp = page.getViewport({ scale: scale * dpr });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  const task = page.render({ canvas, viewport: vp });
  const slow = setTimeout(() => post({ type: 'log', text: `Seite ${n}: nach 10 s noch nicht gezeichnet` }), 10000);
  tasks.set(n, task);
  try {
    await task.promise;
    div.textContent = '';
    div.appendChild(canvas);
    rendered.add(n);
  } catch (e) {
    if (/** @type {any} */ (e)?.name !== 'RenderingCancelledException') post({ type: 'log', text: `Seite ${n}: ${e}` });
  } finally {
    clearTimeout(slow);
    tasks.delete(n);
  }
}

function updatePageInfo() {
  if (!pdf) return;
  const mid = scrollEl.scrollTop + scrollEl.clientHeight / 3;
  let n = 1;
  for (const el of /** @type {NodeListOf<HTMLElement>} */ (pagesEl.querySelectorAll('.pdfpage'))) {
    if (el.offsetTop <= mid) n = Number(el.dataset.page);
    else break;
  }
  $('pageInfo').textContent = `S. ${n} / ${pdf.numPages}`;
}

let scrollTimer = 0;
scrollEl.addEventListener('scroll', () => {
  updatePageInfo();
  clearTimeout(scrollTimer);
  scrollTimer = window.setTimeout(
    () => vscode.setState({ ...vscode.getState(), scrollRatio: scrollEl.scrollTop / Math.max(1, scrollEl.scrollHeight) }),
    200,
  );
});
