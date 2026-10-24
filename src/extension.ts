import * as vscode from 'vscode';
import { FirstPRSidebarProvider } from './ui/SidebarProvider';

export function activate(context: vscode.ExtensionContext) {
  const sidebarProvider = new FirstPRSidebarProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      FirstPRSidebarProvider.viewType,
      sidebarProvider,
      {
        webviewOptions: {
          retainContextWhenHidden: true,
        },
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('firstpr.focus', async () => {
      await vscode.commands.executeCommand('firstpr.sidebarView.focus');
    })
  );
}

export function deactivate() {}
