import * as readline from 'node:readline';
import { startDaemon } from './daemon.js';
import { isDaemonRunningSync } from './transport.js';
import { DaemonState } from './state.js';
import { promptModelPicker } from './chat.js';

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const YELLOW = '\x1b[33m';

export interface ModelPickerResult {
  model: string;
  state: DaemonState;
}

/**
 * Interactive model picker. Returns the chosen model AND the DaemonState
 * so callers can reuse it without a second startup.
 */
export async function selectModel(): Promise<ModelPickerResult | null> {
  let state: DaemonState;
  if (isDaemonRunningSync()) {
    state = new DaemonState();
  } else {
    state = await startDaemon({ keepAlive: false });
  }

  const models = await state.listModels();
  const usable = models.filter((m) => m.available !== false);
  if (usable.length === 0) {
    if (models.length > 0) {
      console.error(
        `${YELLOW}No usable models — saved models exist but API keys are missing in the daemon.${RESET} ` +
          `Open the web UI to fix provider credentials.`,
      );
    } else {
      console.error(
        `${YELLOW}No models configured.${RESET} Run: ${DIM}aby start${RESET} -> open the web UI to add a provider.`,
      );
    }
    return null;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: process.stdin.isTTY !== undefined,
  });

  try {
    const model = await promptModelPicker(usable, rl);
    if (!model) return null;
    return { model, state };
  } finally {
    rl.close();
  }
}
