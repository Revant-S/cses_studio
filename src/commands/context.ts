import * as vscode from 'vscode';
import type { Container } from '../core/container';
import { DEFAULT_JUDGE } from '../models/judge';
import type { Problem } from '../models/problem';

export interface ActiveProblemContext {
  readonly problem: Problem;
  readonly sourceFile: string;
}

/** Determines which problem a command should act on, based on the active editor. */
export async function resolveActiveProblem(
  container: Container,
): Promise<ActiveProblemContext | undefined> {
  const editor = vscode.window.activeTextEditor;

  if (editor && editor.document.uri.scheme === 'file') {
    const filePath = editor.document.uri.fsPath;
    const workspace = await container.workspace.resolveFromFile(filePath);

    if (workspace) {
      const summary = await container.repository.findSummary(
        workspace.metadata.judge ?? DEFAULT_JUDGE,
        workspace.metadata.problemId,
      );
      if (summary) {
        const problem = await container.repository.getProblem(summary);
        return { problem, sourceFile: filePath };
      }
    }
  }

  void vscode.window.showWarningMessage(
    'CSES: open a generated solution file first, or open a problem from the CSES explorer.',
  );
  return undefined;
}

export function trackSolutionFileContext(container: Container): vscode.Disposable {
  const update = async (editor: vscode.TextEditor | undefined): Promise<void> => {
    let isSolution = false;
    if (editor && editor.document.uri.scheme === 'file') {
      isSolution =
        (await container.workspace.resolveFromFile(editor.document.uri.fsPath)) !== undefined;
    }
    await vscode.commands.executeCommand('setContext', 'cses.isSolutionFile', isSolution);
  };

  void update(vscode.window.activeTextEditor);
  return vscode.window.onDidChangeActiveTextEditor((editor) => void update(editor));
}
