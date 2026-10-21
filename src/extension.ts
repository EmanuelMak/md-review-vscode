import * as vscode from 'vscode';
import { ReviewEditorProvider } from './provider';
import { checkForUpdate, offerDefaultEditor, setDefaultEditor, startUpdateChecks } from './update';

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(ReviewEditorProvider.viewType, new ReviewEditorProvider(context), {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  const session = () => {
    const s = ReviewEditorProvider.active;
    if (!s) vscode.window.showInformationMessage('Kein Markdown-Review-Editor aktiv.');
    return s;
  };

  const reg = (id: string, fn: (...args: any[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('mdReview.open', async (uri?: vscode.Uri) => {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!target) {
      vscode.window.showInformationMessage('Keine Markdown-Datei ausgewählt.');
      return;
    }
    await reopenWith(target, ReviewEditorProvider.viewType);
  });
  const reviewUri = (uri?: vscode.Uri) => uri ?? ReviewEditorProvider.active?.document.uri;
  reg('mdReview.openAsText', async (uri?: vscode.Uri) => {
    const target = reviewUri(uri);
    if (target) await reopenWith(target, 'default');
  });
  reg('mdReview.openPreview', async (uri?: vscode.Uri) => {
    const target = reviewUri(uri);
    if (target) await vscode.commands.executeCommand('markdown.showPreviewToSide', target);
  });
  reg('mdReview.checkForUpdate', () => checkForUpdate(context, true));
  reg('mdReview.setDefault', async () => {
    await setDefaultEditor(ReviewEditorProvider.viewType);
    vscode.window.showInformationMessage('Markdown-Dateien öffnen jetzt standardmäßig mit Markdown Review.');
  });
  startUpdateChecks(context);
  void offerDefaultEditor(context, ReviewEditorProvider.viewType);

  reg('mdReview.acceptAtCursor', () => session()?.post({ type: 'command', name: 'accept' }));
  reg('mdReview.rejectAtCursor', () => session()?.post({ type: 'command', name: 'reject' }));
  reg('mdReview.nextMarker', () => session()?.post({ type: 'command', name: 'next' }));
  reg('mdReview.previousMarker', () => session()?.post({ type: 'command', name: 'prev' }));
  reg('mdReview.acceptAll', () => session()?.all('accept'));
  reg('mdReview.rejectAll', () => session()?.all('reject'));
  reg('mdReview.removeAllHighlights', () => session()?.all('removeHighlights'));
  reg('mdReview.showSource', () => {
    const s = session();
    if (s) vscode.window.showTextDocument(s.document, { viewColumn: vscode.ViewColumn.Beside, preview: false });
  });
}

/** Öffnet die Datei im anderen Editor und schließt den bisherigen Tab derselben Datei (wie „Reopen Editor With“). */
async function reopenWith(uri: vscode.Uri, viewType: string) {
  const group = vscode.window.tabGroups.activeTabGroup;
  const old = group.activeTab;
  await vscode.commands.executeCommand('vscode.openWith', uri, viewType, { viewColumn: group.viewColumn, preview: false });
  const input = old?.input;
  const oldUri =
    input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom ? input.uri.toString() : undefined;
  if (!old || oldUri !== uri.toString()) return;
  // nur schließen, wenn der neue Editor wirklich ein anderer Tab ist
  const still = group.tabs.find((t) => t.label === old.label && t.input === old.input);
  if (still && still !== group.activeTab) {
    try {
      await vscode.window.tabGroups.close(still);
    } catch {
      /* Tab bereits weg */
    }
  }
}

export function deactivate() {}
