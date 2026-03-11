/**
 * Interactive CLI chat — `aby chat -m <model>`
 *
 * Starts the daemon in-process if not already running, then enters a
 * readline-based REPL that streams responses to stdout.
 *
 * Tool calls that match `require_approval` patterns pause and prompt the user
 * for approval before executing.
 */

import * as readline from 'node:readline';
import { startDaemon } from './daemon.js';
import { isDaemonRunningSync } from './transport.js';
import type { DaemonState } from './state.js';
import type { ChatToolOptions } from '../core/state.js';

interface ChatOptions {
  model: string;
  system?: string;
  policy?: string;
  tools?: boolean;
  json?: boolean;
}

const RESET  = '\x1b[0m';
const BOLD   = '\x1b[1m';
const DIM    = '\x1b[2m';
const CYAN   = '\x1b[36m';
const YELLOW = '\x1b[33m';
const GREEN  = '\x1b[32m';
const RED    = '\x1b[31m';

export async function runInteractiveChat(options: ChatOptions): Promise<void> {
  let state: DaemonState;

  // Start daemon in-process if not already running
  if (isDaemonRunningSync()) {
    console.error(`${DIM}Daemon already running — connecting...${RESET}`);
    // For now, start a lightweight in-process state (no gRPC overhead)
    state = await startDaemon({ keepAlive: false });
  } else {
    console.error(`${DIM}Starting daemon...${RESET}`);
    state = await startDaemon({ keepAlive: false });
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    prompt: `${CYAN}you>${RESET} `,
    terminal: process.stdin.isTTY !== undefined,
  });

  const messages: Array<{ role: string; content: string }> = [];

  if (options.system) {
    messages.push({ role: 'system', content: options.system });
  }

  console.error(`${BOLD}Abbenay Chat${RESET} — model: ${CYAN}${options.model}${RESET}`);
  console.error(`${DIM}Type your message, then press Enter. Ctrl+D to exit.${RESET}\n`);

  if (options.json) {
    await runJsonMode(state, options, messages, rl);
  } else {
    await runInteractiveMode(state, options, messages, rl);
  }
}

async function runInteractiveMode(
  state: DaemonState,
  options: ChatOptions,
  messages: Array<{ role: string; content: string }>,
  rl: readline.Interface,
): Promise<void> {
  const prompt = (): Promise<string | null> => {
    return new Promise((resolve) => {
      rl.prompt();
      rl.once('line', (line) => resolve(line));
      rl.once('close', () => resolve(null));
    });
  };

  while (true) {
    const input = await prompt();
    if (input === null) {
      console.error(`\n${DIM}Goodbye.${RESET}`);
      break;
    }

    const trimmed = input.trim();
    if (!trimmed) continue;

    messages.push({ role: 'user', content: trimmed });

    const toolOptions: ChatToolOptions = {
      toolMode: options.tools === false ? 'none' : 'auto',
      onToolApprovalNeeded: async (_requestId: string, toolName: string, args: any): Promise<'allow' | 'deny' | 'abort'> => {
        process.stderr.write(`\n${YELLOW}⚠ Tool approval required:${RESET} ${BOLD}${toolName}${RESET}\n`);
        process.stderr.write(`${DIM}Arguments:${RESET} ${JSON.stringify(args, null, 2)}\n`);
        return promptApproval(rl);
      },
    };

    process.stderr.write(`\n${BOLD}assistant>${RESET} `);

    let fullResponse = '';
    try {
      for await (const chunk of state.chat(options.model, messages, undefined, toolOptions)) {
        if (chunk.type === 'text' && chunk.text) {
          process.stdout.write(chunk.text);
          fullResponse += chunk.text;
        } else if (chunk.type === 'tool') {
          if (!chunk.done) {
            process.stderr.write(`\n${CYAN}🔧 ${chunk.name}${RESET}(${DIM}${JSON.stringify(chunk.call?.params || {}).substring(0, 100)}${RESET})\n`);
          } else {
            const result = typeof chunk.call?.result === 'string'
              ? chunk.call.result.substring(0, 200)
              : JSON.stringify(chunk.call?.result || {}).substring(0, 200);
            process.stderr.write(`${GREEN}✓${RESET} ${DIM}${result}${RESET}\n`);
          }
        } else if (chunk.type === 'error') {
          process.stderr.write(`\n${RED}Error: ${chunk.error}${RESET}\n`);
        }
      }
    } catch (err: any) {
      process.stderr.write(`\n${RED}Error: ${err.message}${RESET}\n`);
    }

    process.stdout.write('\n');
    if (fullResponse) {
      messages.push({ role: 'assistant', content: fullResponse });
    }
  }

  rl.close();
  process.exit(0);
}

async function runJsonMode(
  state: DaemonState,
  options: ChatOptions,
  messages: Array<{ role: string; content: string }>,
  rl: readline.Interface,
): Promise<void> {
  // In JSON mode, read all of stdin as a single message
  const chunks: string[] = [];
  for await (const line of rl) {
    chunks.push(line);
  }
  const input = chunks.join('\n').trim();
  if (!input) {
    process.exit(0);
  }

  messages.push({ role: 'user', content: input });

  const toolOptions: ChatToolOptions = {
    toolMode: options.tools === false ? 'none' : 'auto',
  };

  for await (const chunk of state.chat(options.model, messages, undefined, toolOptions)) {
    process.stdout.write(JSON.stringify(chunk) + '\n');
  }
}

function promptApproval(rl: readline.Interface): Promise<'allow' | 'deny' | 'abort'> {
  return new Promise((resolve) => {
    process.stderr.write(`${YELLOW}[a]llow / [d]eny / a[b]ort all?${RESET} `);

    const handler = (line: string) => {
      const answer = line.trim().toLowerCase();
      if (answer === 'a' || answer === 'allow' || answer === 'y' || answer === 'yes') {
        resolve('allow');
      } else if (answer === 'd' || answer === 'deny' || answer === 'n' || answer === 'no') {
        resolve('deny');
      } else if (answer === 'b' || answer === 'abort') {
        resolve('abort');
      } else {
        process.stderr.write(`${YELLOW}[a]llow / [d]eny / a[b]ort all?${RESET} `);
        rl.once('line', handler);
        return;
      }
    };

    rl.once('line', handler);
  });
}
