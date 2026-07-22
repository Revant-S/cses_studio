import * as fs from 'fs/promises';
import * as path from 'path';
import {
  type ConfigurationProvider,
  fileExtensionFor,
  type Language,
  languageForExtension,
} from '../core/config';
import type { Logger } from '../core/logger';
import { DEFAULT_JUDGE, type JudgeId } from '../models/judge';
import type { Problem } from '../models/problem';

/** Marker file written into each problem directory, linking it back to CSES. */
export interface WorkspaceMetadata {
  /** Judge this problem came from; absent in workspaces created before multi-judge support. */
  readonly judge?: JudgeId;
  readonly problemId: string;
  readonly title: string;
  readonly category: string;
  readonly url: string;
  readonly createdAt: number;
}

export const METADATA_FILE = '.cses.json';
export const SAMPLES_DIR = '.samples';

export interface ProblemWorkspace {
  readonly directory: string;
  readonly solutionFile: string;
  readonly samplesDir: string;
  readonly language: Language;
  /** True when the solution file already existed and was left untouched. */
  readonly existed: boolean;
}

/** Creates and locates the on-disk workspace for a problem. */
export class WorkspaceService {
  private readonly log: Logger;

  constructor(
    private readonly config: ConfigurationProvider,
    logger: Logger,
  ) {
    this.log = logger.scoped('workspace');
  }

  directoryFor(problem: Pick<Problem, 'id' | 'title' | 'category'>): string {
    const { workspaceRoot } = this.config.get();
    return path.join(workspaceRoot, slug(problem.category), `${problem.id}-${slug(problem.title)}`);
  }

  /** Creates the directory, solution file and sample files as needed. */
  async prepare(problem: Problem, language?: Language): Promise<ProblemWorkspace> {
    const settings = this.config.get();
    const lang = language ?? settings.language;
    const directory = this.directoryFor(problem);
    const solutionFile = path.join(directory, `problem.${fileExtensionFor(lang)}`);
    const samplesDir = path.join(directory, SAMPLES_DIR);

    await fs.mkdir(directory, { recursive: true });
    await this.writeMetadata(directory, problem);

    const existed = await exists(solutionFile);
    if (!existed) {
      const template = lang === 'cpp' ? settings.cppTemplate : settings.pythonTemplate;
      await fs.writeFile(solutionFile, renderTemplate(template, problem), 'utf8');
      this.log.info(`Created ${solutionFile}`);
    }

    if (settings.autoGenerateSamples && problem.samples.length > 0) {
      await this.writeSamples(samplesDir, problem);
    }

    return { directory, solutionFile, samplesDir, language: lang, existed };
  }

  /** Writes `.samples/sampleN.in` / `.out`, refreshing any stale files. */
  async writeSamples(samplesDir: string, problem: Problem): Promise<void> {
    await fs.mkdir(samplesDir, { recursive: true });
    await Promise.all(
      problem.samples.map(async (sample) => {
        await fs.writeFile(path.join(samplesDir, `sample${sample.index}.in`), sample.input, 'utf8');
        await fs.writeFile(
          path.join(samplesDir, `sample${sample.index}.out`),
          sample.output,
          'utf8',
        );
      }),
    );
    this.log.debug(`Wrote ${problem.samples.length} sample(s) to ${samplesDir}`);
  }

  /** Writes failed judge tests as extra runnable cases. */
  async writeJudgeCases(
    samplesDir: string,
    tests: ReadonlyArray<{
      test: number;
      input?: string;
      expectedOutput?: string;
      truncated?: boolean;
    }>,
  ): Promise<number> {
    const usable = tests.filter(
      (test) => test.input !== undefined && test.expectedOutput !== undefined && !test.truncated,
    );
    if (usable.length === 0) {
      return 0;
    }

    await fs.mkdir(samplesDir, { recursive: true });
    await Promise.all(
      usable.map(async (test) => {
        await fs.writeFile(
          path.join(samplesDir, `judge${test.test}.in`),
          test.input as string,
          'utf8',
        );
        await fs.writeFile(
          path.join(samplesDir, `judge${test.test}.out`),
          test.expectedOutput as string,
          'utf8',
        );
      }),
    );
    this.log.info(`Wrote ${usable.length} judge case(s) to ${samplesDir}`);
    return usable.length;
  }

  /** Removes previously imported judge cases. */
  async clearJudgeCases(samplesDir: string): Promise<void> {
    try {
      const entries = await fs.readdir(samplesDir);
      await Promise.all(
        entries
          .filter((file) => /^judge\d+\.(in|out)$/.test(file))
          .map((file) => fs.rm(path.join(samplesDir, file), { force: true })),
      );
    } catch {
      // Nothing to clear.
    }
  }

  private async writeMetadata(directory: string, problem: Problem): Promise<void> {
    const metadata: WorkspaceMetadata = {
      judge: problem.judge ?? DEFAULT_JUDGE,
      problemId: problem.id,
      title: problem.title,
      category: problem.category,
      url: problem.url,
      createdAt: Date.now(),
    };
    await fs.writeFile(
      path.join(directory, METADATA_FILE),
      JSON.stringify(metadata, null, 2),
      'utf8',
    );
  }

  async resolveFromFile(filePath: string): Promise<
    | {
        metadata: WorkspaceMetadata;
        directory: string;
        samplesDir: string;
        language: Language;
      }
    | undefined
  > {
    const language = languageForExtension(path.extname(filePath));
    if (!language) {
      return undefined;
    }

    let directory = path.dirname(filePath);
    // Bounded walk: deep enough for nested source layouts, cheap enough to be safe.
    for (let depth = 0; depth < 6; depth += 1) {
      const candidate = path.join(directory, METADATA_FILE);
      if (await exists(candidate)) {
        try {
          const metadata = JSON.parse(await fs.readFile(candidate, 'utf8')) as WorkspaceMetadata;
          return {
            metadata,
            directory,
            samplesDir: path.join(directory, SAMPLES_DIR),
            language,
          };
        } catch (error) {
          this.log.warn(`Malformed ${METADATA_FILE} at ${candidate}: ${String(error)}`);
          return undefined;
        }
      }
      const parent = path.dirname(directory);
      if (parent === directory) {
        break;
      }
      directory = parent;
    }
    return undefined;
  }
}

/** Substitutes `${title}`, `${id}`, `${url}`, `${category}` and `${date}`. */
export function renderTemplate(template: string, problem: Problem): string {
  const values: Record<string, string> = {
    title: problem.title,
    id: problem.id,
    url: problem.url,
    category: problem.category,
    date: new Date().toISOString().slice(0, 10),
  };
  return template.replace(/\$\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}

/** Filesystem-safe directory component derived from a title or category. */
export function slug(value: string): string {
  return (
    value
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/[\s_]+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 60) || 'untitled'
  );
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}
