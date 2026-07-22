import * as vscode from 'vscode';
import type { Logger } from '../core/logger';
import type { ProblemSummary } from '../models/problem';
import type { ProblemRepository } from '../services/problemRepository';
import type { ProgressService } from '../services/progress';
import type { JudgeSelection } from '../services/judgeSelection';
import { type JudgeId, JUDGES, isJudgeId } from '../models/judge';
import { createNonce, escapeHtml } from './webviewUtils';

type InboundMessage =
  | { type: 'ready' }
  | { type: 'open'; id: string }
  | { type: 'toggleRevision'; id: string }
  | { type: 'fetch' }
  | { type: 'selectJudge'; judge: string };

export interface BrowserHandlers {
  open(problem: ProblemSummary): Promise<void>;
  fetch(): Promise<void>;
}

/** Roomier problem browser with list and gallery layouts. */
export class ProblemBrowserView implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'csesStudio.browser';

  private view: vscode.WebviewView | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly log: Logger;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly repository: ProblemRepository,
    private readonly progress: ProgressService,
    private readonly judges: JudgeSelection,
    private readonly handlers: BrowserHandlers,
    logger: Logger,
  ) {
    this.log = logger.scoped('browser');
    this.disposables.push(
      this.progress.onDidChange(() => void this.push()),
      this.repository.onDidChange(() => void this.push()),
      this.judges.onDidChange(() => void this.push()),
    );
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

  private async handle(message: InboundMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        await this.push();
        break;
      case 'selectJudge': {
        if (isJudgeId(message.judge)) {
          await this.judges.setActive(message.judge);
        }
        break;
      }
      case 'open': {
        const problem = await this.repository.findSummary(this.judges.active, message.id);
        if (problem) {
          await this.handlers.open(problem);
        }
        break;
      }
      case 'toggleRevision': {
        const problem = await this.repository.findSummary(this.judges.active, message.id);
        if (!problem) {
          break;
        }
        const marked = await this.progress.toggleRevision(this.progress.keyOf(problem));
        this.log.debug(`Problem ${message.id} revision flag -> ${marked}`);
        // onDidChange triggers the push that repaints the star.
        break;
      }
      case 'fetch':
        await this.handlers.fetch();
        break;
      default:
        break;
    }
  }

  /** Highlights a problem when it is opened from elsewhere. */
  setActive(problemId: string): void {
    void this.view?.webview.postMessage({ type: 'active', id: problemId });
  }

  /** Sends the index plus per-problem state to the webview. */
  private async push(): Promise<void> {
    if (!this.view) {
      return;
    }
    const judge = this.judges.active;
    const index = await this.repository.getIndex(judge);
    const statuses: Record<string, string> = {};
    const revisit: Record<string, boolean> = {};

    for (const category of index?.categories ?? []) {
      for (const problem of category.problems) {
        // The webview keys by site-native id; storage keys stay judge-qualified.
        const stamped = { ...problem, judge: problem.judge ?? judge };
        statuses[problem.id] = this.progress.statusOfProblem(stamped);
        if (this.progress.isProblemMarkedForRevision(stamped)) {
          revisit[problem.id] = true;
        }
      }
    }

    void this.view.webview.postMessage({
      type: 'data',
      payload: {
        judge,
        judges: this.repository.judges.map((id: JudgeId) => ({
          id,
          label: JUDGES[id].shortName,
          name: JUDGES[id].name,
        })),
        categories: index?.categories ?? [],
        statuses,
        revisit,
      },
    });
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

    const filters: Array<[string, string]> = [
      ['all', 'All'],
      ['unsolved', 'Unsolved'],
      ['attempted', 'Attempted'],
      ['solved', 'Solved'],
      ['revisit', '★ Revise'],
    ];

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${asset('browser.css')}">
<title>CSES Problems</title>
</head>
<body>
<nav class="judge-nav" id="judge-nav" role="tablist"></nav>
<div class="toolbar">
  <div class="search-row">
    <input type="search" id="search" placeholder="Search title, id or category…" spellcheck="false">
    <div class="seg">
      <button data-view="list" title="List view" aria-pressed="true">☰</button>
      <button data-view="gallery" title="Gallery view" aria-pressed="false">▦</button>
    </div>
  </div>
  <div class="filters">
    ${filters
      .map(
        ([value, label]) =>
          `<button class="pill" data-filter="${value}" aria-pressed="${value === 'all'}">${escapeHtml(label)}</button>`,
      )
      .join('\n    ')}
  </div>
</div>
<div class="overview" id="overview"></div>
<div id="list" class="list"></div>
<script nonce="${nonce}" src="${asset('browser.js')}"></script>
</body>
</html>`;
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}
