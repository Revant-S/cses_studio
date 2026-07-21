import * as vscode from 'vscode';
import type { Container } from '../core/container';
import { toMessage } from '../core/errors';

/** Signs out and clears every stored credential. */
export async function logout(container: Container): Promise<void> {
  if (!container.auth.isAuthenticated) {
    void vscode.window.showInformationMessage('CSES: not currently signed in.');
    return;
  }

  const username = container.auth.currentSession?.username ?? 'this account';
  const confirm = await vscode.window.showWarningMessage(
    `Sign out of CSES (${username})?`,
    {
      modal: true,
      detail:
        'Stored session and credentials will be removed from the OS keychain. Local progress is kept.',
    },
    'Sign Out',
  );
  if (confirm !== 'Sign Out') {
    return;
  }

  try {
    await container.auth.logout();
    void vscode.window.showInformationMessage('CSES: signed out.');
  } catch (error) {
    container.log.error('Logout failed', error);
    void vscode.window.showErrorMessage(`CSES: sign-out failed — ${toMessage(error)}`);
  }
}
