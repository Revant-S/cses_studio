import * as vscode from 'vscode';
import { atcoderLogin, atcoderLogout } from './commands/atcoderLogin';
import { endContest, openNextContestProblem, startContest } from './commands/contest';
import { trackSolutionFileContext } from './commands/context';
import { exportSubmitPage } from './commands/exportSubmitPage';
import { fetchProblems } from './commands/fetchProblems';
import { login } from './commands/login';
import { logout } from './commands/logout';
import { openProblem, openSolutionFile } from './commands/openProblem';
import { runCustomTest } from './commands/runCustomTest';
import { runSamples } from './commands/runSamples';
import { filterExplorer, searchProblem } from './commands/searchProblem';
import { submit } from './commands/submit';
import { openSolveLayout } from './commands/solveLayout';
import { syncProgress } from './commands/syncProgress';
import { Container } from './core/container';
import { toMessage } from './core/errors';
import { type Contest, solvedCount } from './models/contest';
import { DEFAULT_JUDGE, JUDGES } from './models/judge';
import type { Problem, ProblemSummary } from './models/problem';
import { ProblemNode } from './providers/treeItem';
import { ContestStatusBar } from './views/contestStatusBar';
import { ContestView } from './views/contestView';
import { ProblemBrowserView } from './views/problemBrowserView';
import { ProblemWebviewManager } from './views/problemWebview';
import { TestPanelView } from './views/testPanelView';
import { StatusBarController } from './views/statusBar';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const container = new Container(context);
  context.subscriptions.push(container);
  container.log.info('CSES Studio activating');

  const webviews = new ProblemWebviewManager(
    context,
    container.tests,
    container.workspace,
    container.progress,
    container.config,
    {
      openEditor: (problem) => openSolutionFile(container, problem).then(() => undefined),
      runSamples: (problem) => runSamples(container, problem),
      submit: (problem) => submit(container, problem),
      refresh: (problem) => refreshProblem(container, problem),
    },
    container.log,
  );
  container.setWebviewManager(webviews);

  const testPanel = new TestPanelView(
    context.extensionUri,
    container.tests,
    container.workspace,
    {
      submit: (problem) => submit(container, problem),
      openStatement: (problem) => container.webviews.show(problem, vscode.ViewColumn.One),
    },
    container.log,
  );
  container.setTestPanel(testPanel);

  const browser = new ProblemBrowserView(
    context.extensionUri,
    container.repository,
    container.progress,
    container.judges,
    {
      open: (problem: ProblemSummary) => openProblem(container, problem),
      fetch: () => fetchProblems(container),
    },
    container.log,
  );
  container.setBrowser(browser);

  const contestView = new ContestView(
    context.extensionUri,
    container.contests,
    container.repository,
    container.judges,
    container.config,
    { open: (problem: ProblemSummary) => openProblem(container, problem) },
    container.log,
  );
  container.setContestView(contestView);

  registerViews(context, container, testPanel, browser, contestView);
  registerCommands(context, container);

  const statusBar = new StatusBarController(container);
  context.subscriptions.push(
    statusBar,
    new ContestStatusBar(container.contests),
    trackSolutionFileContext(container),
    container.judges.onDidChange((judge) => {
      void (async () => {
        await updateAuthContext(container);
        if (!(await container.repository.getIndex(judge))) {
          await fetchProblems(container, true);
        }
      })();
    }),
  );

  await bootstrap(container, statusBar);
  container.log.info('CSES Studio activated');
}

export function deactivate(): void {
  // All resources are registered in context.subscriptions and disposed by VS Code.
}

/** Restores session and cache, then optionally performs a first-run fetch. */
async function bootstrap(container: Container, statusBar: StatusBarController): Promise<void> {
  try {
    const session = await container.auth.restore();
    await container.atcoderAuth.restore();
    await updateAuthContext(container);
    await container.explorer.reload();
    await statusBar.refresh();
    await container.contests.restore();
    await updateContestContext(container);

    const index = await container.repository.getIndex(container.judges.active);
    if (!index && container.config.get().autoFetch) {
      container.log.info('No cached index found; fetching problem list');
      await fetchProblems(container, true);
    }

    // Refresh solved status in the background; never block activation on it.
    if (session) {
      void syncProgress(container, true);
    }
  } catch (error) {
    container.log.error('Activation bootstrap failed', error);
    void vscode.window.showErrorMessage(`CSES Studio: startup failed — ${toMessage(error)}`);
  }
}

function registerViews(
  context: vscode.ExtensionContext,
  container: Container,
  testPanel: TestPanelView,
  browser: ProblemBrowserView,
  contestView: ContestView,
): void {
  const explorerView = vscode.window.createTreeView('csesStudio.problems', {
    treeDataProvider: container.explorer,
    showCollapseAll: true,
  });

  const updateTitle = (): void => {
    explorerView.description = container.explorer.describe();
  };
  updateTitle();

  context.subscriptions.push(
    explorerView,
    container.explorer.onDidChangeTreeData(updateTitle),
    vscode.window.createTreeView('csesStudio.progress', {
      treeDataProvider: container.progressView,
    }),
    vscode.window.registerWebviewViewProvider(TestPanelView.viewId, testPanel, {
      // Keep results and custom input when the panel is hidden.
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider(ProblemBrowserView.viewId, browser, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider(ContestView.viewId, contestView, {
      // Keep the half-filled setup form when the view is collapsed.
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );
}

function registerCommands(context: vscode.ExtensionContext, container: Container): void {
  const register = (id: string, handler: (...args: never[]) => unknown): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: never[]) => {
        try {
          await handler(...args);
        } catch (error) {
          container.log.error(`Command ${id} failed`, error);
          void vscode.window.showErrorMessage(`CSES: ${toMessage(error)}`);
        }
      }),
    );
  };

  register('cses.fetchProblems', () => fetchProblems(container));
  register('cses.refresh', () => refreshAll(container));
  register('cses.openProblem', (target?: ProblemSummary | ProblemNode | string) =>
    openProblem(container, unwrapTarget(target)),
  );
  register('cses.runSamples', () => runSamples(container));
  register('cses.runCustomTest', () => runCustomTest(container));
  register('cses.submit', () => submit(container));
  // The generic Login/Logout act on whichever site is selected.
  register('cses.login', () =>
    container.judges.active === 'atcoder-dp' ? atcoderLogin(container) : login(container),
  );
  register('cses.logout', () =>
    container.judges.active === 'atcoder-dp' ? atcoderLogout(container) : logout(container),
  );
  register('cses.searchProblem', () => searchProblem(container));
  register('cses.filterProblems', () => filterExplorer(container));
  register('cses.syncProgress', () => syncProgress(container));
  register('cses.showOutput', () => container.logger.show());
  register('cses.switchJudge', () => switchJudge(container));
  register('cses.atcoderLogin', () => atcoderLogin(container));
  register('cses.atcoderLogout', () => atcoderLogout(container));
  register('cses.openSolveLayout', () => openSolveLayoutForActive(container));
  register('cses.toggleRevision', (target?: ProblemSummary | ProblemNode | string) =>
    toggleRevision(container, unwrapTarget(target)),
  );
  register('cses.markRevision', (target?: ProblemSummary | ProblemNode | string) =>
    toggleRevision(container, unwrapTarget(target)),
  );
  register('cses.unmarkRevision', (target?: ProblemSummary | ProblemNode | string) =>
    toggleRevision(container, unwrapTarget(target)),
  );
  register('cses.filter.revision', () => container.explorer.setRevisionOnly(true));
  register('cses.filter.allRevision', () => container.explorer.setRevisionOnly(false));
  register('cses.exportSubmitPage', () => exportSubmitPage(container));

  register('cses.startContest', () => startContest(container));
  register('cses.endContest', () => endContest(container));
  register('cses.contestNext', () => openNextContestProblem(container));
  register('cses.openContest', () => container.contestView.reveal());

  context.subscriptions.push(
    container.contests.onDidChange((contest) => {
      void updateContestContext(container);
      announceContestEnd(container, contest);
    }),
  );

  register('cses.filter.unsolved', () => container.explorer.setUnsolvedOnly(true));
  register('cses.filter.all', async () => {
    container.explorer.setSearchTerm('');
    await container.explorer.setUnsolvedOnly(false);
  });

  register('cses.openInBrowser', async (target?: ProblemSummary | ProblemNode) => {
    const problem = unwrapTarget(target);
    if (problem && typeof problem !== 'string') {
      await vscode.env.openExternal(vscode.Uri.parse(problem.url));
    }
  });

  register('cses.copyProblemId', async (target?: ProblemSummary | ProblemNode) => {
    const problem = unwrapTarget(target);
    if (problem && typeof problem !== 'string') {
      await vscode.env.clipboard.writeText(problem.id);
      void vscode.window.showInformationMessage(`CSES: copied problem id ${problem.id}.`);
    }
  });

  // Keep the auth-dependent menu items in sync for whichever site is showing.
  context.subscriptions.push(
    container.auth.onDidChangeSession(() => void updateAuthContext(container)),
    container.atcoderAuth.onDidChangeSession(() => void updateAuthContext(container)),
  );
}

/** Reflects the active site's sign-in state, since each site has its own session. */
/** Toasts the result when a contest closes itself out. */
function announceContestEnd(container: Container, contest: Contest | undefined): void {
  if (!contest || contest.endedAt === undefined) {
    return;
  }
  if (contest.endReason !== 'finished' && contest.endReason !== 'timeout') {
    return;
  }

  const score = `${solvedCount(contest)}/${contest.problems.length}`;
  if (contest.endReason === 'finished') {
    void vscode.window.showInformationMessage(`CSES: contest complete — ${score} solved. 🎉`);
  } else {
    void vscode.window.showWarningMessage(`CSES: contest time is up — ${score} solved.`);
  }
  // Bring the recap up: the contest ended without the user asking it to.
  void container.contestView.reveal();
}

/** Exposes "a contest is running" to `when` clauses. */
async function updateContestContext(container: Container): Promise<void> {
  const snapshot = container.contests.snapshot();
  await vscode.commands.executeCommand(
    'setContext',
    'cses.contestRunning',
    snapshot?.running === true,
  );
}

async function updateAuthContext(container: Container): Promise<void> {
  const signedIn =
    container.judges.active === 'atcoder-dp'
      ? container.atcoderAuth.isAuthenticated
      : container.auth.isAuthenticated;
  await vscode.commands.executeCommand('setContext', 'cses.authenticated', signedIn);
}

/** Lets the user pick which site the views show. */
async function switchJudge(container: Container): Promise<void> {
  const items = container.repository.judges.map((id) => ({
    label: JUDGES[id].name,
    description: id === container.judges.active ? '$(check) current' : '',
    id,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    title: 'CSES Studio: switch site',
    placeHolder: 'Views show one site at a time.',
  });
  if (!picked) {
    return;
  }

  await container.judges.setActive(picked.id);
  // A site with no cached index would otherwise show an empty list.
  if (!(await container.repository.getIndex(picked.id))) {
    await fetchProblems(container, true);
  }
}

/** Opens the solving layout for whichever problem is in play. */
async function openSolveLayoutForActive(container: Container): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.uri.scheme === 'file') {
    const workspace = await container.workspace.resolveFromFile(editor.document.uri.fsPath);
    if (workspace) {
      const summary = await container.repository.findSummary(
        workspace.metadata.judge ?? DEFAULT_JUDGE,
        workspace.metadata.problemId,
      );
      if (summary) {
        await openSolveLayout(container, await container.repository.getProblem(summary));
        return;
      }
    }
  }
  // Nothing to infer from.
  await vscode.commands.executeCommand('cses.searchProblem');
}

/** Flips the revision flag for a problem, defaulting to the active one. */
async function toggleRevision(
  container: Container,
  target: ProblemSummary | string | undefined,
): Promise<void> {
  let id = typeof target === 'string' ? target : target?.id;

  if (!id) {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.uri.scheme === 'file') {
      const workspace = await container.workspace.resolveFromFile(editor.document.uri.fsPath);
      id = workspace?.metadata.problemId;
    }
  }
  if (!id) {
    void vscode.window.showWarningMessage('CSES: open a problem first to mark it for revision.');
    return;
  }

  const summary = await container.repository.findAnywhere(id);
  const marked = await container.progress.toggleRevision(
    summary ? container.progress.keyOf(summary) : id,
  );
  const name = summary ? summary.title : `#${id}`;
  void vscode.window.setStatusBarMessage(
    marked ? `$(star-full) Marked ${name} for revision` : `$(star-empty) Unmarked ${name}`,
    3000,
  );
}

/** Re-reads the cache and refreshes account status without re-downloading everything. */
async function refreshAll(container: Container): Promise<void> {
  await container.explorer.reload();
  if (container.auth.isAuthenticated) {
    await syncProgress(container, true);
  }
}

/** Re-downloads a single statement and repaints its panel. */
async function refreshProblem(container: Container, problem: Problem): Promise<void> {
  const summary = await container.repository.findSummary(
    problem.judge ?? DEFAULT_JUDGE,
    problem.id,
  );
  if (!summary) {
    return;
  }
  const refreshed = await container.repository.getProblem(summary, true);
  await container.webviews.show(refreshed);
  void vscode.window.showInformationMessage(`CSES: reloaded ${refreshed.title}.`);
}

/** Tree items arrive as nodes; the palette and webview pass summaries or ids. */
function unwrapTarget(
  target: ProblemSummary | ProblemNode | string | undefined,
): ProblemSummary | string | undefined {
  if (target instanceof ProblemNode) {
    return target.problem;
  }
  return target;
}
