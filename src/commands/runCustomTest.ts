import * as vscode from 'vscode';
import type { Container } from '../core/container';
import { CompilationError, toMessage } from '../core/errors';
import type { Problem } from '../models/problem';
import { resolveActiveProblem } from './context';

/** Runs the active solution against ad-hoc input. */
export async function runCustomTest(container: Container, problem?: Problem): Promise<void> {
  const target = problem ?? (await resolveActiveProblem(container))?.problem;
  if (!target) {
    return;
  }

  // Prefer the panel when it is already open: it has a proper multi-line editor.
  if (container.webviews.isOpen(target.id)) {
    await container.webviews.show(target);
    void vscode.window.showInformationMessage(
      'CSES: enter input in the "Custom Input" box of the problem panel and press Run.',
    );
    return;
  }

  const input = await promptForInput();
  if (input === undefined) {
    return;
  }

  const workspace = await container.workspace.prepare(target);
  await saveIfDirty(workspace.solutionFile);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'CSES: running custom test',
      cancellable: true,
    },
    async (_progress, token) => {
      const controller = new AbortController();
      token.onCancellationRequested(() => controller.abort());

      try {
        const result = await container.tests.runCustom({
          sourceFile: workspace.solutionFile,
          language: workspace.language,
          input,
          ...(target.timeLimit !== undefined ? { timeLimitSeconds: target.timeLimit } : {}),
          signal: controller.signal,
        });

        await showResultDocument(target, input, result);
      } catch (error) {
        if (error instanceof CompilationError) {
          container.log.warn(`Compilation failed:\n${error.stderr}`);
          void vscode.window.showErrorMessage(
            'CSES: compilation failed. See the CSES Studio output for details.',
          );
          return;
        }
        container.log.error('Custom test failed', error);
        void vscode.window.showErrorMessage(`CSES: custom test failed — ${toMessage(error)}`);
      }
    },
  );
}

async function promptForInput(): Promise<string | undefined> {
  const raw = await vscode.window.showInputBox({
    title: 'CSES: custom input',
    prompt: 'Input to feed on stdin. Use \\n for line breaks.',
    placeHolder: '3\\n1 2 3',
    ignoreFocusOut: true,
  });
  if (raw === undefined) {
    return undefined;
  }
  // A single-line input box cannot carry real newlines, so accept escapes.
  return `${raw.replace(/\\n/g, '\n').replace(/\\t/g, '\t')}\n`;
}

/** Opens the run report in an untitled document rather than a cramped notification. */
async function showResultDocument(
  problem: Problem,
  input: string,
  result: {
    stdout: string;
    stderr: string;
    exitCode: number | null;
    durationMs: number;
    timedOut: boolean;
  },
): Promise<void> {
  const status = result.timedOut
    ? 'Timed out'
    : result.exitCode === 0
      ? 'Finished successfully'
      : `Exited with code ${result.exitCode}`;

  const report = [
    `CSES Studio — custom test`,
    `Problem : ${problem.id} ${problem.title}`,
    `Status  : ${status}`,
    `Time    : ${result.durationMs} ms`,
    '',
    '--- input ---',
    input.trimEnd(),
    '',
    '--- stdout ---',
    result.stdout.trimEnd() || '(empty)',
    '',
    '--- stderr ---',
    result.stderr.trimEnd() || '(empty)',
    '',
  ].join('\n');

  const document = await vscode.workspace.openTextDocument({
    content: report,
    language: 'plaintext',
  });
  await vscode.window.showTextDocument(document, {
    preview: true,
    viewColumn: vscode.ViewColumn.Beside,
  });
}

async function saveIfDirty(filePath: string): Promise<void> {
  const document = vscode.workspace.textDocuments.find((doc) => doc.uri.fsPath === filePath);
  if (document?.isDirty) {
    await document.save();
  }
}
