import * as vscode from 'vscode';

export interface MockWebview extends vscode.Webview {
  messages: unknown[];
}

export function createMockWebview(): MockWebview {
  const messages: unknown[] = [];

  return {
    messages,
    postMessage(message: unknown): Thenable<boolean> {
      messages.push(message);
      return Promise.resolve(true);
    },
    html: '',
    options: {},
    cspSource: 'https://test.vscode-resource.vscode-cdn.net',
    onDidReceiveMessage: new vscode.EventEmitter<unknown>().event,
    asWebviewUri(uri: vscode.Uri): vscode.Uri {
      return uri;
    },
  };
}
