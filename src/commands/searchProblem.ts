import * as vscode from 'vscode';
import type { Container } from '../core/container';
import { JUDGES } from '../models/judge';
import { ProblemStatus, type ProblemSummary } from '../models/problem';
import { openProblem } from './openProblem';

interface ProblemPick extends vscode.QuickPickItem {
  readonly problem: ProblemSummary;
}

const STATUS_ICON: Record<ProblemStatus, string> = {
  [ProblemStatus.Solved]: '$(pass-filled)',
  [ProblemStatus.Attempted]: '$(circle-large-outline)',
  [ProblemStatus.Unsolved]: '$(circle-large-outline)',
};

/** Quick-pick search across the cached problem set. */
export async function searchProblem(container: Container): Promise<void> {
  const problems = await container.repository.allProblems(container.judges.active);

  if (problems.length === 0) {
    const choice = await vscode.window.showInformationMessage(
      'CSES: no problems cached yet.',
      'Fetch Problems',
    );
    if (choice === 'Fetch Problems') {
      await vscode.commands.executeCommand('cses.fetchProblems');
    }
    return;
  }

  const items: ProblemPick[] = problems.map((problem) => {
    const status = container.progress.statusOfProblem(problem);
    return {
      label: `${STATUS_ICON[status]} ${problem.title}`,
      description: `#${problem.id}`,
      detail: problem.category,
      problem,
    };
  });

  const picked = await vscode.window.showQuickPick(items, {
    title: `Search ${problems.length} ${JUDGES[container.judges.active].shortName} problems`,
    placeHolder: 'Search by title, id or category…',
    matchOnDescription: true,
    matchOnDetail: true,
  });

  if (picked) {
    await openProblem(container, picked.problem);
  }
}

/** Filters the tree view by a search term instead of opening a problem. */
export async function filterExplorer(container: Container): Promise<void> {
  const term = await vscode.window.showInputBox({
    title: 'CSES: filter problem list',
    prompt: 'Filter by title, id or category. Leave empty to clear.',
    value: container.explorer.search,
  });

  if (term !== undefined) {
    container.explorer.setSearchTerm(term);
  }
}
