import * as vscode from 'vscode';
import type { Container } from '../core/container';
import { toMessage } from '../core/errors';

/** Signs in to CSES. */
export async function login(container: Container): Promise<boolean> {
  if (container.auth.isAuthenticated) {
    const choice = await vscode.window.showInformationMessage(
      `CSES: already signed in as ${container.auth.currentSession?.username}.`,
      'Sign in as someone else',
      'Cancel',
    );
    if (choice !== 'Sign in as someone else') {
      return true;
    }
    await container.auth.logout();
  }

  const username = await vscode.window.showInputBox({
    title: 'CSES: sign in (1 of 2)',
    prompt: 'CSES username',
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() ? undefined : 'Username is required.'),
  });
  if (!username) {
    return false;
  }

  const password = await vscode.window.showInputBox({
    title: 'CSES: sign in (2 of 2)',
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
    { title: 'CSES: sign in', placeHolder: 'How long should the sign-in last?' },
  );
  if (remember === undefined) {
    return false;
  }

  try {
    const session = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'CSES: signing in…' },
      () => container.auth.login({ username: username.trim(), password }, remember.value),
    );

    void vscode.window.showInformationMessage(`CSES: signed in as ${session.username}.`);
    // Solved status is account-specific, so pull it immediately.
    await vscode.commands.executeCommand('cses.syncProgress');
    return true;
  } catch (error) {
    container.log.error('Login failed', error);
    void vscode.window.showErrorMessage(`CSES: sign-in failed — ${toMessage(error)}`);
    return false;
  }
}
