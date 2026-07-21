export enum LogLevel {
  Debug = 0,
  Info = 1,
  Warn = 2,
  Error = 3,
}

/** Logging contract used throughout the service layer. */
export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, error?: unknown): void;
  /** Returns a logger that prefixes every line with `[scope]`. */
  scoped(scope: string): Logger;
}

/** Discards everything. */
export const nullLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  scoped: () => nullLogger,
};

/** Collects log lines in memory so tests can assert on them. */
export class MemoryLogger implements Logger {
  readonly lines: string[] = [];

  constructor(private readonly prefix = '') {}

  debug(message: string): void {
    this.push('DEBUG', message);
  }
  info(message: string): void {
    this.push('INFO', message);
  }
  warn(message: string): void {
    this.push('WARN', message);
  }
  error(message: string): void {
    this.push('ERROR', message);
  }

  scoped(scope: string): Logger {
    const child = new MemoryLogger(this.prefix ? `${this.prefix}:${scope}` : scope);
    // Share the backing array so assertions see every scope's output.
    Object.defineProperty(child, 'lines', { value: this.lines });
    return child;
  }

  private push(level: string, message: string): void {
    this.lines.push(`${level} ${this.prefix ? `[${this.prefix}] ` : ''}${message}`);
  }
}
