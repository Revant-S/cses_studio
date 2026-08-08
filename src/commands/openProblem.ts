import * as vscode from 'vscode';
import type { Container } from '../core/container';
import { toMessage } from '../core/errors';
import type { Problem, ProblemSummary } from '../models/problem';

export async function openProblem(
  container: Container,
  target: ProblemSummary | string | undefined,
): Promise<void> {
  const summary = await resolveTarget(container, target);
  if (!summary) {
    return;
  }

  try {
    const problem = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: `CSES: loading ${summary.title}` },
      () => container.repository.getProblem(summary),
    );

    await container.progress.markOpened(container.progress.keyOf(problem));
    await container.contests.markOpened(problem.id);

    // Point the shared surfaces at this problem before opening anything.
    await container.testPanel.setProblem(problem);
    container.browser?.setActive(problem.id);

    if (container.config.get().autoOpenStatement) {
      await container.webviews.show(problem, vscode.ViewColumn.One);
    }
    await openSolutionFile(container, problem, { focus: false });
  } catch (error) {
    container.log.error(`Opening problem ${summary.id} failed`, error);
    void vscode.window.showErrorMessage(
      `CSES: could not open ${summary.title} — ${toMessage(error)}`,
    );
  }
}

/** Creates the workspace if needed and shows the solution file in the editor. */
export async function openSolutionFile(
  container: Container,
  problem: Problem,
  options: { focus: boolean } = { focus: true },
): Promise<vscode.TextEditor> {
  const workspace = await container.workspace.prepare(problem);
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(workspace.solutionFile));

  return vscode.window.showTextDocument(document, {
    // Column two keeps the statement visible beside the code.
    viewColumn: vscode.ViewColumn.Two,
    preserveFocus: !options.focus,
    preview: false,
  });
}

/** Accepts a summary, a bare problem id, or nothing (prompting the user). */
async function resolveTarget(
  container: Container,
  target: ProblemSummary | string | undefined,
): Promise<ProblemSummary | undefined> {
  if (target && typeof target !== 'string') {
    return target;
  }

  if (typeof target === 'string') {
    const found = await container.repository.findAnywhere(target);
    if (!found) {
      void vscode.window.showWarningMessage(
        `CSES: problem ${target} is not in the cached list. Run "CSES: Fetch Problems" first.`,
      );
    }
    return found;
  }

  // Invoked from the palette with no argument.
  await vscode.commands.executeCommand('cses.searchProblem');
  return undefined;
}
