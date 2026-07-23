import * as vscode from 'vscode';
import type { Container } from '../core/container';
import { AuthError, toMessage } from '../core/errors';
import { problemKey } from '../models/judge';
import { ProblemStatus } from '../models/problem';
import { login } from './login';

export async function syncProgress(container: Container, silent = false): Promise<void> {
  if (container.judges.active === 'atcoder-dp') {
    await syncAtCoder(container, silent);
    return;
  }
  await syncCses(container, silent);
}

async function syncCses(container: Container, silent: boolean): Promise<void> {
  if (!container.auth.isAuthenticated) {
    if (silent) {
      return;
    }
    const choice = await vscode.window.showInformationMessage(
      'CSES: sign in to sync your solved problems.',
      'Sign In',
    );
    if (choice === 'Sign In') {
      await login(container);
    }
    return;
  }

  try {
    const changes = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'CSES: syncing progress…' },
      async () => {
        await container.auth.ensureAuthenticated();
        const statuses = await container.scraper.fetchSolvedStatuses();
        // CSES ids stay bare, matching how progress was keyed before multi-judge.
        return container.progress.applyRemoteStatuses(statuses);
      },
    );

    await container.explorer.reload();
    if (!silent) {
      void vscode.window.showInformationMessage(summarize('CSES', changes));
    }
  } catch (error) {
    await reportSyncError(container, error, silent, () => login(container));
  }
}

/** DP contest task count, used to end the API walk early once all are solved. */
const DP_TASK_COUNT = 26;

/** Syncs AtCoder progress from the public AtCoder Problems API. */
async function syncAtCoder(container: Container, silent: boolean): Promise<void> {
  const user = await resolveAtCoderUser(container, silent);
  if (!user) {
    return;
  }

  try {
    const changes = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `AtCoder: syncing ${user}'s progress…`,
        cancellable: true,
      },
      async (progress, token) => {
        const controller = new AbortController();
        token.onCancellationRequested(() => controller.abort());

        const results = await container.atcoderProblems.fetchContestStatuses(user, 'dp', {
          expectedTasks: DP_TASK_COUNT,
          signal: controller.signal,
          onProgress: (scanned) => progress.report({ message: `${scanned} submissions scanned` }),
        });

        // Task ids (`dp_a`) become judge-qualified keys before they are stored.
        const statuses = new Map<string, ProblemStatus>();
        for (const [taskId, status] of results) {
          statuses.set(problemKey('atcoder-dp', taskId), status);
        }
        return container.progress.applyRemoteStatuses(statuses);
      },
    );

    await container.explorer.reload();
    if (!silent) {
      void vscode.window.showInformationMessage(summarize('AtCoder', changes));
    }
  } catch (error) {
    container.log.error('AtCoder progress sync failed', error);
    if (!silent) {
      void vscode.window.showErrorMessage(`AtCoder: could not sync progress — ${toMessage(error)}`);
    }
  }
}

async function resolveAtCoderUser(
  container: Container,
  silent: boolean,
): Promise<string | undefined> {
  const fromSession = container.atcoderAuth.currentSession?.username;
  if (fromSession) {
    return fromSession;
  }

  const configured = vscode.workspace.getConfiguration('cses').get<string>('atcoder.username', '');
  if (configured.trim()) {
    return configured.trim();
  }

  if (silent) {
    return undefined;
  }

  const entered = await vscode.window.showInputBox({
    title: 'AtCoder: sync progress',
    prompt: 'Your AtCoder username (no password needed — progress is read from the public API)',
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() ? undefined : 'Username is required.'),
  });
  if (!entered) {
    return undefined;
  }

  // Remember it so later syncs are one click.
  await vscode.workspace
    .getConfiguration('cses')
    .update('atcoder.username', entered.trim(), vscode.ConfigurationTarget.Global);
  return entered.trim();
}

function summarize(site: string, changes: number): string {
  return changes > 0
    ? `${site}: updated ${changes} problem${changes === 1 ? '' : 's'} from your account.`
    : `${site}: progress is already up to date.`;
}

async function reportSyncError(
  container: Container,
  error: unknown,
  silent: boolean,
  signIn: () => Promise<unknown>,
): Promise<void> {
  container.log.error('Progress sync failed', error);
  if (silent) {
    return;
  }
  if (error instanceof AuthError) {
    const choice = await vscode.window.showErrorMessage(`${toMessage(error)}`, 'Sign In');
    if (choice === 'Sign In') {
      await signIn();
    }
    return;
  }
  void vscode.window.showErrorMessage(`Could not sync progress — ${toMessage(error)}`);
}
