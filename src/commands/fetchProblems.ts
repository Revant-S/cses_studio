import * as vscode from 'vscode';
import type { Container } from '../core/container';
import { toMessage } from '../core/errors';
import { type JudgeId, JUDGES } from '../models/judge';

/** Downloads the problem index, optionally followed by every statement. */
export async function fetchProblems(container: Container, silent = false): Promise<void> {
  const judge = container.judges.active;
  const includeStatements = silent ? false : await askForScope(judge);
  if (includeStatements === undefined) {
    return;
  }

  container.explorer.setLoading(true);

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `CSES Studio: fetching ${JUDGES[judge].shortName}`,
        cancellable: true,
      },
      async (progress, token) => {
        const controller = new AbortController();
        token.onCancellationRequested(() => controller.abort());

        progress.report({ message: 'Downloading problem index…' });

        let lastPercent = 0;
        await container.repository.fetchAll(judge, {
          includeStatements,
          signal: controller.signal,
          onProgress: (done, total, label) => {
            const percent = Math.floor((done / total) * 100);
            progress.report({
              increment: percent - lastPercent,
              message: `${done} / ${total} — ${label}`,
            });
            lastPercent = percent;
          },
        });
      },
    );

    await container.explorer.reload();

    const index = await container.repository.getIndex(judge);
    const total = index?.categories.reduce((n, c) => n + c.problems.length, 0) ?? 0;
    if (!silent) {
      void vscode.window.showInformationMessage(
        `CSES: cached ${total} problems across ${index?.categories.length ?? 0} categories.`,
      );
    }
    container.log.info(`Fetch complete: ${total} problems`);
  } catch (error) {
    container.log.error('Fetching problems failed', error);
    void vscode.window.showErrorMessage(`CSES: could not fetch problems — ${toMessage(error)}`);
  } finally {
    container.explorer.setLoading(false);
  }
}

async function askForScope(judge: JudgeId): Promise<boolean | undefined> {
  const indexOnly = 'Problem list only (fast)';
  const everything = 'List and all statements (slower, works offline)';

  const choice = await vscode.window.showQuickPick([indexOnly, everything], {
    title: `Fetch ${JUDGES[judge].name}`,
    placeHolder: 'Statements are downloaded on demand unless cached up front.',
  });

  if (choice === undefined) {
    return undefined;
  }
  return choice === everything;
}
