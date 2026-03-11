import * as vscode from 'vscode';
import { Logger } from '../types';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Logger implementation using VS Code output channel
 */
class OutputChannelLogger implements Logger {
  private channel: vscode.OutputChannel;
  private minLevel: LogLevel;

  constructor(name: string, minLevel: LogLevel = 'info') {
    this.channel = vscode.window.createOutputChannel(name);
    this.minLevel = minLevel;
  }

  setLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[this.minLevel];
  }

  private formatMessage(level: LogLevel, message: string, args: unknown[]): string {
    const timestamp = new Date().toISOString();
    const levelStr = level.toUpperCase().padEnd(5);
    const formattedArgs = args.length > 0 
      ? ' ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')
      : '';
    return `[${timestamp}] [${levelStr}] ${message}${formattedArgs}`;
  }

  debug(message: string, ...args: unknown[]): void {
    if (this.shouldLog('debug')) {
      this.channel.appendLine(this.formatMessage('debug', message, args));
    }
  }

  info(message: string, ...args: unknown[]): void {
    if (this.shouldLog('info')) {
      this.channel.appendLine(this.formatMessage('info', message, args));
    }
  }

  warn(message: string, ...args: unknown[]): void {
    if (this.shouldLog('warn')) {
      this.channel.appendLine(this.formatMessage('warn', message, args));
    }
  }

  error(message: string, ...args: unknown[]): void {
    if (this.shouldLog('error')) {
      this.channel.appendLine(this.formatMessage('error', message, args));
    }
  }

  show(): void {
    this.channel.show();
  }

  dispose(): void {
    this.channel.dispose();
  }
}

// Singleton logger instance
let logger: OutputChannelLogger | undefined;

/**
 * Get or create the logger instance
 */
export function getLogger(): Logger {
  if (!logger) {
    const config = vscode.workspace.getConfiguration('openLLM');
    const level = config.get<LogLevel>('logLevel', 'info');
    logger = new OutputChannelLogger('Open LLM Provider', level);
  }
  return logger;
}

/**
 * Update logger level from configuration
 */
export function updateLogLevel(): void {
  if (logger) {
    const config = vscode.workspace.getConfiguration('openLLM');
    const level = config.get<LogLevel>('logLevel', 'info');
    logger.setLevel(level);
  }
}

/**
 * Dispose the logger
 */
export function disposeLogger(): void {
  if (logger) {
    logger.dispose();
    logger = undefined;
  }
}
