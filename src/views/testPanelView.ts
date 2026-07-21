import * as path from 'path';
import * as vscode from 'vscode';
import { toMessage } from '../core/errors';
import type { Logger } from '../core/logger';
import type { Problem } from '../models/problem';
import type { Sample } from '../models/sample';
import type { SampleTestResult, TestService } from '../services/testService';
import { SAMPLES_DIR, type WorkspaceService } from '../services/workspace';
import { createNonce } from './webviewUtils';

type InboundMessage =
  | { type: 'ready' }
  | { type: 'runCase'; key: string }
  | { type: 'runAll' }
  | { type: 'runCustom'; input: string }
  | { type: 'submit' }
  | { type: 'openStatement' };

export interface TestPanelHandlers {
  submit(problem: Problem): Promise<void>;
  openStatement(problem: Problem): Promise<void>;
}

/** Test panel hosted in the bottom panel, under the editor. */
export class TestPanelView implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'csesStudio.tests';

  private view: vscode.WebviewView | undefined;
  private problem: Problem | undefined;
  /** Cases imported from failed judge tests, keyed by the judge's test number. */
  private judgeCases: Sample[] = [];
  private running: AbortController | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly log: Logger;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly tests: TestService,
    private readonly workspace: WorkspaceService,
    private readonly handlers: TestPanelHandlers,
    logger: Logger,
  ) {
    this.log = logger.scoped('testpanel');
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    view.webview.html = this.render(view.webview);

    view.webview.onDidReceiveMessage(
      (message: InboundMessage) => void this.handle(message),
      undefined,
      this.disposables,
    );
    view.onDidDispose(
      () => {
        this.view = undefined;
      },
      undefined,
      this.disposables,
    );
  }

  /** Points the panel at a problem and shows its samples plus any judge cases. */
  async setProblem(problem: Problem): Promise<void> {
    this.problem = problem;
    const workspace = this.workspace.directoryFor(problem);
    this.judgeCases = await this.tests.readJudgeCasesFromDisk(path.join(workspace, SAMPLES_DIR));
    this.publishCases();
  }

  /** Re-reads judge cases from disk, e.g. after a submission imported some. */
  async refreshJudgeCases(): Promise<void> {
    if (!this.problem) {
      return;
    }
    await this.setProblem(this.problem);
  }

  private publishCases(): void {
    if (!this.problem) {
      return;
    }
    this.post({
      type: 'problem',
      problem: { id: this.problem.id, title: this.problem.title },
      samples: this.problem.samples,
      judgeCases: this.judgeCases,
    });
  }

  /** All runnable cases in tab order: statement samples, then judge cases. */
  private allCases(): Array<Sample & { key: string; judge: boolean }> {
    return [
      ...(this.problem?.samples ?? []).map((c) => ({ ...c, key: `s${c.index}`, judge: false })),
      ...this.judgeCases.map((c) => ({ ...c, key: `j${c.index}`, judge: true })),
    ];
  }

  /** Brings the panel into view without stealing focus from the editor. */
  async reveal(): Promise<void> {
    await vscode.commands.executeCommand(`${TestPanelView.viewId}.focus`);
  }

  private async handle(message: InboundMessage): Promise<void> {
    if (message.type === 'ready') {
      this.publishCases();
      return;
    }
    if (!this.problem) {
      return;
    }

    try {
      switch (message.type) {
        case 'runAll':
          await this.run();
          break;
        case 'runCase':
          await this.run(message.key);
          break;
        case 'runCustom':
          await this.runCustom(message.input);
          break;
        case 'submit':
          await this.handlers.submit(this.problem);
          break;
        case 'openStatement':
          await this.handlers.openStatement(this.problem);
          break;
        default:
          break;
      }
    } catch (error) {
      this.log.error(`Handling ${message.type} failed`, error);
      void vscode.window.showErrorMessage(`CSES: ${toMessage(error)}`);
    }
  }

  /** Runs every case, or just the one identified by `only` (a case key). */
  async run(only?: string): Promise<SampleTestResult[]> {
    const problem = this.problem;
    if (!problem) {
      return [];
    }

    this.running?.abort();
    const controller = new AbortController();
    this.running = controller;
    this.post({ type: 'running', running: true });
    this.post({ type: 'clear' });

    try {
      const workspace = await this.workspace.prepare(problem);
      await saveIfDirty(workspace.solutionFile);

      const cases = this.allCases().filter((c) => only === undefined || c.key === only);
      // The runner keys results by `index`, so map back to the case key here.
      const keyByIndex = new Map(cases.map((c, position) => [position + 1, c.key]));

      return await this.tests.runSamples({
        sourceFile: workspace.solutionFile,
        language: workspace.language,
        samples: cases.map((c, position) => ({ ...c, index: position + 1 })),
        ...(problem.timeLimit !== undefined ? { timeLimitSeconds: problem.timeLimit } : {}),
        signal: controller.signal,
        onResult: (result) => {
          const key = keyByIndex.get(result.index);
          // Stream each case as it finishes, focusing the first failure.
          this.post({ type: 'result', result: { ...result, key }, focus: only === undefined });
        },
      });
    } catch (error) {
      this.post({
        type: 'customResult',
        result: { error: describeRunFailure(error) },
      });
      throw error;
    } finally {
      this.running = undefined;
      this.post({ type: 'running', running: false });
    }
  }

  private async runCustom(input: string): Promise<void> {
    const problem = this.problem;
    if (!problem) {
      return;
    }

    this.running?.abort();
    const controller = new AbortController();
    this.running = controller;
    this.post({ type: 'running', running: true });

    try {
      const workspace = await this.workspace.prepare(problem);
      await saveIfDirty(workspace.solutionFile);

      const result = await this.tests.runCustom({
        sourceFile: workspace.solutionFile,
        language: workspace.language,
        input,
        ...(problem.timeLimit !== undefined ? { timeLimitSeconds: problem.timeLimit } : {}),
        signal: controller.signal,
      });
      this.post({ type: 'customResult', result });
    } catch (error) {
      this.post({ type: 'customResult', result: { error: describeRunFailure(error) } });
    } finally {
      this.running = undefined;
      this.post({ type: 'running', running: false });
    }
  }

  /** Publishes results produced elsewhere, e.g. by the palette command. */
  publishResults(results: readonly SampleTestResult[]): void {
    this.post({ type: 'clear' });
    for (const result of results) {
      this.post({ type: 'result', result: { ...result, key: `s${result.index}` }, focus: false });
    }
  }

  private post(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }

  private render(webview: vscode.Webview): string {
    const nonce = createNonce();
    const asset = (name: string): vscode.Uri =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', name));

    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${asset('tests.css')}">
<title>CSES Tests</title>
</head>
<body>
<div class="head">
  <span class="problem" id="problem"></span>
  <span class="spacer"></span>
  <button class="btn-ghost" data-act="statement">Statement</button>
  <button class="btn-ghost" id="btn-run-all" data-act="run-all">Run all</button>
  <button class="btn-run" id="btn-run" data-act="run">▶ Run case</button>
  <button class="btn-ghost" id="btn-submit" data-act="submit">Submit</button>
</div>
<div class="tabs" id="tabs" role="tablist"></div>
<div class="body" id="body"></div>
<script nonce="${nonce}" src="${asset('tests.js')}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.running?.abort();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}

function describeRunFailure(error: unknown): string {
  const message = toMessage(error);
  const stderr = (error as { stderr?: string }).stderr;
  return stderr ? `${message}\n\n${stderr}` : message;
}

async function saveIfDirty(filePath: string): Promise<void> {
  const document = vscode.workspace.textDocuments.find((doc) => doc.uri.fsPath === filePath);
  if (document?.isDirty) {
    await document.save();
  }
}
