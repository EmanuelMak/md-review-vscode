// CustomTextEditorProvider: verbindet Webview und TextDocument. Jede Aktion wird als ein WorkspaceEdit
// geschrieben, damit Undo/Redo von VS Code kommt und die .md-Datei die einzige Wahrheit bleibt.

import * as vscode from 'vscode';
import * as path from 'node:path';
import {
  allAction,
  AllAction,
  commentOnly,
  ConflictChoice,
  Ctx,
  deleteRanges,
  Dir,
  enterAt,
  highlight,
  insertAt,
  markerAction,
  MarkerAction,
  minimalEdit,
  replaceRanges,
  resolveMarkers,
  Result,
  setMarkerColor,
  setMarkerComment,
} from './actions';
import { isSuggestion, Marker } from './criticmarkup';
import { renderDocument } from './render';
import type { Span } from './mapping';

const MAX_SIZE = 2 * 1024 * 1024;

type Msg =
  | { type: 'ready' }
  | { type: 'insert'; v: number; at: number; text: string }
  | { type: 'replace'; v: number; ranges: Span[]; text: string }
  | { type: 'delete'; v: number; ranges: Span[]; dir: Dir }
  | { type: 'enter'; v: number; at: number }
  | { type: 'highlight'; v: number; ranges: Span[]; color: string; comment?: string }
  | { type: 'commentOnly'; v: number; at: number; text: string; color: string }
  | { type: 'marker'; v: number; id: number; action: MarkerAction }
  | { type: 'markerColor'; v: number; id: number; color: string }
  | { type: 'markerComment'; v: number; id: number; text: string }
  | { type: 'all'; action: AllAction }
  | { type: 'showSource' }
  | { type: 'openSettings' }
  | { type: 'rerender' }
  | { type: 'log'; text: string }
  | { type: 'ui'; ui: UiState };

/** Ansichtszustand, der für alle Dateien gilt (eingeklappte Toolbar, Randspalte aus). */
interface UiState {
  toolbarCollapsed?: boolean;
  gutterHidden?: boolean;
}
const UI_KEY = 'mdReview.ui';

/** Offsets aus der Webview beziehen sich auf den Text vor einer evtl. Konfliktauflösung. */
type Action = (text: string, map: (p: number) => number) => Result;

export const log = vscode.window.createOutputChannel('Markdown Review', { log: true });

export class ReviewEditorProvider implements vscode.CustomTextEditorProvider {
  static readonly viewType = 'mdReview.editor';
  static active: ReviewSession | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    const s = new ReviewSession(this.context, document, panel);
    ReviewEditorProvider.active = s;
  }
}

export class ReviewSession {
  private disposables: vscode.Disposable[] = [];
  private renderTimer: NodeJS.Timeout | undefined;
  private pendingCaret: number | undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly context: vscode.ExtensionContext,
    readonly document: vscode.TextDocument,
    private readonly panel: vscode.WebviewPanel,
  ) {
    const dir = vscode.Uri.joinPath(document.uri, '..');
    const roots = [vscode.Uri.joinPath(context.extensionUri, 'media'), dir, ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri)];
    panel.webview.options = { enableScripts: true, localResourceRoots: roots };
    panel.webview.html = this.shell();

    this.disposables.push(
      panel.webview.onDidReceiveMessage((m: Msg) => {
        if (m.type !== 'log') log.debug('webview →', m.type);
        this.queue = this.queue
          .then(() => this.handle(m))
          .catch((e) => {
            log.error(e);
            this.toast(String(e?.message ?? e));
          });
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() === document.uri.toString() && e.contentChanges.length) this.scheduleRender();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('mdReview')) this.render();
      }),
      panel.onDidChangeViewState(() => {
        if (panel.active) ReviewEditorProvider.active = this;
      }),
      panel.onDidDispose(() => this.dispose()),
    );
  }

  private dispose() {
    if (ReviewEditorProvider.active === this) ReviewEditorProvider.active = undefined;
    this.disposables.forEach((d) => d.dispose());
    clearTimeout(this.renderTimer);
  }

  // ------------------------------------------------------------ Konfiguration

  private config() {
    const c = vscode.workspace.getConfiguration('mdReview');
    const colors = c.get<Record<string, string>>('colors') ?? {};
    let defaultColor = c.get<string>('defaultColor') ?? 'gelb';
    if (!(defaultColor in colors)) defaultColor = Object.keys(colors)[0] ?? 'gelb';
    return {
      author: c.get<string>('author') || 'EM',
      colors,
      defaultColor,
      showGutter: c.get<boolean>('showGutter') ?? true,
    };
  }

  private ctx(): Ctx {
    const c = this.config();
    return { author: c.author, defaultColor: c.defaultColor, colors: Object.keys(c.colors) };
  }

  // ------------------------------------------------------------ Rendern

  private scheduleRender() {
    clearTimeout(this.renderTimer);
    this.renderTimer = setTimeout(() => this.render(), 50);
  }

  render() {
    clearTimeout(this.renderTimer);
    const text = this.document.getText();
    const cfg = this.config();
    const webview = this.panel.webview;
    const dir = vscode.Uri.joinPath(this.document.uri, '..');
    const resolveImage = (src: string) => {
      if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('#')) return src;
      try {
        return webview.asWebviewUri(vscode.Uri.joinPath(dir, decodeURI(src))).toString();
      } catch {
        return src;
      }
    };
    const readonly = text.length > MAX_SIZE;
    const t0 = Date.now();
    const r = renderDocument(text, { defaultColor: cfg.defaultColor, colors: Object.keys(cfg.colors), resolveImage });
    const base = path.basename(this.document.uri.path).replace(/\.md$/i, '');
    const inkBase = webview.asWebviewUri(vscode.Uri.joinPath(dir, base + '.ink')).toString();
    webview.postMessage({
      type: 'render',
      v: this.document.version,
      html: r.html,
      markers: r.markers,
      stats: r.stats,
      config: cfg,
      inkBase,
      readonly,
      ui: this.context.globalState.get<UiState>(UI_KEY, {}),
      caret: this.pendingCaret,
    });
    log.debug(`render v${this.document.version} in ${Date.now() - t0} ms, ${r.markers.length} Marker`);
    this.pendingCaret = undefined;
  }

  toast(text: string) {
    this.panel.webview.postMessage({ type: 'toast', text });
  }

  post(msg: unknown) {
    this.panel.webview.postMessage(msg);
  }

  // ------------------------------------------------------------ Nachrichten

  private async handle(m: Msg) {
    const ctx = this.ctx();
    if ('v' in m && m.v !== this.document.version) {
      this.toast('Die Datei hat sich gerade geändert – bitte noch einmal.');
      this.render();
      return;
    }
    const mapRanges = (rs: Span[], map: (p: number) => number) =>
      rs.map((r) => ({ start: map(r.start), end: map(r.end) }));
    switch (m.type) {
      case 'log':
        log.warn('webview:', m.text);
        return;
      case 'ui':
        await this.context.globalState.update(UI_KEY, m.ui);
        return;
      case 'ready':
      case 'rerender':
        return this.render();
      case 'insert':
        return this.run((t, map) => insertAt(t, map(m.at), m.text, ctx));
      case 'replace':
        return this.run((t, map) => replaceRanges(t, mapRanges(m.ranges, map), m.text, ctx));
      case 'delete':
        return this.run((t, map) => deleteRanges(t, mapRanges(m.ranges, map), m.dir, ctx));
      case 'enter':
        return this.run((t, map) => enterAt(t, map(m.at), ctx));
      case 'highlight':
        return this.run((t, map) => highlight(t, mapRanges(m.ranges, map), m.color, ctx, m.comment));
      case 'commentOnly':
        return this.run((t, map) => commentOnly(t, map(m.at), m.text, m.color, ctx));
      case 'marker':
        return this.run((t) => markerAction(t, m.id, m.action, ctx));
      case 'markerColor':
        return this.run((t) => setMarkerColor(t, m.id, m.color, ctx));
      case 'markerComment':
        return this.run((t) => setMarkerComment(t, m.id, m.text, ctx));
      case 'all':
        return this.all(m.action);
      case 'showSource':
        await vscode.window.showTextDocument(this.document, { viewColumn: vscode.ViewColumn.Beside, preview: false });
        return;
      case 'openSettings':
        await vscode.commands.executeCommand('workbench.action.openSettings', 'mdReview.author');
        return;
    }
  }

  async all(action: AllAction) {
    const label = { accept: 'Alle Vorschläge annehmen', reject: 'Alle Vorschläge ablehnen', removeHighlights: 'Alle Hervorhebungen und Kommentare entfernen' }[action];
    const ok = await vscode.window.showWarningMessage(`${label}?`, { modal: true, detail: 'Lässt sich mit Cmd+Z rückgängig machen.' }, 'Ja');
    if (ok !== 'Ja') return;
    await this.run((t) => allAction(t, action, this.ctx()));
  }

  /** Führt eine Aktion aus, fragt bei Konflikten nach und schreibt das Ergebnis als ein WorkspaceEdit. */
  async run(fn: Action) {
    const original = this.document.getText();
    let text = original;
    let map = (p: number) => p;
    let r = fn(text, map);
    for (let round = 0; 'conflicts' in r && round < 3; round++) {
      const choice = await this.askConflict(r.conflicts);
      if (!choice) return this.render();
      const res = resolveMarkers(text, r.conflicts, choice);
      const prev = map;
      map = (p: number) => res.map(prev(p));
      text = res.text;
      r = fn(text, map);
    }
    if ('conflicts' in r) return this.render();
    if ('error' in r) {
      log.info('Aktion abgelehnt:', r.error);
      this.toast(r.error);
      return this.render();
    }
    if (r.info) this.toast(r.info);
    const edit = minimalEdit(original, r.text);
    log.debug('edit', JSON.stringify(edit));
    this.pendingCaret = r.caret;
    if (!edit) return this.render();
    const we = new vscode.WorkspaceEdit();
    we.replace(this.document.uri, new vscode.Range(this.document.positionAt(edit.start), this.document.positionAt(edit.end)), edit.text);
    const applied = await vscode.workspace.applyEdit(we);
    if (!applied) {
      this.toast('Änderung konnte nicht geschrieben werden.');
      this.render();
    }
  }

  private async askConflict(conflicts: Marker[]): Promise<ConflictChoice | undefined> {
    const sug = conflicts.filter(isSuggestion).length;
    const hl = conflicts.length - sug;
    const parts = [sug ? `${sug} Vorschlag/Vorschläge` : '', hl ? `${hl} kommentierte Hervorhebung(en)` : ''].filter(Boolean).join(' und ');
    const detail = 'Marker werden nicht verschachtelt. Bestehende Marker müssen zuerst aufgelöst werden.' + (hl ? ' Kommentierte Hervorhebungen werden dabei entfernt.' : '');
    if (sug) {
      const a = await vscode.window.showWarningMessage(`Die Auswahl überschneidet ${parts}.`, { modal: true, detail }, 'Vorschläge annehmen', 'Vorschläge ablehnen');
      return a === 'Vorschläge annehmen' ? 'accept' : a === 'Vorschläge ablehnen' ? 'reject' : undefined;
    }
    const a = await vscode.window.showWarningMessage(`Die Auswahl überschneidet ${parts}.`, { modal: true, detail }, 'Hervorhebung entfernen');
    return a ? 'reject' : undefined;
  }

  // ------------------------------------------------------------ HTML-Gerüst

  private shell(): string {
    const w = this.panel.webview;
    const media = (f: string) => w.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', f));
    const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${w.cspSource} https: data:; style-src ${w.cspSource} 'unsafe-inline'; font-src ${w.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media('style.css')}">
<title>Markdown Review</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${media('main.js')}"></script>
</body>
</html>`;
  }
}
