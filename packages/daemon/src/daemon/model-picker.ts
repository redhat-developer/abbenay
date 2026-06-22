import * as readline from 'node:readline';
import { startDaemon } from './daemon.js';
import { isDaemonRunningSync } from './transport.js';
import { DaemonState } from './state.js';
import { promptModelPicker } from './chat.js';

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const YELLOW = '\x1b[33m';

export async function selectModel(): Promise<string | null> {
  let state: DaemonState;
  if (isDaemonRunningSync()) {
    state = new DaemonState();
  } else {
    state = await startDaemon({ keepAlive: false });
  }

  const models = await state.listModels();
  if (models.length === 0) {
    console.error(
      `${YELLOW}No models configured.${RESET} Run: ${DIM}aby start${RESET} -> open the web UI to add a provider.`,
    );
    return null;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: process.stdin.isTTY !== undefined,
  });

  try {
    return await promptModelPicker(models, rl);
  } finally {
    rl.close();
  }
}
