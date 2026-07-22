import * as vscode from 'vscode';
import type { ProblemRepository } from '../services/problemRepository';
import type { CategoryProgress, ProgressService } from '../services/progress';
import type { JudgeSelection } from '../services/judgeSelection';

/** Renders a proportional bar using block characters. */
export function renderBar(value: number, total: number, width = 10): string {
  if (total <= 0) {
    return '░'.repeat(width);
  }
  const filled = Math.round((value / total) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function percentOf(value: number, total: number): number {
  return total > 0 ? Math.round((value / total) * 100) : 0;
}

class CategoryNode extends vscode.TreeItem {
  constructor(entry: CategoryProgress) {
    super(entry.name, vscode.TreeItemCollapsibleState.None);

    const percent = percentOf(entry.solved, entry.total);
    const complete = entry.total > 0 && entry.solved === entry.total;

    this.description = `${renderBar(entry.solved, entry.total)}  ${entry.solved}/${entry.total}  ${percent}%`;
    this.iconPath = new vscode.ThemeIcon(
      complete ? 'pass-filled' : entry.solved > 0 ? 'circle-outline' : 'circle-large-outline',
      complete ? new vscode.ThemeColor('testing.iconPassed') : undefined,
    );

    const lines = [
      `**${entry.name}**`,
      '',
      `\`${renderBar(entry.solved, entry.total, 24)}\` ${percent}%`,
      '',
      `- Solved: **${entry.solved}** of ${entry.total}`,
      `- Attempted: ${entry.attempted}`,
      `- Remaining: ${entry.total - entry.solved}`,
    ];
    if (entry.revisit > 0) {
      lines.push(`- Marked for revision: ${entry.revisit}`);
    }
    this.tooltip = new vscode.MarkdownString(lines.join('\n'));
  }
}

class OverallNode extends vscode.TreeItem {
  constructor(
    solved: number,
    attempted: number,
    revisit: number,
    total: number,
    lastSolved: string | undefined,
  ) {
    super('Overall', vscode.TreeItemCollapsibleState.None);

    const percent = percentOf(solved, total);
    this.description = `${renderBar(solved, total)}  ${solved}/${total}  ${percent}%`;
    this.iconPath = new vscode.ThemeIcon('dashboard');

    const lines = [
      '**Overall progress**',
      '',
      `\`${renderBar(solved, total, 24)}\` ${percent}%`,
      '',
      `- Solved: **${solved}** of ${total}`,
      `- Attempted: ${attempted}`,
      `- Marked for revision: ${revisit}`,
      `- Untouched: ${Math.max(0, total - solved - attempted)}`,
    ];
    if (lastSolved) {
      lines.push('', `Last solved: ${lastSolved}`);
    }
    this.tooltip = new vscode.MarkdownString(lines.join('\n'));
  }
}

/** Section header separating the overall figure from the per-category rows. */
class HeaderNode extends vscode.TreeItem {
  constructor(label: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = '';
    this.tooltip = undefined;
  }
}

/** Per-category solve counts with proportional bars. */
export class ProgressViewProvider
  implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable
{
  private readonly emitter = new vscode.EventEmitter<undefined>();
  private readonly disposables: vscode.Disposable[] = [];

  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private readonly repository: ProblemRepository,
    private readonly progress: ProgressService,
    private readonly judges: JudgeSelection,
  ) {
    this.disposables.push(
      this.emitter,
      this.progress.onDidChange(() => this.emitter.fire(undefined)),
      this.repository.onDidChange(() => this.emitter.fire(undefined)),
      this.judges.onDidChange(() => this.emitter.fire(undefined)),
    );
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (element) {
      return [];
    }
    const index = await this.repository.getIndex(this.judges.active);
    if (!index) {
      return [];
    }

    const snapshot = this.progress.snapshot(index, this.judges.active);
    const lastSolved = snapshot.lastSolved
      ? new Date(snapshot.lastSolved.at).toLocaleDateString()
      : undefined;

    return [
      new OverallNode(
        snapshot.solved,
        snapshot.attempted,
        snapshot.revisit,
        snapshot.total,
        lastSolved,
      ),
      new HeaderNode('By category'),
      ...snapshot.categories.map((entry) => new CategoryNode(entry)),
    ];
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}
