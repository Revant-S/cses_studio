import * as vscode from 'vscode';
import type { Logger } from '../core/logger';
import type { ProblemIndex } from '../models/category';
import { ProblemStatus, type ProblemSummary } from '../models/problem';
import type { ProblemRepository } from '../services/problemRepository';
import type { ProgressService } from '../services/progress';
import type { JudgeSelection } from '../services/judgeSelection';
import { CategoryNode, type CsesTreeNode, MessageNode, ProblemNode } from './treeItem';

/** Backs the "Problem Set" tree. */
export class ProblemExplorerProvider
  implements vscode.TreeDataProvider<CsesTreeNode>, vscode.Disposable
{
  private readonly emitter = new vscode.EventEmitter<CsesTreeNode | undefined>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly log: Logger;

  private index: ProblemIndex | undefined;
  private searchTerm = '';
  private unsolvedOnly = false;
  private revisionOnly = false;
  private loading = false;

  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private readonly repository: ProblemRepository,
    private readonly progress: ProgressService,
    private readonly judges: JudgeSelection,
    logger: Logger,
  ) {
    this.log = logger.scoped('explorer');
    this.disposables.push(
      this.emitter,
      this.repository.onDidChange(() => void this.reload()),
      this.progress.onDidChange(() => this.emitter.fire(undefined)),
      this.judges.onDidChange(() => void this.reload()),
    );
  }

  /** Re-reads the index from cache and repaints the tree. */
  async reload(): Promise<void> {
    this.index = await this.repository.getIndex(this.judges.active);
    this.emitter.fire(undefined);
  }

  setLoading(loading: boolean): void {
    this.loading = loading;
    this.emitter.fire(undefined);
  }

  setSearchTerm(term: string): void {
    this.searchTerm = term.trim().toLowerCase();
    this.emitter.fire(undefined);
  }

  get search(): string {
    return this.searchTerm;
  }

  async setUnsolvedOnly(value: boolean): Promise<void> {
    this.unsolvedOnly = value;
    await vscode.commands.executeCommand('setContext', 'cses.filterUnsolved', value);
    this.emitter.fire(undefined);
  }

  async setRevisionOnly(value: boolean): Promise<void> {
    this.revisionOnly = value;
    await vscode.commands.executeCommand('setContext', 'cses.filterRevision', value);
    this.emitter.fire(undefined);
  }

  getTreeItem(element: CsesTreeNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: CsesTreeNode): CsesTreeNode[] {
    if (element) {
      return element.kind === 'category' ? this.problemsIn(element.name) : [];
    }
    return this.rootNodes();
  }

  private rootNodes(): CsesTreeNode[] {
    if (this.loading) {
      return [new MessageNode('Fetching problems…', 'loading~spin')];
    }
    if (!this.index) {
      // An empty array lets the declarative `viewsWelcome` content take over.
      return [];
    }

    const snapshot = this.progress.snapshot(this.index, this.judges.active);
    const nodes: CsesTreeNode[] = [];
    const filtering = this.isFiltering();

    for (const category of this.index.categories) {
      const visible = this.problemsIn(category.name);
      if (filtering && visible.length === 0) {
        continue;
      }
      const categoryProgress = snapshot.categories.find((c) => c.name === category.name) ?? {
        name: category.name,
        solved: 0,
        attempted: 0,
        revisit: 0,
        total: category.problems.length,
        ratio: 0,
      };
      nodes.push(new CategoryNode(category.name, categoryProgress, filtering));
    }

    if (nodes.length === 0) {
      return [new MessageNode(`No problems match "${this.searchTerm}"`, 'search-stop')];
    }
    return nodes;
  }

  private problemsIn(categoryName: string): CsesTreeNode[] {
    const category = this.index?.categories.find((c) => c.name === categoryName);
    if (!category) {
      return [];
    }
    return category.problems
      .filter((problem) => this.matches(problem))
      .map(
        (problem) =>
          new ProblemNode(
            problem,
            this.progress.statusOfProblem(problem),
            this.progress.isProblemMarkedForRevision(problem),
          ),
      );
  }

  private matches(problem: ProblemSummary): boolean {
    if (this.unsolvedOnly && this.progress.statusOfProblem(problem) === ProblemStatus.Solved) {
      return false;
    }
    if (this.revisionOnly && !this.progress.isProblemMarkedForRevision(problem)) {
      return false;
    }
    if (!this.searchTerm) {
      return true;
    }
    return (
      problem.title.toLowerCase().includes(this.searchTerm) ||
      problem.id.includes(this.searchTerm) ||
      problem.category.toLowerCase().includes(this.searchTerm)
    );
  }

  private isFiltering(): boolean {
    return this.searchTerm.length > 0 || this.unsolvedOnly || this.revisionOnly;
  }

  /** Finds the node for a problem so the view can reveal it. */
  nodeFor(problem: ProblemSummary): ProblemNode {
    return new ProblemNode(
      problem,
      this.progress.statusOfProblem(problem),
      this.progress.isProblemMarkedForRevision(problem),
    );
  }

  /** Summary line shown in the view title, e.g. "142 / 400 solved". */
  describe(): string | undefined {
    if (!this.index) {
      return undefined;
    }
    const snapshot = this.progress.snapshot(this.index, this.judges.active);
    this.log.debug(`Explorer showing ${snapshot.total} problems`);
    return `${snapshot.solved} / ${snapshot.total} solved`;
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}
