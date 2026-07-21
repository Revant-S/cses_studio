import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { Container } from '../core/container';
import { toMessage } from '../core/errors';
import { resolveActiveProblem } from './context';

/** Saves the authenticated submit page to a local file for diagnosis. */
export async function exportSubmitPage(container: Container): Promise<void> {
  const target = await resolveActiveProblem(container);
  if (!target) {
    return;
  }

  if (!container.auth.isAuthenticated) {
    void vscode.window.showWarningMessage(
      'CSES: sign in first — the submit page requires a session.',
    );
    return;
  }

  try {
    const response = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'CSES: capturing submit page…' },
      async () => {
        await container.auth.ensureAuthenticated();
        return container.client.get(`/problemset/submit/${target.problem.id}/`);
      },
    );

    const destination = path.join(
      os.tmpdir(),
      `cses-submit-${target.problem.id}-${Date.now()}.html`,
    );
    const redacted = redact(response.body);

    await vscode.workspace.fs.writeFile(
      vscode.Uri.file(destination),
      Buffer.from(
        [
          `<!-- CSES Studio diagnostics`,
          `     problem : ${target.problem.id} ${target.problem.title}`,
          `     status  : HTTP ${response.status}`,
          `     url     : ${response.url}`,
          `     note    : CSRF tokens replaced with REDACTED. No cookies included.`,
          `-->`,
          redacted,
        ].join('\n'),
        'utf8',
      ),
    );

    container.log.info(`Submit page captured to ${destination}`);
    const choice = await vscode.window.showInformationMessage(
      `CSES: submit page saved to ${destination}`,
      'Open File',
    );
    if (choice === 'Open File') {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(destination));
      await vscode.window.showTextDocument(document);
    }
  } catch (error) {
    container.log.error('Capturing the submit page failed', error);
    void vscode.window.showErrorMessage(`CSES: capture failed — ${toMessage(error)}`);
  }
}

/** Strips CSRF tokens; they are single-use but there is no reason to share them. */
function redact(html: string): string {
  return html.replace(/(name=["']csrf_token["'][^>]*value=["'])[^"']*(["'])/gi, '$1REDACTED$2');
}
