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
import { VERSION } from '../version.js';

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

program
  .command('daemon')
  .description('Start the daemon (foreground)')
  .action(async () => {
    try {
      await startDaemon();
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
      console.log(`  Socket: ${status.socketPath}`);
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
  mcp?: boolean;
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
  const { port, mcp, bannerLines } = opts;

  if (isDaemonRunningSync()) {
    console.log('Daemon is running, requesting web server start via gRPC...');
    const { sendStartWebServer, sendStopWebServer } = await import('./web/grpc-web-control.js');
    const result = await sendStartWebServer(port);

    if (result.already_running) console.log('(server was already running)');

    if (mcp) {
      try {
        const http = await import('node:http');
        await new Promise<void>((resolve, reject) => {
          const req = http.request(`${result.url}/api/mcp-server/start`, { method: 'POST' }, (res) => {
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
    const daemonState = await startDaemon({ keepAlive: false });
    const { url, app } = await startEmbeddedWebServer(daemonState, port);

    if (mcp && app) {
      await daemonState.mcpServer.start(app);
    }

    for (const line of (bannerLines?.(url, !!mcp) ?? [`Server: ${url}`])) {
      console.log(line);
    }

    console.log('Press Ctrl+C to stop');
    await new Promise(() => {});
  }
}

// ── Server commands ─────────────────────────────────────────────────────

program
  .command('start')
  .description('Start all services (daemon, web dashboard, OpenAI API, MCP server)')
  .option('-p, --port <port>', 'Port to listen on', '8787')
  .action(async (options) => {
    const port = validatePort(options.port);
    try {
      await runServer({
        port,
        mcp: true,
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

program
  .command('web')
  .description('Start web dashboard')
  .option('-p, --port <port>', 'Port to listen on', '8787')
  .option('--mcp', 'Start MCP server on /mcp endpoint')
  .action(async (options) => {
    const port = validatePort(options.port);
    try {
      await runServer({
        port,
        mcp: options.mcp,
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

program
  .command('serve')
  .description('Start OpenAI-compatible API server (serves /v1/models, /v1/chat/completions)')
  .option('-p, --port <port>', 'Port to listen on', '8787')
  .option('--mcp', 'Start MCP server on /mcp endpoint')
  .action(async (options) => {
    const port = validatePort(options.port);
    try {
      await runServer({
        port,
        mcp: options.mcp,
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
      console.error('Either --model or --session is required');
      process.exit(1);
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
    const { SessionStore } = await import('../core/session-store.js');
    const { getSessionsDir } = await import('../core/paths.js');
    const store = new SessionStore(getSessionsDir());
    const result = await store.list({
      model: options.model,
      limit: Number(options.limit),
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
    const { SessionStore } = await import('../core/session-store.js');
    const { getSessionsDir } = await import('../core/paths.js');
    const store = new SessionStore(getSessionsDir());

    try {
      const session = await store.get(id);
      if (options.json) {
        console.log(JSON.stringify(session, null, 2));
      } else {
        console.log(`Session:  ${session.id}`);
        console.log(`Title:    ${session.title}`);
        console.log(`Model:    ${session.model}`);
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
    const { SessionStore } = await import('../core/session-store.js');
    const { getSessionsDir } = await import('../core/paths.js');
    const store = new SessionStore(getSessionsDir());

    try {
      await store.delete(id);
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
        e.requiresKey ? 'key-required' : 'keyless',
        e.supportsTools ? 'yes' : 'no',
        e.defaultBaseUrl || '-',
      ]);
      printTable(['Engine', 'Auth', 'Tools', 'Base URL'], rows);
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
