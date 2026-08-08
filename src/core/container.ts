import * as vscode from 'vscode';
import { AuthService } from '../services/auth';
import { CacheService } from '../services/cache';
import { CompilerService } from '../services/compiler';
import { ContestService } from '../services/contestService';
import { CsesClient } from '../services/csesClient';
import { DiagnosticsRecorder } from '../services/diagnostics';
import { ProblemRepository } from '../services/problemRepository';
import { ProgressService } from '../services/progress';
import { ProcessRunner } from '../services/runner';
import { CsesScraper } from '../services/scraper';
import { AtCoderScraper, ATCODER_ORIGIN } from '../services/atcoderScraper';
import { AtCoderAuthService } from '../services/atcoderAuth';
import { AtCoderSubmissionService } from '../services/atcoderSubmitter';
import { AtCoderProblemsClient, ATCODER_PROBLEMS_ORIGIN } from '../services/atcoderProblemsClient';
import { JudgeSelection } from '../services/judgeSelection';
import type { JudgeId } from '../models/judge';
import type { ProblemSource } from '../services/scraper';
import { SubmissionService } from '../services/submitter';
import { TestService } from '../services/testService';
import { WorkspaceService } from '../services/workspace';
import { ProblemExplorerProvider } from '../providers/explorerProvider';
import { ProgressViewProvider } from '../providers/progressProvider';
import { ProblemWebviewManager } from '../views/problemWebview';
import type { ContestView } from '../views/contestView';
import type { ProblemBrowserView } from '../views/problemBrowserView';
import type { TestPanelView } from '../views/testPanelView';
import type { ConfigurationProvider } from './config';
import type { Logger } from './logger';
import { OutputChannelLogger } from './outputChannelLogger';
import { VsCodeConfigurationProvider } from './vscodeConfig';

/** Composition root. */
export class Container implements vscode.Disposable {
  readonly logger: OutputChannelLogger;
  readonly config: ConfigurationProvider;
  readonly client: CsesClient;
  readonly scraper: CsesScraper;
  readonly atcoder: AtCoderScraper;
  readonly atcoderClient: CsesClient;
  readonly atcoderAuth: AtCoderAuthService;
  readonly atcoderSubmissions: AtCoderSubmissionService;
  readonly atcoderProblems: AtCoderProblemsClient;
  readonly judges: JudgeSelection;
  readonly cache: CacheService;
  readonly repository: ProblemRepository;
  readonly progress: ProgressService;
  readonly contests: ContestService;
  readonly auth: AuthService;
  readonly workspace: WorkspaceService;
  readonly compiler: CompilerService;
  readonly runner: ProcessRunner;
  readonly tests: TestService;
  readonly submissions: SubmissionService;
  readonly diagnostics: DiagnosticsRecorder;
  readonly explorer: ProblemExplorerProvider;
  readonly progressView: ProgressViewProvider;

  /** Assigned after construction: these need command handlers that need the container. */
  private webviewManager: ProblemWebviewManager | undefined;
  private testPanelView: TestPanelView | undefined;
  private browserView: ProblemBrowserView | undefined;
  private contestViewInstance: ContestView | undefined;

  private readonly disposables: vscode.Disposable[] = [];

  constructor(readonly context: vscode.ExtensionContext) {
    this.logger = OutputChannelLogger.create('CSES Studio');
    this.config = new VsCodeConfigurationProvider();

    this.client = new CsesClient(this.logger);
    this.scraper = new CsesScraper(this.client, this.logger);
    this.cache = new CacheService(this.logger);
    // AtCoder is a different origin, so it needs its own client and cookie jar.
    this.atcoderClient = new CsesClient(this.logger, ATCODER_ORIGIN);
    this.atcoder = new AtCoderScraper(this.atcoderClient, this.logger);
    const sources = new Map<JudgeId, ProblemSource>([
      ['cses', this.scraper],
      ['atcoder-dp', this.atcoder],
    ]);
    this.repository = new ProblemRepository(sources, this.cache, this.config, this.logger);
    this.judges = new JudgeSelection(context.globalState, this.logger);

    this.progress = new ProgressService(context.globalState, this.logger);
    this.contests = new ContestService(
      context.globalState,
      this.repository,
      this.progress,
      this.logger,
    );
    this.auth = new AuthService(this.client, context.secrets, this.logger);

    this.workspace = new WorkspaceService(this.config, this.logger);
    this.compiler = new CompilerService(this.config, this.logger);
    this.runner = new ProcessRunner(this.logger);
    this.tests = new TestService(this.compiler, this.runner, this.config, this.logger);
    this.diagnostics = new DiagnosticsRecorder(this.logger);
    this.submissions = new SubmissionService(this.client, this.auth, this.logger, this.diagnostics);
    this.atcoderAuth = new AtCoderAuthService(this.atcoderClient, context.secrets, this.logger);
    this.atcoderSubmissions = new AtCoderSubmissionService(
      this.atcoderClient,
      this.atcoderAuth,
      this.logger,
      this.diagnostics,
    );
    this.atcoderProblems = new AtCoderProblemsClient(
      new CsesClient(this.logger, ATCODER_PROBLEMS_ORIGIN),
      this.logger,
    );

    this.explorer = new ProblemExplorerProvider(
      this.repository,
      this.progress,
      this.judges,
      this.logger,
    );
    this.progressView = new ProgressViewProvider(this.repository, this.progress, this.judges);

    this.disposables.push(
      this.logger,
      this.repository,
      this.progress,
      this.contests,
      this.judges,
      this.auth,
      this.atcoderAuth,
      this.explorer,
      this.progressView,
    );
  }

  get log(): Logger {
    return this.logger;
  }

  setWebviewManager(manager: ProblemWebviewManager): void {
    this.webviewManager = manager;
    this.disposables.push(manager);
  }

  get webviews(): ProblemWebviewManager {
    if (!this.webviewManager) {
      throw new Error('Webview manager accessed before initialization.');
    }
    return this.webviewManager;
  }

  setTestPanel(panel: TestPanelView): void {
    this.testPanelView = panel;
    this.disposables.push(panel);
  }

  get testPanel(): TestPanelView {
    if (!this.testPanelView) {
      throw new Error('Test panel accessed before initialization.');
    }
    return this.testPanelView;
  }

  setBrowser(browser: ProblemBrowserView): void {
    this.browserView = browser;
    this.disposables.push(browser);
  }

  get browser(): ProblemBrowserView | undefined {
    return this.browserView;
  }

  setContestView(view: ContestView): void {
    this.contestViewInstance = view;
    this.disposables.push(view);
  }

  get contestView(): ContestView {
    if (!this.contestViewInstance) {
      throw new Error('Contest view accessed before initialization.');
    }
    return this.contestViewInstance;
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}
