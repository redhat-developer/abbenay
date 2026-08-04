import * as vscode from 'vscode';
import { getLogger } from './logger';

/**
 * Open the IDE's chat interface, falling back to Abbenay's own sidebar
 * when no native chat is available.
 *
 * Chat provider routing (auto/vscode/abbenay/bob) is intentionally NOT
 * configurable here — that responsibility belongs to the consumer
 * extension (e.g. vscode-ansible's `ansibleEnvironments.llm.chatProvider`).
 * Abbenay simply defers to whatever native chat the IDE provides.
 */
export async function openChat(): Promise<void> {
  const logger = getLogger();
  const allCommands = await vscode.commands.getCommands(true);

  if (allCommands.includes('workbench.action.chat.open')) {
    logger.info('[ChatProvider] Opening native IDE chat');
    await vscode.commands.executeCommand('workbench.action.chat.open');
    return;
  }

  logger.info('[ChatProvider] No native chat available, falling back to Abbenay chat');
  try {
    await vscode.commands.executeCommand('abbenay.chatView.focus');
  } catch {
    vscode.window.showWarningMessage('No chat interface available.');
  }
}
