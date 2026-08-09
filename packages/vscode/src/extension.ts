import * as vscode from 'vscode';
import { getLogger, updateLogLevel, disposeLogger } from './utils/logger';
import {
  initializeDaemon,
  shutdownDaemon,
  setExtensionPath,
  setDaemonSecretStorage,
  getDaemonClient,
  BackchannelHandler,
  DAEMON_TOKEN_SECRET_KEY,
  affectsDaemonConnection,
  readDaemonConnectionConfig,
  describeConnectionMode,
  dashboardUrlFromDaemonAddress,
} from './daemon';
import { AbbenayLanguageModelProvider } from './providers';
import { ChatViewProvider } from './webviews/chat/ChatViewProvider';
import { ProviderPanel } from './webviews/provider/ProviderPanel';

// Default dashboard URL - daemon serves web UI here (local)
const DEFAULT_DASHBOARD_URL = 'http://localhost:8787';

let languageModelProvider: AbbenayLanguageModelProvider | null = null;
let backchannelHandler: BackchannelHandler | null = null;
let chatViewProvider: ChatViewProvider | null = null;
let toolChangeDisposable: vscode.Disposable | null = null;
let reconnectInFlight = false;
let reconnectPending = false;

/** Dashboard URL: same host as remote gRPC when configured, else localhost. */
function resolveDashboardUrl(): string {
  const cfg = readDaemonConnectionConfig();
  return dashboardUrlFromDaemonAddress(cfg.address) || DEFAULT_DASHBOARD_URL;
}

export async function activate(context: vscode.ExtensionContext) {
  console.log('[Abbenay] activate() called');
  const logger = getLogger();
  logger.info('Open LLM Provider activating...');

  // Set extension path for finding bundled daemon binary
  setExtensionPath(context.extensionPath);
  setDaemonSecretStorage(context.secrets);
  console.log('[Abbenay] extensionPath:', context.extensionPath);

  await startDaemonServices(context);

  // Register chat sidebar webview (holds singleton client reference)
  const client = getDaemonClient();
  chatViewProvider = new ChatViewProvider(context.extensionUri, client);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatViewProvider),
  );

  // Register commands
  registerCommands(context, chatViewProvider);

  // Watch for configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async e => {
      if (e.affectsConfiguration('abbenay.logLevel')) {
        updateLogLevel();
      }
      if (affectsDaemonConnection(e)) {
        await reconnectDaemonServices(context);
      }
    }),
  );

  logger.info('Abbenay Provider activated');
}

export async function deactivate() {
  const logger = getLogger();
  logger.info('Abbenay Provider deactivating...');

  await stopDaemonServices();

  try {
    await shutdownDaemon();
    logger.info('[Daemon] Disconnected');
  } catch (e) {
    logger.error('[Daemon] Error during shutdown:', e);
  }

  disposeLogger();
}

/**
 * Connect to the daemon and start LM provider + backchannel.
 * Keeps the DaemonClient singleton so ChatViewProvider's reference stays valid.
 * @returns true when connected and services started
 */
async function startDaemonServices(
  context: vscode.ExtensionContext,
  options: { showError?: boolean } = {},
): Promise<boolean> {
  const { showError = true } = options;
  const logger = getLogger();
  const mode = describeConnectionMode(readDaemonConnectionConfig());

  try {
    logger.info(`[Daemon] Connecting to Abbenay daemon (${mode})...`);
    await initializeDaemon();
    logger.info(`[Daemon] Connected and registered (${getDaemonClient().getConnectionMode()})`);

    const client = getDaemonClient();
    const healthy = await client.healthCheck();
    if (healthy) {
      logger.info('[Daemon] Health check passed');
    } else {
      logger.warn('[Daemon] Health check failed');
    }

    languageModelProvider = new AbbenayLanguageModelProvider(client);
    await languageModelProvider.start();
    logger.info('[LMProvider] Language Model Provider started');

    backchannelHandler = new BackchannelHandler(client, context);

    backchannelHandler.onModelsChanged = () => {
      if (languageModelProvider) {
        logger.info('[Extension] ModelsChanged notification → refreshing LM provider');
        languageModelProvider.refreshModels().catch(e => {
          logger.warn('[Extension] Failed to refresh models after notification:', e);
        });
      }
    };

    toolChangeDisposable = backchannelHandler.setupToolChangeListener();

    backchannelHandler.start().catch(e => {
      logger.warn('[Backchannel] Failed to start:', e);
    });
    logger.info('[Backchannel] Started');
    return true;
  } catch (e: unknown) {
    // Clear any half-started services from this attempt.
    if (toolChangeDisposable) {
      toolChangeDisposable.dispose();
      toolChangeDisposable = null;
    }
    if (backchannelHandler) {
      await backchannelHandler.stop().catch(() => {});
      backchannelHandler = null;
    }
    if (languageModelProvider) {
      languageModelProvider.stop();
      languageModelProvider = null;
    }

    const msg = e instanceof Error ? e.message : String(e);
    logger.error(`[Daemon] Failed to connect: ${msg}`);
    if (e instanceof Error && e.stack) {
      logger.error(`[Daemon] Stack: ${e.stack}`);
    }
    if (showError) {
      vscode.window.showWarningMessage(
        `Abbenay: Could not connect to daemon — ${msg}`,
      );
    }
    return false;
  }
}

async function stopDaemonServices(): Promise<void> {
  const logger = getLogger();

  if (toolChangeDisposable) {
    toolChangeDisposable.dispose();
    toolChangeDisposable = null;
  }

  if (backchannelHandler) {
    await backchannelHandler.stop();
    backchannelHandler = null;
    logger.info('[Backchannel] Stopped');
  }

  if (languageModelProvider) {
    languageModelProvider.stop();
    languageModelProvider = null;
    logger.info('[LMProvider] Language Model Provider stopped');
  }
}

/**
 * Reconnect after daemon connection settings change.
 * Closes the channel on the same singleton client so webview refs stay valid.
 * Concurrent calls coalesce: a trailing reconnect always runs with latest settings.
 */
async function reconnectDaemonServices(context: vscode.ExtensionContext): Promise<void> {
  if (reconnectInFlight) {
    reconnectPending = true;
    return;
  }
  reconnectInFlight = true;
  const logger = getLogger();

  try {
    do {
      reconnectPending = false;
      const mode = describeConnectionMode(readDaemonConnectionConfig());
      logger.info(`[Daemon] Connection settings changed — reconnecting (${mode})...`);

      try {
        await stopDaemonServices();

        const client = getDaemonClient();
        // Always close — clears orphaned half-open channels too.
        await client.close();

        const ok = await startDaemonServices(context, { showError: false });
        if (ok) {
          vscode.window.showInformationMessage(
            `Abbenay: Reconnected to daemon (${client.getConnectionMode()})`,
          );
        } else {
          vscode.window.showWarningMessage(
            `Abbenay: Reconnect failed (${mode}). Check daemon address / TLS / token settings.`,
          );
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        logger.error(`[Daemon] Reconnect failed: ${msg}`);
        vscode.window.showWarningMessage(`Abbenay: Reconnect failed — ${msg}`);
      }
    } while (reconnectPending);
  } finally {
    reconnectInFlight = false;
  }
}

function registerCommands(context: vscode.ExtensionContext, chat: ChatViewProvider): void {
  // Daemon status command
  context.subscriptions.push(
    vscode.commands.registerCommand('abbenay.daemonStatus', async () => {
      console.log('[Abbenay] daemonStatus command');

      try {
        const client = getDaemonClient();
        const status = await client.getStatus();

        const startedAt = status.startedAt?.seconds
          ? new Date(Number(status.startedAt.seconds) * 1000).toLocaleString()
          : 'unknown';

        const msg = [
          `Abbenay Daemon v${status.version || 'unknown'}`,
          `Connection: ${client.getConnectionMode()}`,
          `Started: ${startedAt}`,
          `Clients: ${status.connectedClients || 0}`,
          `Sessions: ${status.activeSessions || 0}`,
        ].join('\n');

        vscode.window.showInformationMessage(msg, 'Open Dashboard').then(action => {
          if (action === 'Open Dashboard') {
            vscode.env.openExternal(vscode.Uri.parse(resolveDashboardUrl()));
          }
        });
      } catch (e) {
        console.error('[Abbenay] daemonStatus error:', e);
        const mode = getDaemonClient().getConnectionMode();
        vscode.window.showErrorMessage(
          `Abbenay: Cannot get daemon status (${mode}). Is the daemon running?`,
          'Open Dashboard Anyway',
        ).then(action => {
          if (action === 'Open Dashboard Anyway') {
            vscode.env.openExternal(vscode.Uri.parse(resolveDashboardUrl()));
          }
        });
      }
    }),
  );

  // Open dashboard command - starts web server via gRPC, then opens browser
  context.subscriptions.push(
    vscode.commands.registerCommand('abbenay.openDashboard', async () => {
      const logger = getLogger();
      const fallbackUrl = resolveDashboardUrl();
      logger.info('[Dashboard] Opening dashboard...');

      try {
        const client = getDaemonClient();
        if (!client.isConnected()) {
          // Daemon not connected — open URL anyway, user may have started web manually
          logger.warn('[Dashboard] Daemon not connected, opening URL directly');
          vscode.env.openExternal(vscode.Uri.parse(fallbackUrl));
          return;
        }

        // Send gRPC request to start the embedded web server
        const response = await client.startWebServer(8787);
        // Prefer host-reachable URL derived from daemonAddress over daemon-local localhost.
        const url = fallbackUrl !== DEFAULT_DASHBOARD_URL
          ? fallbackUrl
          : (response.url || fallbackUrl);

        if (response.alreadyRunning) {
          logger.info(`[Dashboard] Web server already running at ${url}`);
        } else {
          logger.info(`[Dashboard] Web server started at ${url}`);
        }

        vscode.env.openExternal(vscode.Uri.parse(url));
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        logger.error(`[Dashboard] Failed to start web server: ${msg}`);
        // Fall back to opening the URL directly
        vscode.env.openExternal(vscode.Uri.parse(fallbackUrl));
      }
    }),
  );

  // Configure provider command - opens provider webview panel
  context.subscriptions.push(
    vscode.commands.registerCommand('abbenay.configureProvider', () => {
      console.log('[Abbenay] configureProvider command');
      const client = getDaemonClient();
      ProviderPanel.createOrShow(context.extensionUri, client);
    }),
  );

  // Chat send command — allows other extensions to inject a prompt
  context.subscriptions.push(
    vscode.commands.registerCommand('abbenay.chat.send', async (args: { message: string }) => {
      if (!args?.message) {
        vscode.window.showWarningMessage('abbenay.chat.send requires a { message } argument.');
        return;
      }
      await chat.injectPrompt(args.message);
    }),
  );

  // Store consumer token in SecretStorage (not settings.json)
  context.subscriptions.push(
    vscode.commands.registerCommand('abbenay.setDaemonToken', async () => {
      const token = await vscode.window.showInputBox({
        title: 'Abbenay Daemon Token',
        prompt: 'Consumer token sent as x-abbenay-token on gRPC calls (for remote/container daemons)',
        password: true,
        ignoreFocusOut: true,
      });
      if (token === undefined) {
        return;
      }
      if (!token.trim()) {
        vscode.window.showWarningMessage('Abbenay: Token was empty; nothing stored.');
        return;
      }
      await context.secrets.store(DAEMON_TOKEN_SECRET_KEY, token.trim());
      vscode.window.showInformationMessage('Abbenay: Daemon token stored. Reconnecting…');
      await reconnectDaemonServices(context);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('abbenay.clearDaemonToken', async () => {
      await context.secrets.delete(DAEMON_TOKEN_SECRET_KEY);
      vscode.window.showInformationMessage('Abbenay: Daemon token cleared. Reconnecting…');
      await reconnectDaemonServices(context);
    }),
  );
}
