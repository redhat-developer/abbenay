import * as vscode from 'vscode';
import { DaemonClient } from '../../daemon/client';
import * as proto from '../../proto/abbenay/v1/service';
import {
  ProviderToHostMessage,
  ProviderInfo,
  ProviderTemplateInfo,
  EngineInfo,
  SecretInfoView,
  ModelInfo,
} from '../shared/types';
import { getLogger } from '../../utils/logger';

/**
 * Handle messages from the provider configuration webview
 */
export async function handleProviderMessage(
  message: ProviderToHostMessage,
  webview: vscode.Webview,
  client: DaemonClient,
): Promise<void> {
  const logger = getLogger();
  logger.debug('[ProviderHandler] Received message:', message.type);

  try {
    switch (message.type) {
      case 'ready':
        await handleReady(webview, client);
        break;

      case 'getProviders':
        await handleGetProviders(webview, client);
        break;

      case 'getProviderTemplates':
        await handleGetProviderTemplates(webview, client);
        break;

      case 'getEngines':
        await handleGetEngines(webview, client);
        break;

      case 'configureProvider':
        await handleConfigureProvider(message, webview, client);
        break;

      case 'removeProvider':
        await handleRemoveProvider(message, webview, client);
        break;

      case 'setSecret':
        await handleSetSecret(message, webview, client);
        break;

      case 'deleteSecret':
        await handleDeleteSecret(message, webview, client);
        break;

      case 'listSecrets':
        await handleListSecrets(webview, client);
        break;

      case 'getKeyStatus':
        await handleGetKeyStatus(message, webview, client);
        break;

      case 'discoverModels':
        await handleDiscoverModels(message, webview, client);
        break;

      case 'getConfig':
        await handleGetConfig(message, webview, client);
        break;

      case 'updateConfig':
        await handleUpdateConfig(message, webview, client);
        break;

      default:
        logger.warn('[ProviderHandler] Unknown message type:', (message as { type: string }).type);
    }
  } catch (error) {
    logger.error('[ProviderHandler] Error handling message:', error);
    webview.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
      context: message.type,
    });
  }
}

/**
 * Handle ready event - load initial data
 */
async function handleReady(webview: vscode.Webview, client: DaemonClient): Promise<void> {
  await Promise.all([
    handleGetProviders(webview, client),
    handleGetProviderTemplates(webview, client),
    handleGetEngines(webview, client),
    handleListSecrets(webview, client),
  ]);
}

/**
 * Get list of configured providers
 */
async function handleGetProviders(webview: vscode.Webview, client: DaemonClient): Promise<void> {
  const [providers, models] = await Promise.all([
    client.listProviders(),
    client.listModels(),
  ]);

  const modelCountByProvider = new Map<string, number>();
  for (const m of models) {
    const count = modelCountByProvider.get(m.provider) ?? 0;
    modelCountByProvider.set(m.provider, count + 1);
  }

  const providerInfo: ProviderInfo[] = providers.map((p) => ({
    id: p.id,
    engine: p.engine,
    configured: p.configured,
    healthy: p.healthy,
    requiresKey: p.requiresKey,
    baseUrl: p.baseUrl,
    modelCount: modelCountByProvider.get(p.id) ?? 0,
  }));

  webview.postMessage({
    type: 'providers',
    providers: providerInfo,
  });
}

/**
 * Get provider templates
 */
async function handleGetProviderTemplates(webview: vscode.Webview, client: DaemonClient): Promise<void> {
  const templates = await client.getProviderTemplates();

  const templateInfo: ProviderTemplateInfo[] = templates.map((t) => ({
    id: t.suggestedName,
    displayName: t.suggestedName,
    engine: t.engine,
    requiresKey: t.requiresKey,
    defaultBaseUrl: t.defaultBaseUrl,
  }));

  webview.postMessage({
    type: 'templates',
    templates: templateInfo,
  });
}

/**
 * Get available engines
 */
async function handleGetEngines(webview: vscode.Webview, client: DaemonClient): Promise<void> {
  const engines = await client.listEngines();

  const engineInfo: EngineInfo[] = engines.map((e) => ({
    id: e.id,
    requiresKey: e.requiresKey,
    defaultBaseUrl: e.defaultBaseUrl,
    defaultEnvVar: e.defaultEnvVar,
  }));

  webview.postMessage({
    type: 'engines',
    engines: engineInfo,
  });
}

/**
 * Configure a provider
 */
async function handleConfigureProvider(
  message: Extract<ProviderToHostMessage, { type: 'configureProvider' }>,
  webview: vscode.Webview,
  client: DaemonClient,
): Promise<void> {
  const logger = getLogger();

  try {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const workspacePath = workspaceFolders && workspaceFolders.length > 0
      ? workspaceFolders[0].uri.fsPath
      : undefined;

    // Step 1: Configure provider credentials via gRPC
    await client.configureProvider({
      providerId: message.providerId,
      engine: message.engine,
      apiKey: message.apiKey,
      envVarName: message.envVarName,
      baseUrl: message.baseUrl,
      target: message.target,
      workspacePath,
    });

    // Step 2: Save selected models into the config file (same approach as dashboard)
    if (message.models && Object.keys(message.models).length > 0) {
      const location = (message.target === 'workspace' && workspacePath) ? workspacePath : 'user';
      const configResponse = await client.getConfig(location);
      const config = (configResponse.config ?? {}) as Record<string, unknown>;
      const providers = ((config as Record<string, unknown>).providers ?? {}) as Record<string, Record<string, unknown>>;

      if (!providers[message.providerId]) {
        providers[message.providerId] = {};
      }

      providers[message.providerId].models = message.models;
      (config as Record<string, unknown>).providers = providers;

      await client.updateConfig(config as unknown as proto.Config, location);
    }

    logger.info('[ProviderHandler] Provider configured:', message.providerId);

    webview.postMessage({
      type: 'configureResult',
      success: true,
      providerId: message.providerId,
    });

    await handleGetProviders(webview, client);
  } catch (error) {
    logger.error('[ProviderHandler] Failed to configure provider:', error);
    webview.postMessage({
      type: 'configureResult',
      success: false,
      error: error instanceof Error ? error.message : String(error),
      providerId: message.providerId,
    });
  }
}

/**
 * Remove a provider
 */
async function handleRemoveProvider(
  message: Extract<ProviderToHostMessage, { type: 'removeProvider' }>,
  webview: vscode.Webview,
  client: DaemonClient,
): Promise<void> {
  const logger = getLogger();

  const answer = await vscode.window.showWarningMessage(
    `Remove provider "${message.providerId}"?`,
    { modal: true },
    'Remove',
  );
  if (answer !== 'Remove') {return;}

  try {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const workspacePath = workspaceFolders && workspaceFolders.length > 0
      ? workspaceFolders[0].uri.fsPath
      : undefined;

    await client.removeProvider(message.providerId, message.target, workspacePath);
    logger.info('[ProviderHandler] Provider removed:', message.providerId);

    await handleGetProviders(webview, client);
  } catch (error) {
    logger.error('[ProviderHandler] Failed to remove provider:', error);
    throw error;
  }
}

/**
 * Set a secret
 */
async function handleSetSecret(
  message: Extract<ProviderToHostMessage, { type: 'setSecret' }>,
  webview: vscode.Webview,
  client: DaemonClient,
): Promise<void> {
  const logger = getLogger();

  try {
    await client.setSecret(message.key, message.value);
    logger.info('[ProviderHandler] Secret set:', message.key);

    // Refresh secrets list
    await handleListSecrets(webview, client);
  } catch (error) {
    logger.error('[ProviderHandler] Failed to set secret:', error);
    throw error;
  }
}

/**
 * Delete a secret
 */
async function handleDeleteSecret(
  message: Extract<ProviderToHostMessage, { type: 'deleteSecret' }>,
  webview: vscode.Webview,
  client: DaemonClient,
): Promise<void> {
  const logger = getLogger();

  try {
    await client.deleteSecret(message.key);
    logger.info('[ProviderHandler] Secret deleted:', message.key);

    // Refresh secrets list
    await handleListSecrets(webview, client);
  } catch (error) {
    logger.error('[ProviderHandler] Failed to delete secret:', error);
    throw error;
  }
}

/**
 * List secrets
 */
async function handleListSecrets(webview: vscode.Webview, client: DaemonClient): Promise<void> {
  const secrets = await client.listSecrets();

  const secretInfo: SecretInfoView[] = secrets.map((s) => ({
    key: s.key,
    store: String(s.store),
    hasValue: s.hasValue,
  }));

  webview.postMessage({
    type: 'secrets',
    secrets: secretInfo,
  });
}

/**
 * Get key status
 */
async function handleGetKeyStatus(
  message: Extract<ProviderToHostMessage, { type: 'getKeyStatus' }>,
  webview: vscode.Webview,
  client: DaemonClient,
): Promise<void> {
  const exists = await client.getKeyStatus(message.source, message.name);

  webview.postMessage({
    type: 'keyStatus',
    source: message.source,
    name: message.name,
    exists,
  });
}

/**
 * Discover models
 */
async function handleDiscoverModels(
  message: Extract<ProviderToHostMessage, { type: 'discoverModels' }>,
  webview: vscode.Webview,
  client: DaemonClient,
): Promise<void> {
  const models = await client.discoverModels(message.engineId, {
    providerId: message.providerId,
    apiKey: message.apiKey,
    baseUrl: message.baseUrl,
  });

  const modelInfo: ModelInfo[] = models.map((m) => ({
    id: m.id,
    provider: m.provider,
    name: m.name,
    engine: m.engine,
  }));

  webview.postMessage({
    type: 'discoveredModels',
    models: modelInfo,
  });
}

/**
 * Get configuration
 */
async function handleGetConfig(
  message: Extract<ProviderToHostMessage, { type: 'getConfig' }>,
  webview: vscode.Webview,
  client: DaemonClient,
): Promise<void> {
  const response = await client.getConfig(message.location);

  webview.postMessage({
    type: 'config',
    config: response.config,
    path: response.path,
  });
}

/**
 * Update configuration
 */
async function handleUpdateConfig(
  message: Extract<ProviderToHostMessage, { type: 'updateConfig' }>,
  webview: vscode.Webview,
  client: DaemonClient,
): Promise<void> {
  const response = await client.updateConfig(message.config as unknown as proto.Config, message.location);

  webview.postMessage({
    type: 'config',
    config: response.config,
    path: response.path,
  });
}
