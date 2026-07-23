import * as vscode from 'vscode';
import type { Container } from '../core/container';
import { toMessage } from '../core/errors';

/** Signs in to AtCoder. */
export async function atcoderLogin(container: Container): Promise<boolean> {
  if (container.atcoderAuth.isAuthenticated) {
    const choice = await vscode.window.showInformationMessage(
      `Already signed in to AtCoder as ${container.atcoderAuth.currentSession?.username}.`,
      'Sign in as someone else',
      'Cancel',
    );
    if (choice !== 'Sign in as someone else') {
      return true;
    }
    await container.atcoderAuth.logout();
  }

  const username = await vscode.window.showInputBox({
    title: 'AtCoder: sign in (1 of 2)',
    prompt: 'AtCoder username',
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() ? undefined : 'Username is required.'),
  });
  if (!username) {
    return false;
  }

  const password = await vscode.window.showInputBox({
    title: 'AtCoder: sign in (2 of 2)',
    prompt: `Password for ${username}`,
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => (value ? undefined : 'Password is required.'),
  });
  if (!password) {
    return false;
  }

  const remember = await vscode.window.showQuickPick(
    [
      {
        label: 'Stay signed in',
        description: 'Store credentials in the OS keychain to renew expired sessions',
        value: true,
      },
      { label: 'This session only', description: 'Keep only the session cookie', value: false },
    ],
    { title: 'AtCoder: sign in', placeHolder: 'How long should the sign-in last?' },
  );
  if (remember === undefined) {
    return false;
  }

  try {
    const session = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'AtCoder: signing in…' },
      () => container.atcoderAuth.login({ username: username.trim(), password }, remember.value),
    );
    void vscode.window.showInformationMessage(`AtCoder: signed in as ${session.username}.`);
    // Solved status is account-specific; pull it right away.
    await vscode.commands.executeCommand('cses.syncProgress');
    return true;
  } catch (error) {
    container.log.error('AtCoder login failed', error);
    void vscode.window.showErrorMessage(`AtCoder: sign-in failed — ${toMessage(error)}`);
    return false;
  }
}

export async function atcoderLogout(container: Container): Promise<void> {
  if (!container.atcoderAuth.isAuthenticated) {
    void vscode.window.showInformationMessage('AtCoder: not currently signed in.');
    return;
  }

  const username = container.atcoderAuth.currentSession?.username ?? 'this account';
  const confirm = await vscode.window.showWarningMessage(
    `Sign out of AtCoder (${username})?`,
    {
      modal: true,
      detail: 'Stored session and credentials are removed from the OS keychain.',
    },
    'Sign Out',
  );
  if (confirm !== 'Sign Out') {
    return;
  }

  await container.atcoderAuth.logout();
  void vscode.window.showInformationMessage('AtCoder: signed out.');
}
