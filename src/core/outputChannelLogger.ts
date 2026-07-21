import * as vscode from 'vscode';
import type { Logger } from './logger';

/** {@link Logger} backed by a VS Code log output channel. */
export class OutputChannelLogger implements Logger {
  private constructor(
    private readonly channel: vscode.LogOutputChannel,
    private readonly prefix: string,
  ) {}

  static create(name: string): OutputChannelLogger {
    return new OutputChannelLogger(vscode.window.createOutputChannel(name, { log: true }), '');
  }

  scoped(scope: string): Logger {
    return new OutputChannelLogger(this.channel, this.prefix ? `${this.prefix}:${scope}` : scope);
  }

  debug(message: string, ...args: unknown[]): void {
    this.channel.debug(this.format(message), ...args);
  }

  info(message: string, ...args: unknown[]): void {
    this.channel.info(this.format(message), ...args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.channel.warn(this.format(message), ...args);
  }

  error(message: string, error?: unknown): void {
    if (error === undefined) {
      this.channel.error(this.format(message));
    } else {
      this.channel.error(this.format(message), error);
    }
  }

  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
  }

  private format(message: string): string {
    return this.prefix ? `[${this.prefix}] ${message}` : message;
  }
}
