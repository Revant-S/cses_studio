import * as vscode from 'vscode';
import type { Container } from '../core/container';
import { JUDGES } from '../models/judge';

/** Status bar entry showing sign-in state and overall progress. */
export class StatusBarController implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly container: Container) {
    this.item = vscode.window.createStatusBarItem(
      'cses.status',
      vscode.StatusBarAlignment.Left,
      90,
    );
    this.item.name = 'CSES Studio';

    this.disposables.push(
      this.item,
      container.auth.onDidChangeSession(() => void this.refresh()),
      container.progress.onDidChange(() => void this.refresh()),
      container.repository.onDidChange(() => void this.refresh()),
      container.judges.onDidChange(() => void this.refresh()),
    );
  }

  async refresh(): Promise<void> {
    const session = this.container.auth.currentSession;
    const judge = this.container.judges.active;
    const index = await this.container.repository.getIndex(judge);

    if (!index) {
      this.item.text = '$(cloud-download) CSES';
      this.item.tooltip = 'CSES Studio — fetch the problem set to get started';
      this.item.command = 'cses.fetchProblems';
      this.item.show();
      return;
    }

    const snapshot = this.container.progress.snapshot(index, judge);
    const percent = snapshot.total > 0 ? Math.round((snapshot.solved / snapshot.total) * 100) : 0;

    this.item.text = `$(mortar-board) ${JUDGES[judge].shortName} ${snapshot.solved}/${snapshot.total}`;
    this.item.command = 'cses.searchProblem';

    const tooltip = new vscode.MarkdownString(
      [
        '**CSES Studio**',
        '',
        session ? `Signed in as \`${session.username}\`` : '_Not signed in_',
        '',
        `Solved **${snapshot.solved}** of **${snapshot.total}** (${percent}%)`,
        '',
        'Click to search problems.',
      ].join('\n'),
    );
    this.item.tooltip = tooltip;
    this.item.show();
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}
