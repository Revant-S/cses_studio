import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { ConfigurationProvider, Language } from '../core/config';
import { CompilationError } from '../core/errors';
import type { Logger } from '../core/logger';

/** How a prepared solution should be executed. */
export interface Executable {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

export interface BuildResult {
  readonly executable: Executable;
  /** Compiler warnings, empty for interpreted languages. */
  readonly warnings: string;
  /** True when compilation was skipped because the binary was up to date. */
  readonly cached: boolean;
}

/** Turns a source file into something runnable. */
export class CompilerService {
  private readonly log: Logger;

  constructor(
    private readonly config: ConfigurationProvider,
    logger: Logger,
  ) {
    this.log = logger.scoped('compiler');
  }

  async build(
    sourceFile: string,
    language: Language,
    options: { force?: boolean; signal?: AbortSignal } = {},
  ): Promise<BuildResult> {
    if (language === 'python') {
      return this.preparePython(sourceFile);
    }
    return this.compileCpp(sourceFile, options);
  }

  private async preparePython(sourceFile: string): Promise<BuildResult> {
    const { pythonCompiler } = this.config.get();
    await this.assertToolAvailable(pythonCompiler, 'Python interpreter');
    return {
      executable: {
        command: pythonCompiler,
        args: [sourceFile],
        cwd: path.dirname(sourceFile),
      },
      warnings: '',
      cached: false,
    };
  }

  private async compileCpp(
    sourceFile: string,
    options: { force?: boolean; signal?: AbortSignal },
  ): Promise<BuildResult> {
    const settings = this.config.get();
    const directory = path.dirname(sourceFile);
    const binary = path.join(
      directory,
      `${path.basename(sourceFile, path.extname(sourceFile))}${process.platform === 'win32' ? '.exe' : '.out'}`,
    );

    if (!options.force && (await this.isUpToDate(sourceFile, binary))) {
      this.log.debug(`Reusing up-to-date binary ${binary}`);
      return {
        executable: { command: binary, args: [], cwd: directory },
        warnings: '',
        cached: true,
      };
    }

    await this.assertToolAvailable(settings.cppCompiler, 'C++ compiler');

    const args = [...settings.cppArgs, sourceFile, '-o', binary];
    this.log.info(`${settings.cppCompiler} ${args.join(' ')}`);
    const result = await this.exec(settings.cppCompiler, args, directory, options.signal);

    if (result.code !== 0) {
      throw new CompilationError(
        `Compilation failed (exit code ${result.code}).`,
        result.stderr || result.stdout,
      );
    }

    return {
      executable: { command: binary, args: [], cwd: directory },
      warnings: result.stderr,
      cached: false,
    };
  }

  /** A binary is reusable when it exists and is strictly newer than its source. */
  private async isUpToDate(sourceFile: string, binary: string): Promise<boolean> {
    try {
      const [source, built] = await Promise.all([fs.stat(sourceFile), fs.stat(binary)]);
      return built.mtimeMs > source.mtimeMs;
    } catch {
      return false;
    }
  }

  private async assertToolAvailable(command: string, label: string): Promise<void> {
    if (command.includes(path.sep)) {
      try {
        await fs.access(command);
        return;
      } catch {
        throw new CompilationError(
          `${label} not found at "${command}". Update the cses.compiler.* setting.`,
          '',
        );
      }
    }

    const probe = process.platform === 'win32' ? 'where' : 'which';
    const result = await this.exec(probe, [command], os.tmpdir()).catch(() => undefined);
    if (!result || result.code !== 0) {
      throw new CompilationError(
        `${label} "${command}" was not found on PATH. Install it or update the cses.compiler.* setting.`,
        '',
      );
    }
  }

  private exec(
    command: string,
    args: readonly string[],
    cwd: string,
    signal?: AbortSignal,
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, [...args], { cwd });
      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });

      const onAbort = (): void => {
        child.kill('SIGKILL');
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      child.on('error', (error) => {
        signal?.removeEventListener('abort', onAbort);
        reject(error);
      });
      child.on('close', (code) => {
        signal?.removeEventListener('abort', onAbort);
        resolve({ code, stdout, stderr });
      });
    });
  }
}
