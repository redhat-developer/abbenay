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
  dashboardUrlForConnection,
  DEFAULT_DASHBOARD_PORT,
  EMBEDDED_DASHBOARD_PORT,
} from './daemon';
import { AbbenayLanguageModelProvider } from './providers';
import { ChatViewProvider } from './webviews/chat/ChatViewProvider';
import { ProviderPanel } from './webviews/provider/ProviderPanel';

// Default dashboard URL - daemon serves web UI here (local)
const DEFAULT_DASHBOARD_URL = `http://localhost:${DEFAULT_DASHBOARD_PORT}`;
const EMBEDDED_DASHBOARD_URL = `http://localhost:${EMBEDDED_DASHBOARD_PORT}`;

let languageModelProvider: AbbenayLanguageModelProvider | null = null;
let backchannelHandler: BackchannelHandler | null = null;
let chatViewProvider: ChatViewProvider | null = null;
let toolChangeDisposable: vscode.Disposable | null = null;
let reconnectInFlight = false;
let reconnectPending = false;
let daemonConnectionSettingsWatcher: vscode.Disposable | null = null;
let activationContext: vscode.ExtensionContext | null = null;
let activationStartup: Promise<boolean> | null = null;

/** Dashboard URL: same host as remote gRPC when configured, else localhost. */
function resolveDashboardUrl(): string | undefined {
  const cfg = readDaemonConnectionConfig();
  if (cfg.isRemote) {
    return dashboardUrlFromDaemonAddress(cfg.address);
  }
  if (cfg.mode === 'disabled') {
    return undefined;
  }
  if (cfg.mode === 'embedded') {
    return EMBEDDED_DASHBOARD_URL;
  }
  return DEFAULT_DASHBOARD_URL;
}

export async function completeDaemonStartupUnlessDisabled<T>(
  startup: () => Promise<T>,
  isDisabled: () => boolean,
  rollback: (result: T) => Promise<void>,
): Promise<T | undefined> {
  const result = await startup();
  if (!isDisabled()) {
    return result;
  }
  await rollback(result);
  return undefined;
}

export async function openDashboardForClient(
  client: Pick<ReturnType<typeof getDaemonClient>, 'startWebServer'>,
  openExternal: (uri: vscode.Uri) => Thenable<boolean> = vscode.env.openExternal,
  config: ReturnType<typeof readDaemonConnectionConfig> = readDaemonConnectionConfig(),
  resolveUrl: (response: Awaited<ReturnType<typeof client.startWebServer>>) => string = (response) => (
    response.url || (response.port > 0 ? `http://localhost:${response.port}` : '')
  ),
): Promise<string> {
  const response = await client.startWebServer();
  const daemonUrl = resolveUrl(response);
  if (!daemonUrl) {
    throw new Error('Daemon started the web server but did not return a dashboard URL.');
  }

  const url = dashboardUrlForConnection(config, daemonUrl);
  await openExternal(vscode.Uri.parse(url));
  return url;
}

export async function activate(context: vscode.ExtensionContext) {
  console.log('[Abbenay] activate() called');
  const logger = getLogger();
  logger.info('Open LLM Provider activating...');

  // Set extension path for finding bundled daemon binary
  setExtensionPath(context.extensionPath);
  setDaemonSecretStorage(context.secrets);
  activationContext = context;
  console.log('[Abbenay] extensionPath:', context.extensionPath);

  // Listen before daemon startup so a Disabled change cancels an in-flight activation.
  daemonConnectionSettingsWatcher = vscode.workspace.onDidChangeConfiguration(async e => {
    if (e.affectsConfiguration('abbenay.logLevel')) {
      updateLogLevel();
    }
    if (affectsDaemonConnection(e) && activationContext) {
      await reconnectDaemonServices(activationContext);
    }
  });
  context.subscriptions.push(daemonConnectionSettingsWatcher);

  const startup = startDaemonServices(context);
  activationStartup = startup;
  try {
    await startup;
  } finally {
    if (activationStartup === startup) {
      activationStartup = null;
    }
  }

  // Register chat sidebar webview (holds singleton client reference)
  const client = getDaemonClient();
  chatViewProvider = new ChatViewProvider(context.extensionUri, client);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatViewProvider),
  );

  // Register commands
  registerCommands(context, chatViewProvider);

  logger.info('Abbenay Provider activated');
}

export async function deactivate() {
  const logger = getLogger();
  logger.info('Abbenay Provider deactivating...');
  activationContext = null;
  daemonConnectionSettingsWatcher?.dispose();
  daemonConnectionSettingsWatcher = null;

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
  const config = readDaemonConnectionConfig();
  const mode = describeConnectionMode(config);
  const disconnectIfDisabled = async (): Promise<boolean> => {
    if (readDaemonConnectionConfig().mode !== 'disabled') {
      return false;
    }
    await stopDaemonServices();
    await getDaemonClient().close();
    logger.info('[Daemon] Disabled during startup; closed the connection before registering services.');
    return true;
  };
  if (config.mode === 'disabled') {
    logger.info('[Daemon] Disabled by abbenay.daemonMode; skipping connection and language-model registration.');
    return false;
  }

  try {
    logger.info(`[Daemon] Connecting to Abbenay daemon (${mode})...`);
    const initializedClient = await completeDaemonStartupUnlessDisabled(
      () => initializeDaemon(),
      () => readDaemonConnectionConfig().mode === 'disabled',
      async (startedClient) => {
        await startedClient.close();
        logger.info('[Daemon] Disabled during startup; closed the connection before registering services.');
      },
    );
    if (!initializedClient) {
      return false;
    }
    logger.info(`[Daemon] Connected and registered (${initializedClient.getConnectionMode()})`);

    const client = initializedClient;
    const healthy = await client.healthCheck();
    if (healthy) {
      logger.info('[Daemon] Health check passed');
    } else {
      logger.warn('[Daemon] Health check failed');
    }

    languageModelProvider = new AbbenayLanguageModelProvider(client);
    await languageModelProvider.start();
    logger.info('[LMProvider] Language Model Provider started');

    if (await disconnectIfDisabled()) {
      return false;
    }

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
      logger.info('[Daemon] Connection settings changed — reconnecting...');

      try {
        if (activationStartup) {
          reconnectPending = true;
          await activationStartup;
          continue;
        }

        await stopDaemonServices();

        const config = readDaemonConnectionConfig();
        const mode = describeConnectionMode(config);
        const client = getDaemonClient();
        // Always close — clears orphaned half-open channels too.
        await client.close();

        const ok = await startDaemonServices(context, { showError: false });
        if (config.mode === 'disabled') {
          logger.info('[Daemon] Disabled; disconnected from the daemon.');
        } else if (ok) {
          vscode.window.showInformationMessage(
            `Abbenay: Reconnected to daemon (${client.getConnectionMode()})`,
          );
        } else {
          vscode.window.showWarningMessage(
            `Abbenay: Reconnect failed (${mode}). Check daemon mode / address / TLS / token settings.`,
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

        vscode.window.showInformationMessage(msg, 'Open Dashboard').then(async action => {
          if (action === 'Open Dashboard') {
            await vscode.commands.executeCommand('abbenay.openDashboard');
          }
        });
      } catch (e) {
        console.error('[Abbenay] daemonStatus error:', e);
        const mode = getDaemonClient().getConnectionMode();
        vscode.window.showErrorMessage(
          `Abbenay: Cannot get daemon status (${mode}). Is the daemon running?`,
          'Open Dashboard Anyway',
        ).then(async action => {
          if (action === 'Open Dashboard Anyway') {
            await vscode.commands.executeCommand('abbenay.openDashboard');
          }
        });
      }
    }),
  );

  // Open dashboard command - starts web server via gRPC, then opens browser
  context.subscriptions.push(
    vscode.commands.registerCommand('abbenay.openDashboard', async () => {
      const logger = getLogger();
      const dashboardFallback = resolveDashboardUrl();
      logger.info('[Dashboard] Opening dashboard...');

      try {
        const client = getDaemonClient();
        if (!client.isConnected()) {
          if (dashboardFallback) {
            logger.warn('[Dashboard] Daemon not connected, opening configured dashboard URL');
            vscode.env.openExternal(vscode.Uri.parse(dashboardFallback));
          } else {
            vscode.window.showWarningMessage('Abbenay is disabled. Enable it to open its dashboard.');
          }
          return;
        }

        const url = await openDashboardForClient(client);
        logger.info(`[Dashboard] Opening daemon dashboard at ${url}`);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        logger.error(`[Dashboard] Failed to start web server: ${msg}`);
        vscode.window.showErrorMessage(`Abbenay: Failed to open dashboard — ${msg}`);
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

  const chatCommandSubscriptions = [
    vscode.commands.registerCommand('abbenay.chat.newSession', () => {
      chat.newSession();
    }),
    vscode.commands.registerCommand('abbenay.chat.deleteSession', () => {
      chat.deleteSession();
    }),
    vscode.commands.registerCommand('abbenay.chat.settings', () => {
      vscode.commands.executeCommand('abbenay.configureProvider');
    }),
  ];
  context.subscriptions.push(...chatCommandSubscriptions);

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
