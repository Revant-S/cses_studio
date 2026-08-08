import * as vscode from 'vscode';
import type { Container } from '../core/container';
import {
  MAX_CONTEST_MINUTES,
  MAX_CONTEST_PROBLEMS,
  MIN_CONTEST_MINUTES,
  MIN_CONTEST_PROBLEMS,
  REASON_LABELS,
  contestLabel,
  formatDuration,
  solvedCount,
} from '../models/contest';
import { resolveContestProblem } from '../services/contestService';
import { openProblem } from './openProblem';

/** Palette route into a contest: topics, size, length, go. */
export async function startContest(container: Container): Promise<void> {
  const judge = container.judges.active;
  const topics = await container.contests.topics(judge);

  if (topics.length === 0) {
    const choice = await vscode.window.showWarningMessage(
      'CSES: no problems are cached for this site yet.',
      'Fetch Problems',
    );
    if (choice) {
      await vscode.commands.executeCommand('cses.fetchProblems');
    }
    return;
  }

  const picked = await vscode.window.showQuickPick(
    topics.map((topic) => {
      const priority = topic.counts.revision + topic.counts.struggled;
      return {
        label: topic.name,
        description: `${topic.eligible} eligible`,
        detail:
          priority > 0
            ? `$(star-full) ${priority} marked to revise or retried`
            : `${topic.counts.fresh} untouched`,
        name: topic.name,
        picked: false,
      };
    }),
    {
      title: 'Contest: pick topics',
      placeHolder: 'Select one or more topics — leave empty for every topic.',
      canPickMany: true,
      matchOnDetail: true,
    },
  );
  // Escape cancels; an empty (but confirmed) selection means "all topics".
  if (!picked) {
    return;
  }

  const settings = container.config.get();
  const count = await promptNumber(
    'Contest: how many problems?',
    settings.contestProblems,
    MIN_CONTEST_PROBLEMS,
    MAX_CONTEST_PROBLEMS,
  );
  if (count === undefined) {
    return;
  }

  const minutes = await promptNumber(
    'Contest: how many minutes?',
    settings.contestMinutes,
    MIN_CONTEST_MINUTES,
    MAX_CONTEST_MINUTES,
  );
  if (minutes === undefined) {
    return;
  }

  const contest = await container.contests.start({
    judge,
    topics: picked.map((item) => item.name),
    count,
    durationMinutes: minutes,
  });

  await container.contestView.reveal();

  const lineup = contest.problems
    .map(
      (problem, position) =>
        `${contestLabel(position)}. ${problem.title} (${REASON_LABELS[problem.reason]})`,
    )
    .join('\n');
  container.log.info(`Contest line-up:\n${lineup}`);

  const open = await vscode.window.showInformationMessage(
    `CSES: contest started — ${contest.problems.length} problems, ${minutes} minutes.`,
    'Open First Problem',
  );
  if (open) {
    await openContestProblem(container, 0);
  }
}

/** Ends the running contest, after confirming, and reports the score. */
export async function endContest(container: Container): Promise<void> {
  const snapshot = container.contests.snapshot();
  if (!snapshot || !snapshot.running) {
    void vscode.window.showInformationMessage('CSES: no contest is running.');
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    `End the contest with ${formatDuration(snapshot.remainingMs)} left?`,
    { modal: true, detail: `You have solved ${snapshot.solved} of ${snapshot.total}.` },
    'End Contest',
  );
  if (confirm !== 'End Contest') {
    return;
  }

  const contest = await container.contests.end('abandoned');
  if (contest) {
    void vscode.window.showInformationMessage(
      `CSES: contest ended — ${solvedCount(contest)}/${contest.problems.length} solved.`,
    );
  }
}

/** Opens the next unsolved contest problem, so the keyboard alone can drive it. */
export async function openNextContestProblem(container: Container): Promise<void> {
  const contest = container.contests.active;
  if (!contest) {
    void vscode.window.showInformationMessage('CSES: no contest is running.');
    return;
  }

  const next = container.contests.nextUnsolved();
  if (!next) {
    void vscode.window.showInformationMessage('CSES: every contest problem is solved.');
    return;
  }
  await openContestProblem(container, contest.problems.indexOf(next));
}

async function openContestProblem(container: Container, position: number): Promise<void> {
  const problem = container.contests.active?.problems[position];
  if (!problem) {
    return;
  }
  await openProblem(container, await resolveContestProblem(container.repository, problem));
}

/** Numeric input box with range validation, returning undefined on cancel. */
async function promptNumber(
  title: string,
  value: number,
  min: number,
  max: number,
): Promise<number | undefined> {
  const answer = await vscode.window.showInputBox({
    title,
    value: String(value),
    prompt: `Between ${min} and ${max}.`,
    validateInput: (input) => {
      const parsed = Number(input);
      if (!Number.isInteger(parsed)) {
        return 'Enter a whole number.';
      }
      return parsed < min || parsed > max ? `Enter a number between ${min} and ${max}.` : undefined;
    },
  });
  return answer === undefined ? undefined : Number(answer);
}
