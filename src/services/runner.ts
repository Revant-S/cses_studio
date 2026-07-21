import { type ChildProcess, spawn } from 'child_process';
import type { Logger } from '../core/logger';

export interface RunRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly input: string;
  readonly timeoutMs: number;
  /** Cap on captured stdout/stderr; runaway output is truncated, not buffered. */
  readonly maxOutputBytes?: number;
  readonly signal?: AbortSignal;
}

export interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly truncated: boolean;
}

const DEFAULT_MAX_OUTPUT = 1024 * 1024; // 1 MiB

/** Executes a compiled binary or interpreter against a single input. */
export class ProcessRunner {
  private readonly log: Logger;

  constructor(logger: Logger) {
    this.log = logger.scoped('runner');
  }

  /** Runs a command to completion, feeding `input` on stdin. */
  async run(request: RunRequest): Promise<RunResult> {
    const maxOutput = request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
    const started = Date.now();

    return new Promise<RunResult>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(request.command, [...request.args], {
          cwd: request.cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (error) {
        reject(error);
        return;
      }

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let truncated = false;
      let timedOut = false;
      let settled = false;

      const collect = (chunks: Buffer[], chunk: Buffer, current: number): number => {
        if (current >= maxOutput) {
          truncated = true;
          return current;
        }
        const remaining = maxOutput - current;
        if (chunk.length > remaining) {
          chunks.push(chunk.subarray(0, remaining));
          truncated = true;
          return maxOutput;
        }
        chunks.push(chunk);
        return current + chunk.length;
      };

      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutBytes = collect(stdout, chunk, stdoutBytes);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrBytes = collect(stderr, chunk, stderrBytes);
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, request.timeoutMs);

      const onAbort = (): void => {
        child.kill('SIGKILL');
      };
      request.signal?.addEventListener('abort', onAbort, { once: true });

      const cleanup = (): void => {
        clearTimeout(timer);
        request.signal?.removeEventListener('abort', onAbort);
      };

      child.on('error', (error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      });

      child.on('close', (code, signal) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve({
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          exitCode: code,
          signal,
          durationMs: Date.now() - started,
          timedOut,
          truncated,
        });
      });

      child.stdin?.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EPIPE') {
          this.log.warn(`stdin error: ${error.message}`);
        }
      });
      child.stdin?.end(request.input);
    });
  }
}
