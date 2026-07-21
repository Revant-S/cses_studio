import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { StaticConfigurationProvider, defaultConfiguration } from '../core/config';
import { CompilationError } from '../core/errors';
import { nullLogger } from '../core/logger';
import type { Problem } from '../models/problem';
import { CompilerService } from '../services/compiler';
import { ProcessRunner } from '../services/runner';
import { TestService } from '../services/testService';
import { WorkspaceService } from '../services/workspace';


let root: string;
let workspace: WorkspaceService;
let tests: TestService;

const problem: Problem = {
  id: '1068',
  title: 'Weird Algorithm',
  category: 'Introductory Problems',
  url: 'https://cses.fi/problemset/task/1068',
  statement: '<p>statement</p>',
  input: '',
  output: '',
  constraints: '',
  notes: '',
  timeLimit: 1,
  memoryLimit: 512,
  samples: [
    { index: 1, input: '3\n', output: '3 10 5 16 8 4 2 1\n' },
    { index: 2, input: '1\n', output: '1\n' },
  ],
  fetchedAt: Date.now(),
};

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cses-studio-test-'));
  const config = new StaticConfigurationProvider(
    defaultConfiguration({ workspaceRoot: root, timeLimitFactor: 5 }),
  );
  workspace = new WorkspaceService(config, nullLogger);
  tests = new TestService(
    new CompilerService(config, nullLogger),
    new ProcessRunner(nullLogger),
    config,
    nullLogger,
  );
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const CORRECT = `#include <bits/stdc++.h>
using namespace std;
int main(){long long n;cin>>n;cout<<n;while(n!=1){n=(n%2==0)?n/2:3*n+1;cout<<" "<<n;}cout<<"\\n";}
`;

const WRONG = `#include <bits/stdc++.h>
int main(){std::cout<<"nope\\n";}
`;

const CRASHES = `#include <bits/stdc++.h>
int main(){std::vector<int> v; return v.at(5);}
`;

const HANGS = `int main(){for(;;){}}
`;

const BROKEN = `int main(){ this is not c++ }
`;

describe('workspace generation', () => {
  it('creates the solution file, metadata and samples', async () => {
    const generated = await workspace.prepare(problem);

    assert.equal(path.basename(generated.solutionFile), 'problem.cpp');
    assert.match(generated.directory, /1068-Weird-Algorithm$/);
    assert.equal(generated.existed, false);

    const source = await fs.readFile(generated.solutionFile, 'utf8');
    assert.match(source, /int main\(\)/);

    assert.equal(await fs.readFile(path.join(generated.samplesDir, 'sample1.in'), 'utf8'), '3\n');
    assert.equal(
      await fs.readFile(path.join(generated.samplesDir, 'sample1.out'), 'utf8'),
      '3 10 5 16 8 4 2 1\n',
    );
  });

  it('never overwrites an existing solution', async () => {
    const generated = await workspace.prepare(problem);
    await fs.writeFile(generated.solutionFile, '// my work\n', 'utf8');

    const again = await workspace.prepare(problem);
    assert.equal(again.existed, true);
    assert.equal(await fs.readFile(again.solutionFile, 'utf8'), '// my work\n');
  });

  it('resolves a source file back to its problem', async () => {
    const generated = await workspace.prepare(problem);
    const resolved = await workspace.resolveFromFile(generated.solutionFile);

    assert.equal(resolved?.metadata.problemId, '1068');
    assert.equal(resolved?.language, 'cpp');
  });

  it('returns undefined for a file outside any workspace', async () => {
    const stray = path.join(root, 'stray.cpp');
    await fs.writeFile(stray, 'int main(){}', 'utf8');
    assert.equal(await workspace.resolveFromFile(stray), undefined);
  });

  it('reads samples back from disk', async () => {
    const generated = await workspace.prepare(problem);
    const loaded = await tests.readSamplesFromDisk(generated.samplesDir);

    assert.equal(loaded.length, 2);
    assert.equal(loaded[0]?.input, '3\n');
    assert.equal(loaded[1]?.output, '1\n');
  });
});

/** Writes a source file into an isolated directory and runs the samples. */
async function runWith(source: string, name: string) {
  const directory = path.join(root, 'cases', name);
  await fs.mkdir(directory, { recursive: true });
  const sourceFile = path.join(directory, 'problem.cpp');
  await fs.writeFile(sourceFile, source, 'utf8');

  return tests.runSamples({
    sourceFile,
    language: 'cpp',
    samples: problem.samples,
    timeLimitSeconds: problem.timeLimit as number,
    forceRebuild: true,
  });
}

describe('sample runner', () => {
  it('passes a correct solution on every sample', async () => {
    const results = await runWith(CORRECT, 'correct');

    assert.equal(results.length, 2);
    assert.ok(
      results.every((result) => result.passed),
      `expected all passed, got ${JSON.stringify(results.map((r) => r.label))}`,
    );
    assert.equal(results[0]?.kind, 'passed');
  });

  it('reports a wrong answer with a diff and a first-difference summary', async () => {
    const results = await runWith(WRONG, 'wrong');
    const first = results[0];

    assert.equal(first?.passed, false);
    assert.equal(first?.kind, 'wrong-answer');
    assert.equal(first?.label, 'Wrong Answer');
    assert.ok(first!.diff.length > 0, 'expected a diff');
    assert.match(first?.summary ?? '', /Line 1/);
    assert.ok(first!.diff.some((line) => line.type === 'added' && line.text === 'nope'));
  });

  it('classifies a crash as a runtime error', async () => {
    const results = await runWith(CRASHES, 'crash');

    assert.equal(results[0]?.passed, false);
    assert.equal(results[0]?.kind, 'runtime');
    assert.match(results[0]?.label ?? '', /Runtime Error/);
  });

  it('classifies an infinite loop as a timeout rather than hanging', async () => {
    const results = await runWith(HANGS, 'hang');

    assert.equal(results[0]?.passed, false);
    assert.equal(results[0]?.kind, 'timeout');
    assert.equal(results[0]?.label, 'Time Limit Exceeded');
  });

  it('surfaces compiler diagnostics as a CompilationError', async () => {
    await assert.rejects(
      () => runWith(BROKEN, 'broken'),
      (error: unknown) => {
        assert.ok(error instanceof CompilationError);
        assert.ok(error.stderr.length > 0, 'expected compiler stderr');
        return true;
      },
    );
  });
});

describe('custom test runner', () => {
  it('captures stdout, exit code and duration', async () => {
    const directory = path.join(root, 'cases', 'custom');
    await fs.mkdir(directory, { recursive: true });
    const sourceFile = path.join(directory, 'problem.cpp');
    await fs.writeFile(sourceFile, CORRECT, 'utf8');

    const result = await tests.runCustom({
      sourceFile,
      language: 'cpp',
      input: '6\n',
      timeLimitSeconds: 1,
    });

    assert.equal(result.stdout.trim(), '6 3 10 5 16 8 4 2 1');
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.ok(result.durationMs >= 0);
  });

  it('reports stderr separately from stdout', async () => {
    const directory = path.join(root, 'cases', 'stderr');
    await fs.mkdir(directory, { recursive: true });
    const sourceFile = path.join(directory, 'problem.cpp');
    await fs.writeFile(
      sourceFile,
      '#include <bits/stdc++.h>\nint main(){std::cout<<"out\\n";std::cerr<<"err\\n";}\n',
      'utf8',
    );

    const result = await tests.runCustom({ sourceFile, language: 'cpp', input: '' });
    assert.equal(result.stdout.trim(), 'out');
    assert.equal(result.stderr.trim(), 'err');
  });
});
