import * as vscode from 'vscode';
import { getLogger, updateLogLevel, disposeLogger } from './utils/logger';
import { 
  initializeDaemon, 
  shutdownDaemon, 
  setExtensionPath,
  getDaemonClient,
  BackchannelHandler
} from './daemon';
import { AbbenayLanguageModelProvider } from './providers';

// Default dashboard URL - daemon serves web UI here
const DASHBOARD_URL = 'http://localhost:8787';

let daemonConnected = false;
let languageModelProvider: AbbenayLanguageModelProvider | null = null;
let backchannelHandler: BackchannelHandler | null = null;

export async function activate(context: vscode.ExtensionContext) {
  console.log('[Abbenay] activate() called');
  const logger = getLogger();
  logger.info('Open LLM Provider activating...');

  // Set extension path for finding bundled daemon binary
  setExtensionPath(context.extensionPath);
  console.log('[Abbenay] extensionPath:', context.extensionPath);

  // Initialize daemon connection (auto-starts daemon if not running)
  try {
    logger.info('[Daemon] Connecting to Abbenay daemon...');
    await initializeDaemon();
    logger.info('[Daemon] Connected and registered');
    daemonConnected = true;
    
    // Check daemon health
    const client = getDaemonClient();
    const healthy = await client.healthCheck();
    if (healthy) {
      logger.info('[Daemon] Health check passed');
    } else {
      logger.warn('[Daemon] Health check failed');
    }

    // Start the Language Model Provider to expose models to VS Code
    languageModelProvider = new AbbenayLanguageModelProvider(client);
    await languageModelProvider.start();
    logger.info('[LMProvider] Language Model Provider started');

    // Start the backchannel for daemon → VS Code callbacks (workspace queries, tool invocation, etc.)
    backchannelHandler = new BackchannelHandler(client, context);
    
    // Wire up ModelsChanged notifications: daemon push → LM provider refresh
    backchannelHandler.onModelsChanged = () => {
      if (languageModelProvider) {
        logger.info('[Extension] ModelsChanged notification → refreshing LM provider');
        languageModelProvider.refreshModels().catch(e => {
          logger.warn('[Extension] Failed to refresh models after notification:', e);
        });
      }
    };
    
    // Listen for VS Code tool changes and push updates to daemon
    context.subscriptions.push(backchannelHandler.setupToolChangeListener());
    
    backchannelHandler.start().catch(e => {
      logger.warn('[Backchannel] Failed to start:', e);
    });
    logger.info('[Backchannel] Started');
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error(`[Daemon] Failed to connect: ${msg}`);
    if (e instanceof Error && e.stack) {
      logger.error(`[Daemon] Stack: ${e.stack}`);
    }
    vscode.window.showWarningMessage(
      `Abbenay: Could not connect to daemon — ${msg}`
    );
  }

  // Register commands
  registerCommands(context);

  // Create status bar item
  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.text = daemonConnected ? '$(sparkle) Abbenay' : '$(warning) Abbenay';
  statusBarItem.tooltip = daemonConnected 
    ? 'Abbenay Daemon Connected - Click to open dashboard' 
    : 'Abbenay Daemon Not Connected';
  statusBarItem.command = 'abbenay.openDashboard';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Watch for configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('abbenay.logLevel')) {
        updateLogLevel();
      }
    })
  );

  logger.info('Abbenay Provider activated');
}

export async function deactivate() {
  const logger = getLogger();
  logger.info('Abbenay Provider deactivating...');
  
  // Stop the backchannel
  if (backchannelHandler) {
    await backchannelHandler.stop();
    backchannelHandler = null;
    logger.info('[Backchannel] Stopped');
  }

  // Stop the Language Model Provider
  if (languageModelProvider) {
    languageModelProvider.stop();
    languageModelProvider = null;
    logger.info('[LMProvider] Language Model Provider stopped');
  }
  
  try {
    await shutdownDaemon();
    logger.info('[Daemon] Disconnected');
  } catch (e) {
    logger.error('[Daemon] Error during shutdown:', e);
  }
  
  disposeLogger();
}

function registerCommands(context: vscode.ExtensionContext): void {
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
          `Started: ${startedAt}`,
          `Clients: ${status.connectedClients || 0}`,
          `Sessions: ${status.activeSessions || 0}`,
        ].join('\n');
        
        vscode.window.showInformationMessage(msg, 'Open Dashboard').then(action => {
          if (action === 'Open Dashboard') {
            vscode.env.openExternal(vscode.Uri.parse(DASHBOARD_URL));
          }
        });
      } catch (e) {
        console.error('[Abbenay] daemonStatus error:', e);
        vscode.window.showErrorMessage(
          `Abbenay: Cannot get daemon status. Is the daemon running?`,
          'Open Dashboard Anyway'
        ).then(action => {
          if (action === 'Open Dashboard Anyway') {
            vscode.env.openExternal(vscode.Uri.parse(DASHBOARD_URL));
          }
        });
      }
    })
  );

  // Open dashboard command - starts web server via gRPC, then opens browser
  context.subscriptions.push(
    vscode.commands.registerCommand('abbenay.openDashboard', async () => {
      const logger = getLogger();
      logger.info('[Dashboard] Opening dashboard...');
      
      try {
        const client = getDaemonClient();
        if (!client.isConnected()) {
          // Daemon not connected — open URL anyway, user may have started web manually
          logger.warn('[Dashboard] Daemon not connected, opening URL directly');
          vscode.env.openExternal(vscode.Uri.parse(DASHBOARD_URL));
          return;
        }
        
        // Send gRPC request to start the embedded web server
        const response = await client.startWebServer(8787);
        const url = response.url || DASHBOARD_URL;
        
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
        vscode.env.openExternal(vscode.Uri.parse(DASHBOARD_URL));
      }
    })
  );

  // Configure provider command - opens dashboard for API key configuration
  context.subscriptions.push(
    vscode.commands.registerCommand('abbenay.configureProvider', () => {
      console.log('[Abbenay] configureProvider command');
      vscode.env.openExternal(vscode.Uri.parse(DASHBOARD_URL));
    })
  );
}
