import * as fs from 'fs/promises';
import * as vscode from 'vscode';
import type { Container } from '../core/container';
import { AuthError, toMessage } from '../core/errors';
import { DEFAULT_JUDGE, JUDGES } from '../models/judge';
import type { Problem } from '../models/problem';
import { type SubmissionResult, Verdict } from '../models/verdict';
import { resolveActiveProblem } from './context';
import { atcoderLogin } from './atcoderLogin';
import { login } from './login';

/** Submits the active solution to CSES and reports the verdict. */
export async function submit(container: Container, problem?: Problem): Promise<void> {
  const target = problem ?? (await resolveActiveProblem(container))?.problem;
  if (!target) {
    return;
  }

  const judge = target.judge ?? DEFAULT_JUDGE;
  if (!JUDGES[judge].canSubmit) {
    const open = 'Open in Browser';
    const choice = await vscode.window.showInformationMessage(
      `CSES Studio cannot submit to ${JUDGES[judge].name}. Local sample testing works normally.`,
      open,
    );
    if (choice === open) {
      await vscode.env.openExternal(vscode.Uri.parse(target.url));
    }
    return;
  }

  // Each site has its own session, so the sign-in check is per judge.
  if (judge === 'atcoder-dp') {
    if (!container.atcoderAuth.isAuthenticated && !(await atcoderLogin(container))) {
      return;
    }
  } else if (!container.auth.isAuthenticated && !(await login(container))) {
    return;
  }

  const workspace = await container.workspace.prepare(target);
  await saveIfDirty(workspace.solutionFile);

  let code: string;
  try {
    code = await fs.readFile(workspace.solutionFile, 'utf8');
  } catch (error) {
    void vscode.window.showErrorMessage(
      `CSES: could not read the solution file — ${toMessage(error)}`,
    );
    return;
  }

  if (!code.trim()) {
    void vscode.window.showWarningMessage('CSES: the solution file is empty.');
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `CSES: submitting ${target.title}`,
      cancellable: true,
    },
    async (progress, token) => {
      const controller = new AbortController();
      token.onCancellationRequested(() => controller.abort());

      try {
        const result =
          judge === 'atcoder-dp'
            ? await container.atcoderSubmissions.submit({
                taskId: target.id,
                code,
                language: workspace.language,
                languageId: container.config.get().atcoderLanguageId,
                signal: controller.signal,
                onStatus: (status) => progress.report({ message: status }),
              })
            : await container.submissions.submit({
                problemId: target.id,
                sourceFile: workspace.solutionFile,
                code,
                language: workspace.language,
                signal: controller.signal,
                onStatus: (status) => progress.report({ message: status }),
              });

        await recordVerdict(container, target, result);
        const imported = await importFailedTests(container, target, result, progress, controller);
        await presentVerdict(container, target, result, imported);
      } catch (error) {
        await handleSubmitError(container, error);
      }
    },
  );
}

/** Reflects the judge's answer in local progress tracking. */
async function recordVerdict(
  container: Container,
  problem: Problem,
  result: SubmissionResult,
): Promise<void> {
  if (result.verdict === Verdict.Accepted) {
    await container.progress.markSolved(container.progress.keyOf(problem));
  } else if (result.verdict !== Verdict.Pending) {
    await container.progress.markAttempted(container.progress.keyOf(problem));
  }

  if (container.webviews.isOpen(problem.id)) {
    container.webviews.postStatus(problem);
  }
}

async function importFailedTests(
  container: Container,
  problem: Problem,
  result: SubmissionResult,
  progress: vscode.Progress<{ message?: string }>,
  controller: AbortController,
): Promise<number> {
  // Only CSES exposes downloadable failing-test data.
  if ((problem.judge ?? DEFAULT_JUDGE) !== DEFAULT_JUDGE) {
    return 0;
  }

  const workspace = await container.workspace.prepare(problem);

  if (result.verdict === Verdict.Accepted) {
    await container.workspace.clearJudgeCases(workspace.samplesDir);
    await container.testPanel.refreshJudgeCases();
    return 0;
  }
  if (result.tests.length === 0) {
    return 0;
  }

  progress.report({ message: 'Fetching failed test data…' });
  try {
    const failed = await container.submissions.fetchFailedTestData(result, {
      signal: controller.signal,
    });

    await container.workspace.clearJudgeCases(workspace.samplesDir);
    const written = await container.workspace.writeJudgeCases(workspace.samplesDir, failed);
    await container.testPanel.refreshJudgeCases();

    if (written > 0) {
      await container.testPanel.reveal();
    }
    return written;
  } catch (error) {
    // A verdict is still worth showing even if the test data cannot be read.
    container.log.warn(`Could not import failed tests: ${toMessage(error)}`);
    return 0;
  }
}

async function presentVerdict(
  container: Container,
  problem: Problem,
  result: SubmissionResult,
  importedCases: number,
): Promise<void> {
  const details = [result.time && `time ${result.time}`, result.memory && `memory ${result.memory}`]
    .filter(Boolean)
    .join(', ');
  const suffix = details ? ` (${details})` : '';
  const openAction = 'Open in Browser';

  if (result.verdict === Verdict.Accepted) {
    const choice = await vscode.window.showInformationMessage(
      `CSES: ✓ Accepted — ${problem.title}${suffix}`,
      openAction,
    );
    if (choice === openAction) {
      await vscode.env.openExternal(vscode.Uri.parse(result.url));
    }
    return;
  }

  const failed = result.tests.filter((test) => test.verdict !== Verdict.Accepted);
  const failedTest = failed[0];
  const testInfo = failedTest
    ? ` on test ${failedTest.test}${failed.length > 1 ? ` (+${failed.length - 1} more)` : ''}`
    : '';
  let importNote: string;
  if (importedCases > 0) {
    importNote = ` — ${importedCases} failing case${importedCases === 1 ? '' : 's'} added to the test panel`;
  } else if (failed.length > 0) {
    importNote = ' — could not import the failing test data (see the CSES log)';
  } else if (result.tests.length === 0 && result.verdict !== Verdict.CompileError) {
    importNote = ' — CSES returned no per-test breakdown (see the CSES log)';
  } else {
    importNote = '';
  }

  const actions = [openAction, 'Show Output'];
  if (result.compilerOutput) {
    actions.unshift('Show Compiler Output');
  }

  const choice = await vscode.window.showErrorMessage(
    `CSES: ✗ ${result.rawVerdict || result.verdict}${testInfo} — ${problem.title}${suffix}${importNote}`,
    ...actions,
  );

  if (choice === openAction) {
    await vscode.env.openExternal(vscode.Uri.parse(result.url));
  } else if (choice === 'Show Output') {
    container.logger.show();
  } else if (choice === 'Show Compiler Output' && result.compilerOutput) {
    const document = await vscode.workspace.openTextDocument({
      content: result.compilerOutput,
      language: 'plaintext',
    });
    await vscode.window.showTextDocument(document, { preview: true });
  }
}

async function handleSubmitError(container: Container, error: unknown): Promise<void> {
  container.log.error('Submission failed', error);

  if (error instanceof AuthError) {
    const choice = await vscode.window.showErrorMessage(`CSES: ${toMessage(error)}`, 'Sign In');
    if (choice === 'Sign In') {
      await login(container);
    }
    return;
  }

  const choice = await vscode.window.showErrorMessage(
    `CSES: submission failed — ${toMessage(error)}`,
    'Show Output',
  );
  if (choice === 'Show Output') {
    container.logger.show();
  }
}

async function saveIfDirty(filePath: string): Promise<void> {
  const document = vscode.workspace.textDocuments.find((doc) => doc.uri.fsPath === filePath);
  if (document?.isDirty) {
    await document.save();
  }
}
