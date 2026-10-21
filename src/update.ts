// Selbst-Update über GitHub Releases: Die Action hängt bei jedem Tag `v*` eine .vsix an ein Release.
// Jede Installation prüft beim Start und alle paar Stunden, ob es eine neuere Version gibt, und installiert sie.
// Öffentliches Repo: keine Anmeldung nötig. Nur wenn GitHub 404/401 meldet (privates Repo), wird einmal nach
// der GitHub-Anmeldung von VS Code gefragt.

import * as vscode from 'vscode';
import * as path from 'node:path';
import { log } from './provider';

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const NO_LOGIN_KEY = 'mdReview.update.noLoginPrompt';

interface Release {
  tag_name: string;
  assets: { id: number; name: string; url: string }[];
}

/** 1.2.10 > 1.2.9; Präfix "v" wird ignoriert. */
export function isNewer(candidate: string, current: string): boolean {
  const parse = (v: string) => v.replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const a = parse(candidate);
  const b = parse(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

function settings() {
  const c = vscode.workspace.getConfiguration('mdReview.update');
  return {
    repo: c.get<string>('repo') || 'EmanuelMak/md-review-vscode',
    mode: c.get<'auto' | 'ask' | 'off'>('mode') ?? 'auto',
  };
}

async function token(context: vscode.ExtensionContext, interactive: boolean): Promise<string | undefined> {
  try {
    const silent = await vscode.authentication.getSession('github', ['repo'], { silent: true });
    if (silent) return silent.accessToken;
    if (!interactive) return undefined;
    const s = await vscode.authentication.getSession('github', ['repo'], { createIfNone: true });
    return s?.accessToken;
  } catch (e) {
    log.info('GitHub-Anmeldung für Updates nicht möglich:', String(e));
    return undefined;
  }
}

/** Prüft auf ein neueres Release. `manual`: vom Nutzer ausgelöst (Meldungen auch, wenn nichts zu tun ist). */
export async function checkForUpdate(context: vscode.ExtensionContext, manual = false): Promise<void> {
  const { repo, mode } = settings();
  if (mode === 'off' && !manual) return;
  const current = String(context.extension.packageJSON.version);

  let auth = await token(context, false);
  const headers = (): Record<string, string> => ({
    Accept: 'application/vnd.github+json',
    'User-Agent': 'md-review-vscode',
    ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
  });
  const latest = () => fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: headers() });

  let rel: Release;
  try {
    let r = await latest();
    if ((r.status === 404 || r.status === 401) && !auth) {
      // vermutlich privates Repo: einmal um Anmeldung bitten
      if (!manual && context.globalState.get(NO_LOGIN_KEY)) return;
      const pick = manual
        ? 'Anmelden'
        : await vscode.window.showInformationMessage(
            `Markdown Review: Das Update-Repo ${repo} ist nicht öffentlich erreichbar. Mit GitHub anmelden?`,
            'Anmelden',
            'Nicht mehr fragen',
          );
      if (pick === 'Nicht mehr fragen') await context.globalState.update(NO_LOGIN_KEY, true);
      if (pick !== 'Anmelden') return;
      auth = await token(context, true);
      if (!auth) return;
      r = await latest();
    }
    if (r.status === 404) {
      log.info(`Update-Prüfung: noch kein Release in ${repo}.`);
      if (manual) vscode.window.showInformationMessage(`Markdown Review: In ${repo} gibt es noch kein Release.`);
      return;
    }
    if (!r.ok) throw new Error(`GitHub antwortet ${r.status}`);
    rel = (await r.json()) as Release;
  } catch (e) {
    log.info('Update-Prüfung fehlgeschlagen:', String(e));
    if (manual) vscode.window.showWarningMessage(`Markdown Review: Update-Prüfung fehlgeschlagen (${String(e)}).`);
    return;
  }

  if (!isNewer(rel.tag_name, current)) {
    log.info(`Update-Prüfung: ${current} ist aktuell (neuestes Release ${rel.tag_name}).`);
    if (manual) vscode.window.showInformationMessage(`Markdown Review ${current} ist aktuell.`);
    return;
  }
  const asset = rel.assets.find((a) => a.name.endsWith('.vsix'));
  if (!asset) {
    log.warn(`Release ${rel.tag_name} hat keine .vsix.`);
    return;
  }

  if (mode === 'ask' && !manual) {
    const pick = await vscode.window.showInformationMessage(
      `Markdown Review ${rel.tag_name} ist verfügbar (installiert: ${current}).`,
      'Installieren',
    );
    if (pick !== 'Installieren') return;
  }

  try {
    // Asset-Download: API-URL mit octet-stream liefert eine Weiterleitung auf eine signierte URL
    const r = await fetch(asset.url, { headers: { ...headers(), Accept: 'application/octet-stream' } });
    if (!r.ok) throw new Error(`Download ${r.status}`);
    const data = new Uint8Array(await r.arrayBuffer());
    const dir = context.globalStorageUri;
    await vscode.workspace.fs.createDirectory(dir);
    const file = vscode.Uri.joinPath(dir, path.basename(asset.name));
    await vscode.workspace.fs.writeFile(file, data);
    await vscode.commands.executeCommand('workbench.extensions.installExtension', file);
    log.info(`Update ${rel.tag_name} installiert.`);
  } catch (e) {
    log.error('Update fehlgeschlagen:', String(e));
    vscode.window.showWarningMessage(`Markdown Review: Update auf ${rel.tag_name} fehlgeschlagen (${String(e)}).`);
    return;
  }

  const pick = await vscode.window.showInformationMessage(
    `Markdown Review wurde auf ${rel.tag_name} aktualisiert. Erweiterungen neu starten, damit es wirkt?`,
    'Jetzt neu starten',
  );
  if (pick) await vscode.commands.executeCommand('workbench.action.restartExtensionHost');
}

export function startUpdateChecks(context: vscode.ExtensionContext) {
  // kurz warten, damit der Start von VS Code nicht gebremst wird
  const first = setTimeout(() => void checkForUpdate(context), 15_000);
  const every = setInterval(() => void checkForUpdate(context), CHECK_EVERY_MS);
  context.subscriptions.push({ dispose: () => (clearTimeout(first), clearInterval(every)) });
}

/** Einmal fragen, ob Markdown Review Standard für .md werden soll (auf neuen Rechnern). */
export async function offerDefaultEditor(context: vscode.ExtensionContext, viewType: string) {
  const KEY = 'mdReview.askedDefault';
  if (context.globalState.get(KEY)) return;
  const assoc = vscode.workspace.getConfiguration('workbench').get<Record<string, string>>('editorAssociations') ?? {};
  if (assoc['*.md'] === viewType) return;
  await context.globalState.update(KEY, true);
  const pick = await vscode.window.showInformationMessage(
    'Markdown-Dateien standardmäßig mit Markdown Review öffnen? (Oben rechts kann man jederzeit zum Text wechseln.)',
    'Ja',
    'Nein',
  );
  if (pick === 'Ja') await setDefaultEditor(viewType);
}

export async function setDefaultEditor(viewType: string) {
  const cfg = vscode.workspace.getConfiguration('workbench');
  const assoc = { ...(cfg.get<Record<string, string>>('editorAssociations') ?? {}), '*.md': viewType };
  await cfg.update('editorAssociations', assoc, vscode.ConfigurationTarget.Global);
}
