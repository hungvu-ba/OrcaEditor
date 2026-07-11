import * as vscode from 'vscode';
import { MarkdownWysiwygProvider } from './provider';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(MarkdownWysiwygProvider.register(context));

  const MARKDOWN_EXT = /\.(md|markdown|mdown|mkd|mdwn|mdtxt|mdtext)$/i;

  const openWith = async (uri: vscode.Uri | undefined, viewColumn: vscode.ViewColumn) => {
    if (!uri) {
      const active = vscode.window.activeTextEditor;
      uri = active?.document.languageId === 'markdown' ? active.document.uri : undefined;
    }
    if (!uri || !MARKDOWN_EXT.test(uri.path)) {
      void vscode.window.showWarningMessage('No markdown file is currently open.');
      return;
    }
    await vscode.commands.executeCommand('vscode.openWith', uri, MarkdownWysiwygProvider.viewType, viewColumn);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('orcaEditor.open', (uri?: vscode.Uri) =>
      openWith(uri, vscode.ViewColumn.Active)
    ),
    vscode.commands.registerCommand('orcaEditor.openToSide', (uri?: vscode.Uri) =>
      openWith(uri, vscode.ViewColumn.Beside)
    )
  );
}

export function deactivate(): void {
  // nothing to clean up
}
