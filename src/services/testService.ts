import * as fs from 'fs/promises';
import * as path from 'path';
import type { ConfigurationProvider, Language } from '../core/config';
import { CompilationError } from '../core/errors';
import type { Logger } from '../core/logger';
import type { Sample } from '../models/sample';
import type { CompilerService } from './compiler';
import { type DiffLine, diffLines, firstDifference, outputsMatch } from './diff';
import type { ProcessRunner } from './runner';

/** Why a sample did not pass, or `passed` when it did. */
export type FailureKind = 'passed' | 'wrong-answer' | 'timeout' | 'runtime';

export interface SampleTestResult {
  readonly index: number;
  readonly passed: boolean;
  readonly kind: FailureKind;
  /** Short verdict shown next to the sample number. */
  readonly label: string;
  readonly input: string;
  readonly expected: string;
  readonly actual: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly diff: readonly DiffLine[];
  readonly summary?: string;
}

export interface RunSamplesRequest {
  readonly sourceFile: string;
  readonly language: Language;
  readonly samples: readonly Sample[];
  /** Problem time limit in seconds; the runner allows a configurable multiple. */
  readonly timeLimitSeconds?: number;
  readonly signal?: AbortSignal;
  readonly onResult?: (result: SampleTestResult) => void;
  readonly forceRebuild?: boolean;
}

export interface CustomTestRequest {
  readonly sourceFile: string;
  readonly language: Language;
  readonly input: string;
  readonly timeLimitSeconds?: number;
  readonly signal?: AbortSignal;
}

export interface CustomTestResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly timedOut: boolean;
}

/** Orchestrates build → run → compare. */
export class TestService {
  private readonly log: Logger;

  constructor(
    private readonly compiler: CompilerService,
    private readonly runner: ProcessRunner,
    private readonly config: ConfigurationProvider,
    logger: Logger,
  ) {
    this.log = logger.scoped('tests');
  }

  /** Loads sample files written by the workspace generator. */
  async readSamplesFromDisk(samplesDir: string): Promise<Sample[]> {
    return this.readCases(samplesDir, 'sample');
  }

  /** Loads judge cases imported from a failed submission. */
  async readJudgeCasesFromDisk(samplesDir: string): Promise<Sample[]> {
    return this.readCases(samplesDir, 'judge');
  }

  private async readCases(samplesDir: string, prefix: string): Promise<Sample[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(samplesDir);
    } catch {
      return [];
    }

    const pattern = new RegExp(`^${prefix}(\\d+)\\.in$`);
    const indices = entries
      .map((file) => pattern.exec(file)?.[1])
      .filter((value): value is string => value !== undefined)
      .map(Number)
      .sort((a, b) => a - b);

    const samples: Sample[] = [];
    for (const index of indices) {
      const input = await readOrEmpty(path.join(samplesDir, `${prefix}${index}.in`));
      const output = await readOrEmpty(path.join(samplesDir, `${prefix}${index}.out`));
      samples.push({ index, input, output });
    }
    return samples;
  }

  /** Compiles once, then runs every sample sequentially. */
  async runSamples(request: RunSamplesRequest): Promise<SampleTestResult[]> {
    const build = await this.compiler.build(request.sourceFile, request.language, {
      ...(request.forceRebuild !== undefined ? { force: request.forceRebuild } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
    });
    if (build.warnings.trim()) {
      this.log.warn(`Compiler warnings:\n${build.warnings.trim()}`);
    }

    const settings = this.config.get();
    const timeoutMs = this.timeoutFor(request.timeLimitSeconds);
    const results: SampleTestResult[] = [];

    for (const sample of request.samples) {
      if (request.signal?.aborted) {
        break;
      }
      const run = await this.runner.run({
        command: build.executable.command,
        args: build.executable.args,
        cwd: build.executable.cwd,
        input: sample.input,
        timeoutMs,
        ...(request.signal ? { signal: request.signal } : {}),
      });

      const options = { trimTrailingWhitespace: settings.trimTrailingWhitespace };
      const result = this.evaluate(sample, run, options);
      results.push(result);
      request.onResult?.(result);
    }

    return results;
  }

  private evaluate(
    sample: Sample,
    run: {
      stdout: string;
      stderr: string;
      exitCode: number | null;
      durationMs: number;
      timedOut: boolean;
    },
    options: { trimTrailingWhitespace: boolean },
  ): SampleTestResult {
    const base = {
      index: sample.index,
      input: sample.input,
      expected: sample.output,
      actual: run.stdout,
      stderr: run.stderr,
      durationMs: run.durationMs,
    };

    if (run.timedOut) {
      return {
        ...base,
        passed: false,
        kind: 'timeout',
        label: 'Time Limit Exceeded',
        diff: [],
        summary: 'The program did not finish within the allowed time.',
      };
    }

    if (run.exitCode !== 0) {
      return {
        ...base,
        passed: false,
        kind: 'runtime',
        label: `Runtime Error (exit ${run.exitCode})`,
        diff: [],
        summary: run.stderr.trim().split('\n')[0] ?? 'The program exited with a non-zero status.',
      };
    }

    if (outputsMatch(sample.output, run.stdout, options)) {
      return { ...base, passed: true, kind: 'passed', label: 'Passed', diff: [] };
    }

    const difference = firstDifference(sample.output, run.stdout, options);
    return {
      ...base,
      passed: false,
      kind: 'wrong-answer',
      label: 'Wrong Answer',
      diff: diffLines(sample.output, run.stdout, options),
      ...(difference
        ? {
            summary: `Line ${difference.line}: expected "${truncate(difference.expected)}", got "${truncate(difference.actual)}"`,
          }
        : {}),
    };
  }

  /** Runs the solution once against arbitrary input, leaving samples untouched. */
  async runCustom(request: CustomTestRequest): Promise<CustomTestResult> {
    const build = await this.compiler.build(request.sourceFile, request.language, {
      ...(request.signal ? { signal: request.signal } : {}),
    });

    const run = await this.runner.run({
      command: build.executable.command,
      args: build.executable.args,
      cwd: build.executable.cwd,
      input: request.input,
      timeoutMs: this.timeoutFor(request.timeLimitSeconds),
      ...(request.signal ? { signal: request.signal } : {}),
    });

    return {
      stdout: run.stdout,
      stderr: run.stderr,
      exitCode: run.exitCode,
      durationMs: run.durationMs,
      timedOut: run.timedOut,
    };
  }

  /** Local timeout budget. */
  private timeoutFor(timeLimitSeconds: number | undefined): number {
    const factor = Math.max(1, this.config.get().timeLimitFactor);
    const base = timeLimitSeconds ?? 1;
    return Math.max(2000, Math.round(base * factor * 1000));
  }
}

export function isCompilationError(error: unknown): error is CompilationError {
  return error instanceof CompilationError;
}

async function readOrEmpty(file: string): Promise<string> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return '';
  }
}

function truncate(text: string, max = 60): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
