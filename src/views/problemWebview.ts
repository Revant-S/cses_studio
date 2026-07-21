import * as vscode from 'vscode';
import type { ConfigurationProvider } from '../core/config';
import { toMessage } from '../core/errors';
import type { Logger } from '../core/logger';
import { type Problem, ProblemStatus } from '../models/problem';
import type { ProgressService } from '../services/progress';
import type { SampleTestResult, TestService } from '../services/testService';
import type { WorkspaceService } from '../services/workspace';
import { createNonce, escapeHtml } from './webviewUtils';

/** Messages the webview sends to the extension host. */
type InboundMessage =
  | { type: 'ready' }
  | { type: 'openEditor' }
  | { type: 'runSamples' }
  | { type: 'submit' }
  | { type: 'openInBrowser' }
  | { type: 'refresh' }
  | { type: 'runCustom'; input: string }
  | { type: 'stopCustom' };

export interface ProblemPanelHandlers {
  openEditor(problem: Problem): Promise<void>;
  runSamples(problem: Problem): Promise<void>;
  submit(problem: Problem): Promise<void>;
  refresh(problem: Problem): Promise<void>;
}

/** Manages problem statement panels: one panel per problem, reused on re-open. */
export class ProblemWebviewManager implements vscode.Disposable {
  private readonly panels = new Map<string, vscode.WebviewPanel>();
  private readonly customRuns = new Map<string, AbortController>();
  private readonly log: Logger;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly testService: TestService,
    private readonly workspace: WorkspaceService,
    private readonly progress: ProgressService,
    private readonly config: ConfigurationProvider,
    private readonly handlers: ProblemPanelHandlers,
    logger: Logger,
  ) {
    this.log = logger.scoped('webview');
  }

  /** Shows (or focuses) the panel for a problem. */
  async show(problem: Problem, column?: vscode.ViewColumn): Promise<void> {
    const existing = this.panels.get(problem.id);
    if (existing) {
      existing.reveal(column ?? existing.viewColumn, true);
      existing.webview.html = this.render(existing.webview, problem);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'cses.problem',
      problem.title,
      { viewColumn: column ?? vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
      },
    );

    panel.iconPath = {
      light: vscode.Uri.joinPath(this.context.extensionUri, 'resources', 'problem-light.svg'),
      dark: vscode.Uri.joinPath(this.context.extensionUri, 'resources', 'problem-dark.svg'),
    };

    this.panels.set(problem.id, panel);
    panel.webview.html = this.render(panel.webview, problem);

    panel.webview.onDidReceiveMessage(
      (message: InboundMessage) => void this.handleMessage(problem, message),
      undefined,
      this.context.subscriptions,
    );

    panel.onDidDispose(
      () => {
        this.panels.delete(problem.id);
        this.customRuns.get(problem.id)?.abort();
        this.customRuns.delete(problem.id);
      },
      undefined,
      this.context.subscriptions,
    );
  }

  private async handleMessage(problem: Problem, message: InboundMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'ready':
          this.postStatus(problem);
          break;
        case 'openEditor':
          await this.handlers.openEditor(problem);
          break;
        case 'runSamples':
          await this.handlers.runSamples(problem);
          break;
        case 'submit':
          await this.handlers.submit(problem);
          break;
        case 'refresh':
          await this.handlers.refresh(problem);
          break;
        case 'openInBrowser':
          await vscode.env.openExternal(vscode.Uri.parse(problem.url));
          break;
        case 'runCustom':
          await this.runCustom(problem, message.input);
          break;
        case 'stopCustom':
          this.customRuns.get(problem.id)?.abort();
          break;
        default:
          break;
      }
    } catch (error) {
      this.log.error(`Handling ${message.type} failed`, error);
      void vscode.window.showErrorMessage(`CSES: ${toMessage(error)}`);
    }
  }

  /** Runs the custom input against the solution and streams the result back. */
  private async runCustom(problem: Problem, input: string): Promise<void> {
    this.customRuns.get(problem.id)?.abort();
    const controller = new AbortController();
    this.customRuns.set(problem.id, controller);

    try {
      const workspace = await this.workspace.prepare(problem);
      const result = await this.testService.runCustom({
        sourceFile: workspace.solutionFile,
        language: workspace.language,
        input,
        ...(problem.timeLimit !== undefined ? { timeLimitSeconds: problem.timeLimit } : {}),
        signal: controller.signal,
      });
      this.post(problem.id, { type: 'customResult', result });
    } catch (error) {
      this.post(problem.id, {
        type: 'customResult',
        result: { error: toMessage(error) },
      });
    } finally {
      this.customRuns.delete(problem.id);
    }
  }

  // -- Outbound updates ------------------------------------------------------

  postSampleProgress(problemId: string, message: string): void {
    this.post(problemId, { type: 'sampleResults', status: 'running', message });
  }

  postSampleResults(problemId: string, results: readonly SampleTestResult[]): void {
    this.post(problemId, { type: 'sampleResults', status: 'done', results });
  }

  postSampleError(problemId: string, message: string, detail?: string): void {
    this.post(problemId, { type: 'sampleResults', status: 'error', message, detail });
  }

  postStatus(problem: Problem): void {
    this.post(problem.id, { type: 'status', status: this.progress.statusOf(problem.id) });
  }

  isOpen(problemId: string): boolean {
    return this.panels.has(problemId);
  }

  private post(problemId: string, message: unknown): void {
    void this.panels.get(problemId)?.webview.postMessage(message);
  }

  // -- Rendering -------------------------------------------------------------

  private render(webview: vscode.Webview, problem: Problem): string {
    const nonce = createNonce();
    const settings = this.config.get();
    const fontSize = settings.statementFontSize;
    // Long lines hurt readability; the measure scales with the chosen size.
    const measure = Math.round(fontSize * 52);
    const asset = (...segments: string[]): vscode.Uri =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', ...segments));

    const status = this.progress.statusOf(problem.id);
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${asset('katex', 'katex.min.css')}">
<link rel="stylesheet" href="${asset('problem.css')}">
<style>:root { --cses-font: ${fontSize}px; --cses-measure: ${measure}px; }</style>
<title>${escapeHtml(problem.title)}</title>
</head>
<body>
<div class="container">
  <div class="toolbar-sticky">
    <span class="sticky-title">${escapeHtml(problem.title)}</span>
    <button class="btn-primary btn-compact" data-action="run-samples">▶ Run Samples</button>
    <button class="btn-secondary btn-compact" data-action="submit">Submit</button>
    <button class="btn-secondary btn-compact" data-action="open-editor">Editor</button>
  </div>
  ${this.renderHeader(problem, status)}
  ${renderSection('Statement', problem.statement)}
  ${renderSection('Input', problem.input)}
  ${renderSection('Output', problem.output)}
  ${renderSection('Constraints', problem.constraints)}
  ${renderSection('Notes', problem.notes)}
  ${this.renderSamples(problem)}
  ${this.renderTestRunner()}
</div>
<script nonce="${nonce}" src="${asset('katex', 'katex.min.js')}"></script>
<script nonce="${nonce}" src="${asset('problem.js')}"></script>
</body>
</html>`;
  }

  private renderHeader(problem: Problem, status: ProblemStatus): string {
    const chips: string[] = [];
    if (problem.timeLimit !== undefined) {
      chips.push(chip(`⏱ ${problem.timeLimit.toFixed(2)} s`));
    }
    if (problem.memoryLimit !== undefined) {
      chips.push(chip(`▤ ${problem.memoryLimit} MB`));
    }
    chips.push(chip(problem.category));
    if (problem.solvedCount !== undefined && problem.attemptedCount !== undefined) {
      chips.push(chip(`👤 ${problem.solvedCount} / ${problem.attemptedCount} solved`));
    }

    const statusLabel = status.charAt(0).toUpperCase() + status.slice(1);

    return `<div class="header">
  <div class="title-row">
    <h1 class="title">${escapeHtml(problem.title)}</h1>
    <span class="problem-id">#${escapeHtml(problem.id)}</span>
  </div>
  <div class="chips">
    <span class="chip status-${status}" id="status-chip">${statusLabel}</span>
    ${chips.join('\n    ')}
  </div>
  <div class="toolbar">
    <button class="btn-primary" data-action="open-editor">Open Editor</button>
    <button class="btn-secondary" data-action="run-samples">Run Samples</button>
    <button class="btn-secondary" data-action="submit">Submit</button>
    <button class="btn-secondary" data-action="open-browser">Open in Browser</button>
    <button class="btn-icon" data-action="refresh" title="Re-download this statement">Refresh</button>
  </div>
</div>`;
  }

  private renderSamples(problem: Problem): string {
    if (problem.samples.length === 0) {
      return '';
    }

    const cards = problem.samples.map((sample) => {
      const inputId = `sample-in-${sample.index}`;
      const outputId = `sample-out-${sample.index}`;
      return `<div class="sample">
  <div class="sample-header">
    <span>Example ${sample.index}</span>
    <button class="btn-icon" data-action="use-sample" data-target="${inputId}" title="Copy this input into the custom test box">Use as custom input</button>
  </div>
  <div class="sample-grid">
    <div class="sample-cell">
      <div class="sample-label"><span>Input</span><button class="btn-icon" data-action="copy" data-target="${inputId}">Copy</button></div>
      <pre id="${inputId}">${escapeHtml(sample.input)}</pre>
    </div>
    <div class="sample-cell">
      <div class="sample-label"><span>Output</span><button class="btn-icon" data-action="copy" data-target="${outputId}">Copy</button></div>
      <pre id="${outputId}">${escapeHtml(sample.output)}</pre>
    </div>
  </div>
  ${sample.explanation ? `<div class="sample-explanation">${escapeHtml(sample.explanation)}</div>` : ''}
</div>`;
    });

    return `<section>
  <h2 class="section-title">Examples</h2>
  ${cards.join('\n  ')}
</section>`;
  }

  private renderTestRunner(): string {
    return `<section>
  <h2 class="section-title section-title--action">
    <span>Sample Tests</span>
    <span class="section-actions">
      <button class="btn-primary btn-compact" data-action="run-samples">▶ Run Samples</button>
      <button class="btn-secondary btn-compact" data-action="submit">Submit</button>
    </span>
  </h2>
  <div id="sample-results"><div class="empty">Run the samples to see results here.</div></div>
</section>
<section>
  <h2 class="section-title">Custom Input</h2>
  <textarea id="custom-input" spellcheck="false" placeholder="Type input for your program…"></textarea>
  <div class="run-row">
    <button class="btn-primary" id="btn-run-custom" data-action="run-custom">Run</button>
    <button class="btn-secondary" id="btn-stop-custom" data-action="stop-custom" hidden>Stop</button>
  </div>
  <div id="custom-result"></div>
</section>`;
  }

  dispose(): void {
    for (const panel of this.panels.values()) {
      panel.dispose();
    }
    this.panels.clear();
    for (const controller of this.customRuns.values()) {
      controller.abort();
    }
    this.customRuns.clear();
  }
}

function renderSection(title: string, html: string): string {
  if (!html.trim()) {
    return '';
  }
  return `<section>
  <h2 class="section-title">${title}</h2>
  <div class="prose">${html}</div>
</section>`;
}

function chip(text: string): string {
  return `<span class="chip">${escapeHtml(text)}</span>`;
}
