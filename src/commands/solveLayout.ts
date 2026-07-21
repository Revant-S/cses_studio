import * as vscode from 'vscode';
import type { Container } from '../core/container';
import type { Problem } from '../models/problem';
import { TestPanelView } from '../views/testPanelView';

export async function openSolveLayout(container: Container, problem: Problem): Promise<void> {
  // Statement first so it takes column one, then the editor beside it.
  await container.webviews.show(problem, vscode.ViewColumn.One);

  const workspace = await container.workspace.prepare(problem);
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(workspace.solutionFile));
  await vscode.window.showTextDocument(document, {
    viewColumn: vscode.ViewColumn.Two,
    preview: false,
  });

  await container.testPanel.setProblem(problem);
  await container.testPanel.reveal();

  // Return focus to the editor: the panel steals it when first revealed.
  await vscode.window.showTextDocument(document, {
    viewColumn: vscode.ViewColumn.Two,
    preview: false,
  });
}

export async function arrangePanes(container: Container): Promise<void> {
  try {
    await vscode.commands.executeCommand('workbench.action.focusAuxiliaryBar');
    await vscode.commands.executeCommand(`${TestPanelView.viewId}.focus`);
  } catch (error) {
    container.log.debug(`Could not auto-arrange panes: ${String(error)}`);
  }
}
