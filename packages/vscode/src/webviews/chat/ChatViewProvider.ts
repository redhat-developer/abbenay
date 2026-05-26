import * as vscode from 'vscode';
import { DaemonClient } from '../../daemon/client';
import { getWebviewContent } from '../shared/getWebviewContent';
import { ChatToHostMessage } from '../shared/types';
import { handleChatMessage, cancelActiveStream } from './chatHandler';
import { getLogger } from '../../utils/logger';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'abbenay.chatView';
  private _view?: vscode.WebviewView;
  private readonly _logger = getLogger();

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _client: DaemonClient,
  ) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this._extensionUri, 'out'),
        vscode.Uri.joinPath(this._extensionUri, 'media'),
      ],
    };

    webviewView.webview.html = getWebviewContent(
      webviewView.webview,
      this._extensionUri,
      'chat',
      'Abbenay Chat',
    );

    webviewView.webview.onDidReceiveMessage(async (message: ChatToHostMessage) => {
      try {
        await handleChatMessage(message, webviewView.webview, this._client);
      } catch (error) {
        this._logger.error('[ChatView] Error handling message:', error);
        webviewView.webview.postMessage({
          type: 'error',
          message: error instanceof Error ? error.message : String(error),
          context: 'handler',
        });
      }
    });

    webviewView.onDidDispose(() => {
      cancelActiveStream();
      this._view = undefined;
    });
  }

  public async refreshModels(): Promise<void> {
    if (!this._view) {return;}
    try {
      const models = await this._client.listModels();
      this._view.webview.postMessage({
        type: 'models',
        models: models.map(m => ({ id: m.id, provider: m.provider, name: m.name, engine: m.engine })),
      });
    } catch (error) {
      this._logger.error('[ChatView] Error refreshing models:', error);
    }
  }

  public reveal(): void {
    if (this._view) {
      this._view.show(true);
    }
  }
}
