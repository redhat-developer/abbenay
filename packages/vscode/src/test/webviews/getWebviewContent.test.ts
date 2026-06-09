import * as assert from 'assert';
import * as vscode from 'vscode';
import { getWebviewContent } from '../../webviews/shared/getWebviewContent';

suite('getWebviewContent', () => {
  let mockWebview: vscode.Webview;
  let extensionUri: vscode.Uri;

  suiteSetup(() => {
    extensionUri = vscode.Uri.file('/test/extension');
    mockWebview = {
      html: '',
      options: {},
      cspSource: 'https://test.vscode-resource.vscode-cdn.net',
      onDidReceiveMessage: new vscode.EventEmitter<unknown>().event,
      postMessage: () => Promise.resolve(true),
      asWebviewUri: (uri: vscode.Uri) => uri,
    };
  });

  test('should return valid HTML with doctype', () => {
    const html = getWebviewContent(mockWebview, extensionUri, 'provider', 'Test Title');
    assert.ok(html.startsWith('<!DOCTYPE html>'));
    assert.ok(html.includes('<html lang="en">'));
    assert.ok(html.includes('</html>'));
  });

  test('should include CSP meta tag with nonce', () => {
    const html = getWebviewContent(mockWebview, extensionUri, 'provider', 'Test Title');
    assert.ok(html.includes('Content-Security-Policy'));
    assert.ok(html.includes("script-src 'nonce-"));
    assert.ok(html.includes(mockWebview.cspSource));
  });

  test('should include script tag with nonce', () => {
    const html = getWebviewContent(mockWebview, extensionUri, 'provider', 'Test Title');
    const nonceMatch = html.match(/nonce-([a-f0-9]+)/);
    assert.ok(nonceMatch, 'Should have a nonce in CSP');
    const nonce = nonceMatch![1];
    assert.ok(html.includes(`nonce="${nonce}"`), 'Script tag should use the same nonce');
  });

  test('should include root div', () => {
    const html = getWebviewContent(mockWebview, extensionUri, 'provider', 'Test Title');
    assert.ok(html.includes('<div id="root"></div>'));
  });

  test('should set the title', () => {
    const html = getWebviewContent(mockWebview, extensionUri, 'provider', 'My Custom Title');
    assert.ok(html.includes('<title>My Custom Title</title>'));
  });

  test('should reference panel-specific CSS and JS', () => {
    const html = getWebviewContent(mockWebview, extensionUri, 'chat', 'Chat');
    assert.ok(html.includes('chat.css'), 'Should reference chat CSS');
    assert.ok(html.includes('chat'), 'Should reference chat JS bundle');
  });
});
