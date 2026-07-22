import * as vscode from 'vscode';
import type { Logger } from '../core/logger';
import { DEFAULT_JUDGE, type JudgeId, judgeOf, JUDGES } from '../models/judge';

const STORAGE_KEY = 'cses.activeJudge';

/** Tracks which judge the UI is currently showing. */
export class JudgeSelection implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<JudgeId>();
  private readonly log: Logger;
  private current: JudgeId;

  readonly onDidChange = this.changed.event;

  constructor(
    private readonly storage: vscode.Memento,
    logger: Logger,
  ) {
    this.log = logger.scoped('judge');
    this.current = judgeOf(storage.get<string>(STORAGE_KEY, DEFAULT_JUDGE));
  }

  get active(): JudgeId {
    return this.current;
  }

  async setActive(judge: JudgeId): Promise<void> {
    if (judge === this.current) {
      return;
    }
    this.current = judge;
    await this.storage.update(STORAGE_KEY, judge);
    this.log.info(`Active judge is now ${JUDGES[judge].name}`);
    this.changed.fire(judge);
  }

  dispose(): void {
    this.changed.dispose();
  }
}
