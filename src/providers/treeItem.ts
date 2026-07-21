import * as vscode from 'vscode';
import { renderBar } from './progressProvider';
import type { CategoryProgress } from '../services/progress';
import { ProblemStatus, type ProblemSummary } from '../models/problem';

export type CsesTreeNode = CategoryNode | ProblemNode | MessageNode;

/** Codicon + theme colour for each solve state, matching CSES's own semantics. */
const STATUS_PRESENTATION: Record<ProblemStatus, { icon: string; color?: string; label: string }> =
  {
    [ProblemStatus.Solved]: {
      icon: 'pass-filled',
      color: 'testing.iconPassed',
      label: 'Solved',
    },
    [ProblemStatus.Attempted]: {
      icon: 'circle-large-outline',
      color: 'testing.iconQueued',
      label: 'Attempted',
    },
    [ProblemStatus.Unsolved]: { icon: 'circle-large-outline', label: 'Unsolved' },
  };

export class CategoryNode extends vscode.TreeItem {
  readonly kind = 'category' as const;

  constructor(
    readonly name: string,
    readonly progress: CategoryProgress,
    expanded: boolean,
  ) {
    super(
      name,
      expanded
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed,
    );
    this.description = `${renderBar(progress.solved, progress.total, 8)}  ${progress.solved}/${progress.total}`;
    this.contextValue = 'category';
    this.iconPath = new vscode.ThemeIcon(
      progress.solved === progress.total && progress.total > 0 ? 'folder-active' : 'folder',
    );
    this.tooltip = new vscode.MarkdownString(
      [
        `**${name}**`,
        '',
        `- Solved: ${progress.solved}`,
        `- Attempted: ${progress.attempted}`,
        `- Total: ${progress.total}`,
      ].join('\n'),
    );
  }
}

export class ProblemNode extends vscode.TreeItem {
  readonly kind = 'problem' as const;

  constructor(
    readonly problem: ProblemSummary,
    readonly status: ProblemStatus,
    readonly markedForRevision = false,
  ) {
    super(problem.title, vscode.TreeItemCollapsibleState.None);
    const presentation = STATUS_PRESENTATION[status];

    this.id = `problem:${problem.id}`;
    // The star has to ride in the description: a tree item shows one icon.
    this.description = markedForRevision ? `★ #${problem.id}` : `#${problem.id}`;
    // Two axes in the context value so menus can target either independently.
    this.contextValue = `problem.${status}.${markedForRevision ? 'marked' : 'unmarked'}`;
    this.resourceUri = vscode.Uri.parse(`cses://problem/${problem.id}`);
    this.iconPath = new vscode.ThemeIcon(
      presentation.icon,
      presentation.color ? new vscode.ThemeColor(presentation.color) : undefined,
    );
    this.command = {
      command: 'cses.openProblem',
      title: 'Open Problem',
      arguments: [problem],
    };
    this.tooltip = buildProblemTooltip(problem, presentation.label, markedForRevision);
  }
}

/** Informational row used for empty states and errors inside the tree. */
export class MessageNode extends vscode.TreeItem {
  readonly kind = 'message' as const;

  constructor(message: string, icon = 'info') {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(icon);
    this.contextValue = 'message';
  }
}

function buildProblemTooltip(
  problem: ProblemSummary,
  statusLabel: string,
  markedForRevision: boolean,
): vscode.MarkdownString {
  const lines = [
    `**${problem.title}**`,
    '',
    `- Status: ${statusLabel}`,
    `- Category: ${problem.category}`,
    `- ID: ${problem.id}`,
  ];
  if (markedForRevision) {
    lines.push('- ★ Marked for revision');
  }
  if (problem.solvedCount !== undefined && problem.attemptedCount !== undefined) {
    lines.push(`- Solved by ${problem.solvedCount} of ${problem.attemptedCount} users`);
  }
  const tooltip = new vscode.MarkdownString(lines.join('\n'));
  tooltip.isTrusted = false;
  return tooltip;
}
