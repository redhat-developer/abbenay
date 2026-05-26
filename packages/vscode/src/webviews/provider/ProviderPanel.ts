import * as vscode from 'vscode';
import { DaemonClient } from '../../daemon/client';
import { getWebviewContent } from '../shared/getWebviewContent';
import { getLogger } from '../../utils/logger';
import { handleProviderMessage } from './providerHandler';

/**
 * Singleton webview panel for provider configuration
 */
export class ProviderPanel {
  public static currentPanel: ProviderPanel | undefined;
  private static readonly viewType = 'abbenayProviderConfig';

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private readonly _client: DaemonClient;
  private _disposables: vscode.Disposable[] = [];

  /**
   * Create or show the provider configuration panel
   */
  public static createOrShow(extensionUri: vscode.Uri, client: DaemonClient): void {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    // If panel already exists, reveal it
    if (ProviderPanel.currentPanel) {
      ProviderPanel.currentPanel._panel.reveal(column);
      ProviderPanel.currentPanel.update();
      return;
    }

    // Create new panel
    const panel = vscode.window.createWebviewPanel(
      ProviderPanel.viewType,
      'Abbenay: Providers',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, 'out'),
          vscode.Uri.joinPath(extensionUri, 'media'),
        ],
      },
    );

    ProviderPanel.currentPanel = new ProviderPanel(panel, extensionUri, client);
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, client: DaemonClient) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._client = client;

    // Set HTML content
    this.update();

    // Listen for when the panel is disposed
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    // Handle messages from the webview
    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        try {
          await handleProviderMessage(message, this._panel.webview, this._client);
        } catch (error) {
          const logger = getLogger();
          logger.error('[ProviderPanel] Error handling message:', error);
          this._panel.webview.postMessage({
            type: 'error',
            message: error instanceof Error ? error.message : String(error),
            context: 'message-handler',
          });
        }
      },
      null,
      this._disposables,
    );
  }

  /**
   * Update the webview content
   */
  public update(): void {
    const webview = this._panel.webview;
    this._panel.webview.html = getWebviewContent(
      webview,
      this._extensionUri,
      'provider',
      'Abbenay: Providers',
    );
  }

  /**
   * Clean up resources
   */
  public dispose(): void {
    ProviderPanel.currentPanel = undefined;

    // Clean up our resources
    this._panel.dispose();

    while (this._disposables.length) {
      const disposable = this._disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }
}
