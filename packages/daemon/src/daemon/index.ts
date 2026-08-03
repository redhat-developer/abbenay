#!/usr/bin/env node
/**
 * Abbenay Daemon - TypeScript Implementation
 * 
 * Usage:
 *   abbenay start         # Start all services (daemon, web, API, MCP)
 *   abbenay daemon        # Start daemon only (gRPC, no web server)
 *   abbenay web           # Start web dashboard
 *   abbenay serve         # Start OpenAI-compatible API server
 *   abbenay chat          # Interactive chat
 *   abbenay sessions      # Manage saved sessions
 *   abbenay status        # Check daemon status
 *   abbenay stop          # Stop running daemon
 *   abbenay list-engines  # List supported engines
 *   abbenay list-models   # List configured models
 */

import { Command } from 'commander';
import { startDaemon, stopDaemon, getDaemonStatus } from './daemon.js';
import { isDaemonRunningSync } from './transport.js';
import { startEmbeddedWebServer } from './web/server.js';
import { getEngines, fetchModels } from '../core/engines.js';
import { DEFAULT_WEB_PORT } from '../core/constants.js';
import { VERSION } from '../version.js';
import { resolveHttpApiToken } from './web/http-security.js';
import type { GrpcTlsOptions } from './grpc-tls.js';

/** Shared CLI flags for TCP gRPC bind + TLS / consumer-auth policy. */
function addGrpcBindOptions(cmd: Command): Command {
  return cmd
    .option('--grpc-port <port>', 'Also listen for gRPC on this TCP port (for remote/container access)')
    .option('--grpc-host <host>', 'Host/IP to bind gRPC TCP listener (default: 127.0.0.1, use 0.0.0.0 for containers)')
    .option('--grpc-tls', 'Enable TLS on the TCP gRPC listener (auto-generates self-signed certs)')
    .option('--insecure', 'Allow plaintext gRPC on non-loopback binds (not recommended; prefer --grpc-tls). Also permits empty consumers (open auth).')
    .option(
      '--allow-open-auth',
      'Allow empty consumers on non-loopback gRPC binds (not recommended; configure consumers instead)',
    );
}

function grpcTlsFromCli(options: {
  grpcTls?: boolean;
  insecure?: boolean;
}): GrpcTlsOptions {
  return {
    enabled: !!options.grpcTls,
    insecure: !!options.insecure,
  };
}

function allowOpenAuthFromCli(options: {
  allowOpenAuth?: boolean;
  insecure?: boolean;
}): boolean {
  return !!options.allowOpenAuth || !!options.insecure;
}

function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map(r => (r[i] || '').length)),
  );
  console.log(headers.map((h, i) => h.toUpperCase().padEnd(widths[i])).join('  '));
  for (const row of rows) {
    console.log(row.map((c, i) => (c || '').padEnd(widths[i])).join('  '));
  }
}

const program = new Command();

program
  .name('abbenay')
  .description('Abbenay - Unified AI Daemon')
  .version(VERSION)
  .option('--verbose', 'Enable debug logging (same as ABBENAY_DEBUG=1)')
  .hook('preAction', () => {
    if (program.opts().verbose) {
      process.env.ABBENAY_DEBUG = '1';
    }
  });

addGrpcBindOptions(
  program
    .command('daemon')
    .description('Start the daemon (foreground)'),
)
  .action(async (options) => {
    try {
      await startDaemon({
        grpcPort: options.grpcPort ? validatePort(options.grpcPort) : undefined,
        grpcHost: options.grpcHost,
        grpcTls: grpcTlsFromCli(options),
        allowOpenAuth: allowOpenAuthFromCli(options),
      });
    } catch (error) {
      console.error('Failed to start daemon:', error);
      process.exit(1);
    }
  });

program
  .command('status')
  .description('Check if daemon is running')
  .action(() => {
    const status = getDaemonStatus();
    if (status.running) {
      console.log('Abbenay daemon is running');
      if (status.pid) {
        console.log(`  PID: ${status.pid}`);
      }
      console.log(
        process.platform === 'win32'
          ? `  Address: ${status.socketPath}`
          : `  Socket: ${status.socketPath}`,
      );
    } else {
      console.log('Abbenay daemon is not running');
      process.exit(1);
    }
  });

program
  .command('stop')
  .description('Stop the running daemon')
  .action(async () => {
    try {
      await stopDaemon();
      console.log('Daemon stopped');
    } catch (error) {
      console.error('Failed to stop daemon:', error);
      process.exit(1);
    }
  });

// ── Shared server lifecycle ─────────────────────────────────────────────

interface ServerOptions {
  port: number;
  host?: string;
  mcp?: boolean;
  grpcPort?: number;
  grpcHost?: string;
  grpcTls?: GrpcTlsOptions;
  allowOpenAuth?: boolean;
  /** Lines printed after the server URL, before "Press Ctrl+C" */
  bannerLines?: (url: string, mcpStarted: boolean) => string[];
}

function validatePort(raw: string): number {
  if (!/^\d+$/.test(raw)) {
    console.error(`Invalid port: "${raw}". Must be an integer between 1 and 65535.`);
    process.exit(1);
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`Invalid port: "${raw}". Must be an integer between 1 and 65535.`);
    process.exit(1);
  }
  return port;
}

async function runServer(opts: ServerOptions): Promise<void> {
  const { port, host, mcp, grpcPort, grpcHost, grpcTls, allowOpenAuth, bannerLines } = opts;
  const { token: apiToken, source: tokenSource } = resolveHttpApiToken();
  const authEnabled = tokenSource !== 'disabled';

  if (isDaemonRunningSync()) {
    console.log('Daemon is running, requesting web server start via gRPC...');
    const { sendStartWebServer, sendStopWebServer } = await import('./web/grpc-web-control.js');
    const result = await sendStartWebServer(port);

    if (result.already_running) console.log('(server was already running)');

    if (mcp) {
      try {
        const http = await import('node:http');
        await new Promise<void>((resolve, reject) => {
          const headers: Record<string, string> = {};
          if (authEnabled && apiToken) {
            headers.Authorization = `Bearer ${apiToken}`;
          }
          const req = http.request(`${result.url}/api/mcp-server/start`, {
            method: 'POST',
            headers,
          }, (res) => {
            res.resume();
            res.on('end', () => resolve());
          });
          req.on('error', reject);
          req.end();
        });
      } catch {
        console.warn('Warning: could not start MCP server on existing daemon');
      }
    }

    for (const line of (bannerLines?.(result.url, !!mcp) ?? [`Server: ${result.url}`])) {
      console.log(line);
    }

    await new Promise<void>((resolve) => {
      const shutdown = async () => {
        console.log('\nStopping server...');
        try { await sendStopWebServer(); } catch { /* ignore */ }
        resolve();
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    });
  } else {
    console.log('No daemon running, starting in-process...');
    const daemonState = await startDaemon({
      keepAlive: false,
      grpcPort,
      grpcHost,
      httpPort: port,
      grpcTls,
      allowOpenAuth,
    });
    const { url, app, security } = await startEmbeddedWebServer(daemonState, port, host);
    if (mcp && app) {
      await daemonState.mcpServer.start(app);
    }

    for (const line of (bannerLines?.(url, !!mcp) ?? [`Server: ${url}`])) {
      console.log(line);
    }
    if (security.tokenSource === 'generated' || security.generated) {
      console.log(`API token file: use Authorization: Bearer <token> (see http-api-token in config dir)`);
    }

    console.log('Press Ctrl+C to stop');
    await new Promise(() => {});
  }
}

// ── Server commands ─────────────────────────────────────────────────────

addGrpcBindOptions(
  program
    .command('start')
    .description('Start all services (daemon, web dashboard, OpenAI API, MCP server)')
    .option('-p, --port <port>', 'Port to listen on', String(DEFAULT_WEB_PORT))
    .option('--host <host>', 'Host/IP to bind HTTP listener (default: 127.0.0.1, use 0.0.0.0 for containers)'),
)
  .action(async (options) => {
    const port = validatePort(options.port);
    try {
      const grpcPort = options.grpcPort ? validatePort(options.grpcPort) : undefined;
      const grpcHost = options.grpcHost;
      const grpcTls = grpcTlsFromCli(options);
      await runServer({
        port,
        host: options.host || undefined,
        mcp: true,
        grpcPort,
        grpcHost,
        grpcTls,
        allowOpenAuth: allowOpenAuthFromCli(options),
        bannerLines: (url, mcpStarted) => {
          const lines = [
            '',
            `  Abbenay is running on ${url}`,
            '',
            `    Dashboard  ${url}`,
            `    REST API   ${url}/api/*`,
            `    OpenAI API ${url}/v1/chat/completions`,
            `    Models     ${url}/v1/models`,
          ];
          if (mcpStarted) lines.push(`    MCP        ${url}/mcp`);
          if (grpcPort) {
            const mode = grpcTls.enabled ? 'TLS' : (grpcTls.insecure ? 'insecure' : 'plaintext');
            lines.push(`    gRPC       ${grpcHost ?? '127.0.0.1'}:${grpcPort} (${mode})`);
          }
          lines.push('');
          return lines;
        },
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('Failed to start:', msg);
      process.exit(1);
    }
  });

addGrpcBindOptions(
  program
    .command('web')
    .description('Start web dashboard')
    .option('-p, --port <port>', 'Port to listen on', String(DEFAULT_WEB_PORT))
    .option('--host <host>', 'Host/IP to bind HTTP listener (default: 127.0.0.1, use 0.0.0.0 for containers)')
    .option('--mcp', 'Start MCP server on /mcp endpoint'),
)
  .action(async (options) => {
    const port = validatePort(options.port);
    try {
      await runServer({
        port,
        host: options.host || undefined,
        mcp: options.mcp,
        grpcPort: options.grpcPort ? validatePort(options.grpcPort) : undefined,
        grpcHost: options.grpcHost,
        grpcTls: grpcTlsFromCli(options),
        allowOpenAuth: allowOpenAuthFromCli(options),
        bannerLines: (url, mcpStarted) => {
          const lines = [`Abbenay Web Dashboard: ${url}`];
          if (mcpStarted) lines.push(`MCP Server: ${url}/mcp`);
          return lines;
        },
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('Failed to start web server:', msg);
      process.exit(1);
    }
  });

addGrpcBindOptions(
  program
    .command('serve')
    .description('Start OpenAI-compatible API server (serves /v1/models, /v1/chat/completions)')
    .option('-p, --port <port>', 'Port to listen on', String(DEFAULT_WEB_PORT))
    .option('--host <host>', 'Host/IP to bind HTTP listener (default: 127.0.0.1, use 0.0.0.0 for containers)')
    .option('--mcp', 'Start MCP server on /mcp endpoint'),
)
  .action(async (options) => {
    const port = validatePort(options.port);
    try {
      await runServer({
        port,
        host: options.host || undefined,
        mcp: options.mcp,
        grpcPort: options.grpcPort ? validatePort(options.grpcPort) : undefined,
        grpcHost: options.grpcHost,
        grpcTls: grpcTlsFromCli(options),
        allowOpenAuth: allowOpenAuthFromCli(options),
        bannerLines: (url, mcpStarted) => {
          const lines = [
            `Abbenay API server: ${url}`,
            `OpenAI-compatible endpoint: ${url}/v1/chat/completions`,
          ];
          if (mcpStarted) lines.push(`MCP Server: ${url}/mcp`);
          return lines;
        },
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('Failed to start API server:', msg);
      process.exit(1);
    }
  });

program
  .command('chat')
  .description('Interactive chat with an AI model')
  .option('-m, --model <id>', 'Model to use (e.g. openai/gpt-4o)')
  .option('--session <id>', 'Resume or create a session ("new" to create)')
  .option('-s, --system <prompt>', 'System prompt')
  .option('-p, --policy <name>', 'Apply a named policy')
  .option('--no-tools', 'Disable tool use')
  .option('--json', 'Output raw JSON chunks (for piping)')
  .action(async (options) => {
    if (!options.model && !options.session) {
      const { selectModel } = await import('./model-picker.js');
      const result = await selectModel();
      if (!result) process.exit(1);
      options.model = result.model;
      options.state = result.state;
    }
    const { runInteractiveChat } = await import('./chat.js');
    await runInteractiveChat(options);
  });

// ── Session commands ────────────────────────────────────────────────────

const sessions = program
  .command('sessions')
  .description('Manage chat sessions');

sessions
  .command('list')
  .description('List saved sessions')
  .option('--model <model>', 'Filter by model')
  .option('--limit <n>', 'Max results', '20')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    const { SessionStore, LOCAL_SESSION_OWNER } = await import('../core/session-store.js');
    const { getSessionsDir } = await import('../core/paths.js');
    const store = new SessionStore(getSessionsDir());
    const result = await store.list({
      model: options.model,
      limit: Number(options.limit),
      owner: LOCAL_SESSION_OWNER,
    });

    if (options.json) {
      console.log(JSON.stringify(result));
    } else if (result.sessions.length === 0) {
      console.log('No sessions found.');
    } else {
      const rows = result.sessions.map((s) => [
        s.id.substring(0, 8),
        s.title.substring(0, 40),
        s.model,
        String(s.messageCount),
        new Date(s.updatedAt).toLocaleString(),
        (s.summary || '').substring(0, 50),
      ]);
      printTable(['ID', 'Title', 'Model', 'Msgs', 'Updated', 'Summary'], rows);
      console.log(`\n${result.totalCount} session(s) total`);
    }
  });

sessions
  .command('show <id>')
  .description('Show session messages')
  .option('--json', 'Output as JSON')
  .action(async (id: string, options) => {
    const { SessionStore, LOCAL_SESSION_OWNER } = await import('../core/session-store.js');
    const { getSessionsDir } = await import('../core/paths.js');
    const store = new SessionStore(getSessionsDir());

    try {
      const session = await store.getOwned(id, LOCAL_SESSION_OWNER);
      if (options.json) {
        console.log(JSON.stringify(session, null, 2));
      } else {
        console.log(`Session:  ${session.id}`);
        console.log(`Title:    ${session.title}`);
        console.log(`Model:    ${session.model}`);
        console.log(`Owner:    ${session.owner || LOCAL_SESSION_OWNER}`);
        console.log(`Created:  ${session.createdAt}`);
        console.log(`Updated:  ${session.updatedAt}`);
        console.log(`Messages: ${session.messages.length}`);
        if (session.summary) {
          console.log(`Summary:  ${session.summary}`);
        }
        console.log();
        for (const msg of session.messages) {
          const label = msg.role === 'user' ? 'you' : msg.role;
          console.log(`[${label}] ${msg.content}\n`);
        }
      }
    } catch {
      console.error(`Session not found: ${id}`);
      process.exit(1);
    }
  });

sessions
  .command('delete <id>')
  .description('Delete a session')
  .action(async (id: string) => {
    const { SessionStore, LOCAL_SESSION_OWNER } = await import('../core/session-store.js');
    const { getSessionsDir } = await import('../core/paths.js');
    const store = new SessionStore(getSessionsDir());

    try {
      await store.deleteOwned(id, LOCAL_SESSION_OWNER);
      console.log(`Deleted session: ${id}`);
    } catch {
      console.error(`Session not found: ${id}`);
      process.exit(1);
    }
  });

program
  .command('list-engines')
  .description('List available engines (API implementations)')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    const engines = getEngines()
      .map((e) => ({
        id: e.id,
        displayName: e.displayName || e.id,
        requiresKey: e.requiresKey,
        defaultBaseUrl: e.defaultBaseUrl,
        supportsTools: e.supportsTools,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));

    if (options.json) {
      console.log(JSON.stringify(engines));
    } else {
      const rows = engines.map(e => [
        e.id,
        e.displayName !== e.id ? e.displayName : '',
        e.requiresKey ? 'key-required' : 'keyless',
        e.supportsTools ? 'yes' : 'no',
        e.defaultBaseUrl || '-',
      ]);
      printTable(['Engine', 'Display Name', 'Auth', 'Tools', 'Base URL'], rows);
    }
  });

program
  .command('list-models')
  .description('List configured models (usable with chat -m)')
  .option('--json', 'Output as JSON')
  .option('--discover <engine>', 'Query an engine API for all available model IDs')
  .option('--api-key <key>', 'API key (for --discover with key-required engines)')
  .option('--base-url <url>', 'Base URL override (for --discover)')
  .action(async (options) => {
    if (options.discover) {
      const engine = getEngines().find(e => e.id === options.discover);
      if (!engine) {
        console.error(`Unknown engine: ${options.discover}`);
        console.error(`Run 'abbenay list-engines' to see available engines.`);
        process.exit(1);
      }

      const apiKey = options.apiKey
        || (engine.defaultEnvVar ? process.env[engine.defaultEnvVar] : undefined);

      if (engine.requiresKey && !apiKey) {
        console.error(`Engine "${engine.id}" requires an API key.`);
        if (engine.defaultEnvVar) {
          console.error(`Set ${engine.defaultEnvVar} or pass --api-key.`);
        }
        process.exit(1);
      }

      const models = await fetchModels(engine.id, apiKey, options.baseUrl);
      models.sort((a, b) => a.id.localeCompare(b.id));

      if (options.json) {
        console.log(JSON.stringify(models));
      } else if (models.length === 0) {
        console.log('No models found.');
      } else {
        const rows = models.map(m => [m.id, m.contextWindow ? String(m.contextWindow) : '-']);
        printTable(['Model ID', 'Context Window'], rows);
      }
      return;
    }

    const { CoreState } = await import('../core/state.js');
    const { KeychainSecretStore } = await import('./secrets/keychain.js');
    const state = new CoreState({ secretStore: new KeychainSecretStore() });
    const models = await state.listModels();
    models.sort((a, b) => a.id.localeCompare(b.id));

    if (options.json) {
      console.log(JSON.stringify(models));
    } else if (models.length === 0) {
      console.log('No models configured.');
      console.log('Add providers and models to your config, or use --discover <engine> to explore.');
    } else {
      const rows = models.map(m => [m.id, m.engine]);
      printTable(['Model ID', 'Engine'], rows);
      console.log(`\nUse with: abbenay chat -m <MODEL ID>`);
    }
  });

// Default: show help
if (process.argv.length <= 2) {
  program.help();
}

program.parse();
