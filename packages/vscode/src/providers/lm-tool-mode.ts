/**
 * Language Model API tool routing for hosts (Copilot, etc.) that register tools
 * with Abbenay models.
 *
 * - passthrough (default): daemon returns tool_call chunks; the host executes
 *   tools with native VS Code UX (recommended for Copilot).
 * - auto: daemon runs the tool loop and invokes tools via the backchannel.
 */

import * as vscode from 'vscode';

export type LmToolModeSetting = 'passthrough' | 'auto';

export type DaemonChatToolMode = 'passthrough' | 'auto' | 'none';

export const LM_TOOL_MODE_DEFAULT: LmToolModeSetting = 'passthrough';

/** Map extension setting + whether the host sent tools → daemon ChatRequest.toolMode. */
export function resolveDaemonToolMode(
  hasClientTools: boolean,
  setting: LmToolModeSetting,
): DaemonChatToolMode {
  if (!hasClientTools) {
    return 'none';
  }
  return setting;
}

type LmToolModeConfig = Pick<vscode.WorkspaceConfiguration, 'get'>;

/** Read abbenay.lmToolMode; unknown values fall back to passthrough. */
export function readLmToolModeSetting(
  config: LmToolModeConfig = vscode.workspace.getConfiguration('abbenay'),
): LmToolModeSetting {
  const raw = config.get<string>('lmToolMode', LM_TOOL_MODE_DEFAULT);
  return raw === 'auto' ? 'auto' : 'passthrough';
}
