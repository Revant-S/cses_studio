import * as vscode from 'vscode';
import type { ConfigurationProvider } from '../core/config';
import { toMessage } from '../core/errors';
import type { Logger } from '../core/logger';
import {
  MAX_CONTEST_MINUTES,
  MAX_CONTEST_PROBLEMS,
  MIN_CONTEST_MINUTES,
  MIN_CONTEST_PROBLEMS,
  REASON_LABELS,
  contestLabel,
  solvedCount,
} from '../models/contest';
import { JUDGES } from '../models/judge';
import type { ProblemSummary } from '../models/problem';
import { ContestService, resolveContestProblem } from '../services/contestService';
import type { JudgeSelection } from '../services/judgeSelection';
import type { ProblemRepository } from '../services/problemRepository';
import { createNonce } from './webviewUtils';

type InboundMessage =
  | { type: 'ready' }
  | { type: 'start'; topics: string[]; count: number; minutes: number; includeSolved: boolean }
  | { type: 'open'; id: string }
  | { type: 'end' }
  | { type: 'newContest' }
  | { type: 'clearHistory' };

export interface ContestHandlers {
  open(problem: ProblemSummary): Promise<void>;
}

/** Contest sidebar: pick topics, draft a timed set, watch the clock. */
export class ContestView implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'csesStudio.contest';

  private view: vscode.WebviewView | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly log: Logger;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly contests: ContestService,
    private readonly repository: ProblemRepository,
    private readonly judges: JudgeSelection,
    private readonly config: ConfigurationProvider,
    private readonly handlers: ContestHandlers,
    logger: Logger,
  ) {
    this.log = logger.scoped('contestview');
    this.disposables.push(
      this.contests.onDidChange(() => void this.push()),
      this.repository.onDidChange(() => void this.push()),
      this.judges.onDidChange(() => void this.push()),
      // Ticks carry only the clock, so they never trigger a full repaint.
      this.contests.onDidTick((snapshot) =>
        this.post({
          type: 'tick',
          remainingMs: snapshot.remainingMs,
          elapsedMs: snapshot.elapsedMs,
        }),
      ),
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

  /** Brings the contest view into focus, e.g. after starting from the palette. */
  async reveal(): Promise<void> {
    await vscode.commands.executeCommand(`${ContestView.viewId}.focus`);
  }

  private async handle(message: InboundMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'ready':
          await this.push();
          break;
        case 'start':
          await this.contests.start({
            judge: this.judges.active,
            topics: message.topics,
            count: message.count,
            durationMinutes: message.minutes,
            includeSolved: message.includeSolved,
          });
          break;
        case 'open': {
          const problem = this.contests.active?.problems.find((entry) => entry.id === message.id);
          if (!problem) {
            break;
          }
          // The open flow records the contest open itself.
          await this.handlers.open(await resolveContestProblem(this.repository, problem));
          break;
        }
        case 'end':
          await this.contests.end('abandoned');
          break;
        case 'newContest':
          this.contests.dismissRecap();
          break;
        case 'clearHistory':
          await this.contests.clearHistory();
          break;
        default:
          break;
      }
    } catch (error) {
      this.log.error(`Handling ${message.type} failed`, error);
      void vscode.window.showErrorMessage(`CSES: ${toMessage(error)}`);
    }
  }

  /** Sends the topic list plus whatever contest state exists. */
  private async push(): Promise<void> {
    if (!this.view) {
      return;
    }
    const judge = this.judges.active;
    const settings = this.config.get();
    const snapshot = this.contests.snapshot();
    // Topic counts are only read on the setup screen; skip the work otherwise.
    const topics = snapshot ? [] : await this.contests.topics(judge);

    this.post({
      type: 'state',
      payload: {
        judge,
        judgeName: JUDGES[judge].shortName,
        phase: snapshot ? (snapshot.running ? 'live' : 'recap') : 'setup',
        topics,
        contest: snapshot
          ? {
              ...snapshot.contest,
              problems: snapshot.contest.problems.map((problem, position) => ({
                ...problem,
                label: contestLabel(position),
                reasonLabel: REASON_LABELS[problem.reason],
              })),
            }
          : undefined,
        remainingMs: snapshot?.remainingMs ?? 0,
        elapsedMs: snapshot?.elapsedMs ?? 0,
        solved: snapshot?.solved ?? 0,
        total: snapshot?.total ?? 0,
        history: this.contests.history().map((contest) => ({
          id: contest.id,
          startedAt: contest.startedAt,
          durationMs: contest.durationMs,
          endedAt: contest.endedAt,
          endReason: contest.endReason,
          topics: contest.topics,
          solved: solvedCount(contest),
          total: contest.problems.length,
        })),
        defaults: {
          count: settings.contestProblems,
          minutes: settings.contestMinutes,
        },
        limits: {
          minCount: MIN_CONTEST_PROBLEMS,
          maxCount: MAX_CONTEST_PROBLEMS,
          minMinutes: MIN_CONTEST_MINUTES,
          maxMinutes: MAX_CONTEST_MINUTES,
        },
      },
    });
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
<link rel="stylesheet" href="${asset('contest.css')}">
<title>CSES Contest</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${asset('contest.js')}"></script>
</body>
</html>`;
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}
