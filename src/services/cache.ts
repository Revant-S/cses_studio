import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { Logger } from '../core/logger';
import { INDEX_VERSION, type ProblemIndex } from '../models/category';
import { DEFAULT_JUDGE, type JudgeId } from '../models/judge';
import type { Problem } from '../models/problem';

export const CACHE_ROOT = path.join(os.homedir(), '.cses-studio', 'cache');

/** On-disk cache under `~/.cses-studio/cache`. */
export class CacheService {
  private readonly log: Logger;
  private readonly indexMemo = new Map<JudgeId, ProblemIndex>();
  private readonly problemMemo = new Map<string, Problem>();

  constructor(
    logger: Logger,
    private readonly root: string = CACHE_ROOT,
  ) {
    this.log = logger.scoped('cache');
  }

  get directory(): string {
    return this.root;
  }

  /** Per-judge cache directory. */
  private judgeRoot(judge: JudgeId): string {
    return judge === DEFAULT_JUDGE ? this.root : path.join(this.root, judge);
  }

  private indexPath(judge: JudgeId): string {
    return path.join(this.judgeRoot(judge), 'index.json');
  }

  private problemPath(judge: JudgeId, id: string): string {
    return path.join(this.judgeRoot(judge), 'problems', `${id}.json`);
  }

  async readIndex(judge: JudgeId): Promise<ProblemIndex | undefined> {
    const memo = this.indexMemo.get(judge);
    if (memo) {
      return memo;
    }
    const index = await this.readJson<ProblemIndex>(this.indexPath(judge));
    if (!index) {
      return undefined;
    }
    if (index.version !== INDEX_VERSION) {
      this.log.warn(`Cached ${judge} index version ${index.version} is stale; re-fetch required.`);
      return undefined;
    }
    this.indexMemo.set(judge, index);
    return index;
  }

  async writeIndex(judge: JudgeId, index: ProblemIndex): Promise<void> {
    await this.writeJson(this.indexPath(judge), index);
    this.indexMemo.set(judge, index);
    this.log.info(`Cached ${judge} index with ${index.categories.length} categories`);
  }

  async readProblem(judge: JudgeId, id: string): Promise<Problem | undefined> {
    const key = `${judge}/${id}`;
    const memo = this.problemMemo.get(key);
    if (memo) {
      return memo;
    }
    const problem = await this.readJson<Problem>(this.problemPath(judge, id));
    if (problem) {
      this.problemMemo.set(key, problem);
    }
    return problem;
  }

  async writeProblem(judge: JudgeId, problem: Problem): Promise<void> {
    await this.writeJson(this.problemPath(judge, problem.id), problem);
    this.problemMemo.set(`${judge}/${problem.id}`, problem);
  }

  async hasProblem(judge: JudgeId, id: string): Promise<boolean> {
    if (this.problemMemo.has(`${judge}/${id}`)) {
      return true;
    }
    try {
      await fs.access(this.problemPath(judge, id));
      return true;
    } catch {
      return false;
    }
  }

  /** Drops every cached artefact, including the in-memory memoization. */
  async clear(): Promise<void> {
    this.indexMemo.clear();
    this.problemMemo.clear();
    await fs.rm(this.root, { recursive: true, force: true });
    this.log.info('Cache cleared');
  }

  async stats(): Promise<{ problems: number; bytes: number }> {
    try {
      const dir = path.join(this.root, 'problems');
      const files = await fs.readdir(dir);
      let bytes = 0;
      for (const file of files) {
        const stat = await fs.stat(path.join(dir, file));
        bytes += stat.size;
      }
      return { problems: files.length, bytes };
    } catch {
      return { problems: 0, bytes: 0 };
    }
  }

  private async readJson<T>(file: string): Promise<T | undefined> {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8')) as T;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        this.log.warn(`Discarding unreadable cache file ${file}: ${String(error)}`);
      }
      return undefined;
    }
  }

  private async writeJson(file: string, value: unknown): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(value), 'utf8');
    await fs.rename(temp, file);
  }
}
