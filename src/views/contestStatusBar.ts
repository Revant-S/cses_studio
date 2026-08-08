import * as vscode from 'vscode';
import { formatDuration, solvedCount } from '../models/contest';
import type { ContestService } from '../services/contestService';

/** Under this much time left, the clock turns into a warning. */
const LOW_TIME_MS = 5 * 60_000;

/** Contest countdown in the status bar. */
export class ContestStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly contests: ContestService) {
    // Sits left of the progress item so the clock reads first.
    this.item = vscode.window.createStatusBarItem(
      'cses.contest',
      vscode.StatusBarAlignment.Left,
      91,
    );
    this.item.name = 'CSES Contest';
    this.item.command = 'cses.openContest';

    this.disposables.push(
      this.item,
      this.contests.onDidChange(() => this.refresh()),
      this.contests.onDidTick(() => this.refresh()),
    );
    this.refresh();
  }

  refresh(): void {
    const snapshot = this.contests.snapshot();
    if (!snapshot || !snapshot.running) {
      this.item.hide();
      return;
    }

    const { contest, remainingMs, solved, total } = snapshot;
    const low = remainingMs <= LOW_TIME_MS;

    this.item.text = `$(watch) ${formatDuration(remainingMs)} · ${solved}/${total}`;
    this.item.backgroundColor = low
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined;

    const next = this.contests.nextUnsolved();
    this.item.tooltip = new vscode.MarkdownString(
      [
        '**Practice contest**',
        '',
        `Solved **${solvedCount(contest)}** of **${contest.problems.length}**`,
        '',
        `Time left: **${formatDuration(remainingMs)}**`,
        '',
        next ? `Next up: ${next.title}` : 'All problems solved.',
        '',
        'Click to open the contest board.',
      ].join('\n'),
    );
    this.item.show();
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}
