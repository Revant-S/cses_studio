import * as vscode from 'vscode';
import type { Container } from '../core/container';
import { CompilationError, toMessage } from '../core/errors';
import type { Problem } from '../models/problem';
import type { SampleTestResult } from '../services/testService';
import { resolveActiveProblem } from './context';

/** Compiles the active solution and runs it against every cached sample. */
export async function runSamples(container: Container, problem?: Problem): Promise<void> {
  const target = problem ?? (await resolveActiveProblem(container))?.problem;
  if (!target) {
    return;
  }

  const workspace = await container.workspace.prepare(target);
  const samples =
    target.samples.length > 0
      ? target.samples
      : await container.tests.readSamplesFromDisk(workspace.samplesDir);

  if (samples.length === 0) {
    void vscode.window.showWarningMessage(`CSES: ${target.title} has no sample tests to run.`);
    return;
  }

  // Ensure the on-disk samples match the statement before running.
  await container.workspace.writeSamples(workspace.samplesDir, target);
  await saveIfDirty(workspace.solutionFile);

  const webviews = container.webviews;
  const problemId = target.id;
  webviews.postSampleProgress(problemId, `Compiling ${workspace.language}…`);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `CSES: running ${samples.length} sample${samples.length === 1 ? '' : 's'}`,
      cancellable: true,
    },
    async (progress, token) => {
      const controller = new AbortController();
      token.onCancellationRequested(() => controller.abort());

      try {
        const results = await container.tests.runSamples({
          sourceFile: workspace.solutionFile,
          language: workspace.language,
          samples,
          ...(target.timeLimit !== undefined ? { timeLimitSeconds: target.timeLimit } : {}),
          signal: controller.signal,
          onResult: (result) => {
            progress.report({ message: `Sample ${result.index}: ${result.label}` });
          },
        });

        webviews.postSampleResults(problemId, results);
        container.testPanel.publishResults(results);
        await reportSummary(container, target, results);
      } catch (error) {
        handleRunFailure(container, problemId, error);
      }
    },
  );
}

function handleRunFailure(container: Container, problemId: string, error: unknown): void {
  if (error instanceof CompilationError) {
    container.log.warn(`Compilation failed:\n${error.stderr}`);
    container.webviews.postSampleError(problemId, error.message, error.stderr);
    void vscode.window
      .showErrorMessage('CSES: compilation failed.', 'Show Output')
      .then((choice) => {
        if (choice === 'Show Output') {
          container.logger.show();
        }
      });
    return;
  }

  container.log.error('Running samples failed', error);
  container.webviews.postSampleError(problemId, toMessage(error));
  void vscode.window.showErrorMessage(`CSES: could not run samples — ${toMessage(error)}`);
}

/** Notifies the outcome and records an attempt when something failed. */
async function reportSummary(
  container: Container,
  problem: Problem,
  results: readonly SampleTestResult[],
): Promise<void> {
  const passed = results.filter((result) => result.passed).length;
  const all = results.length;

  if (passed === all) {
    void vscode.window.showInformationMessage(
      `CSES: all ${all} sample${all === 1 ? '' : 's'} passed for ${problem.title}.`,
    );
    return;
  }

  await container.progress.markAttempted(container.progress.keyOf(problem));
  const first = results.find((result) => !result.passed);
  const detail = first?.summary ? ` — ${first.summary}` : '';

  const choice = await vscode.window.showWarningMessage(
    `CSES: ${passed} / ${all} samples passed${detail}`,
    'Show Details',
  );
  if (choice === 'Show Details') {
    await container.webviews.show(problem);
    container.webviews.postSampleResults(problem.id, results);
  }
}

/** Saves the file first so tests never run against stale source. */
async function saveIfDirty(filePath: string): Promise<void> {
  const document = vscode.workspace.textDocuments.find((doc) => doc.uri.fsPath === filePath);
  if (document?.isDirty) {
    await document.save();
  }
}
