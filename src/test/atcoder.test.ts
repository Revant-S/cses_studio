import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { nullLogger } from '../core/logger';
import { AtCoderScraper, ATCODER_ORIGIN, convertVarToMath } from '../services/atcoderScraper';
import { CsesClient } from '../services/csesClient';
import { DEFAULT_JUDGE, parseProblemKey, problemKey } from '../models/judge';

function scraper(): AtCoderScraper {
  return new AtCoderScraper(new CsesClient(nullLogger, ATCODER_ORIGIN), nullLogger);
}

/** Reduced from the live contest task table. */
const TASK_LIST = `<table><tbody>
<tr>
  <td class="text-center no-break"><a href="/contests/dp/tasks/dp_a">A</a></td>
  <td><a href="/contests/dp/tasks/dp_a">Frog 1</a></td>
  <td class="text-right">2 sec</td><td class="text-right">1024 MiB</td>
</tr>
<tr>
  <td class="text-center no-break"><a href="/contests/dp/tasks/dp_b">B</a></td>
  <td><a href="/contests/dp/tasks/dp_b">Frog 2</a></td>
  <td class="text-right">2 sec</td><td class="text-right">1024 MiB</td>
</tr>
</tbody></table>`;

/** Reduced from the live `dp_a` page. */
const TASK_PAGE = `<!DOCTYPE html><html><body>
<p>Time Limit: 2 sec / Memory Limit: 1024 MiB</p>
<div id="task-statement">
<span class="lang">
<span class="lang-ja">
<div class="part"><section><h3>問題文</h3><p>日本語の説明です。</p></section></div>
<div class="part"><section><h3>入力例 1</h3><pre>99
</pre></section></div>
</span>
<span class="lang-en">
<div class="part"><section><h3>Problem Statement</h3>
<p>There are <var>N</var> stones, numbered <var>1, 2, \\ldots, N</var>.</p></section></div>
<div class="part"><section><h3>Constraints</h3>
<ul><li><var>2 \\leq N \\leq 10^5</var></li></ul></section></div>
<div class="part"><section><h3>Input</h3><p>Input is given from Standard Input.</p></section></div>
<div class="part"><section><h3>Output</h3><p>Print the minimum cost.</p></section></div>
<div class="part"><section><h3>Sample Input 1</h3><pre>4
10 30 40 20
</pre></section></div>
<div class="part"><section><h3>Sample Output 1</h3><pre>30
</pre><p>Follow the path 1 to 2 to 4.</p></section></div>
<div class="part"><section><h3>Sample Input 2</h3><pre>2
10 10
</pre></section></div>
<div class="part"><section><h3>Sample Output 2</h3><pre>0
</pre></section></div>
</span>
</span>
</div></body></html>`;

const summary = {
  judge: 'atcoder-dp' as const,
  id: 'dp_a',
  title: 'A — Frog 1',
  category: 'Educational DP Contest',
  url: 'https://atcoder.jp/contests/dp/tasks/dp_a',
};

describe('AtCoder task list', () => {
  const problems = scraper().parseTaskList(TASK_LIST);

  it('reads every task row', () => {
    assert.equal(problems.length, 2);
    assert.deepEqual(
      problems.map((p) => p.id),
      ['dp_a', 'dp_b'],
    );
  });

  it('keeps the contest letter in the title', () => {
    assert.equal(problems[0]?.title, 'A — Frog 1');
  });

  it('stamps the judge so storage keys stay namespaced', () => {
    assert.equal(problems[0]?.judge, 'atcoder-dp');
  });
});

describe('AtCoder statement', () => {
  const problem = scraper().parseProblem(summary, TASK_PAGE);

  it('selects English and drops the Japanese sibling', () => {
    assert.match(problem.statement, /There are/);
    assert.doesNotMatch(
      problem.statement + problem.input + problem.constraints,
      /[぀-ヿ一-龯]/,
      'no Japanese text may leak into the English statement',
    );
  });

  it('splits the nested part/section structure', () => {
    assert.match(problem.constraints, /10\^5/);
    assert.match(problem.input, /Standard Input/);
    assert.match(problem.output, /minimum cost/);
  });

  it('reads both limits', () => {
    assert.equal(problem.timeLimit, 2);
    assert.equal(problem.memoryLimit, 1024);
  });

  it('pairs samples by their trailing number', () => {
    assert.equal(problem.samples.length, 2);
    assert.equal(problem.samples[0]?.input, '4\n10 30 40 20\n');
    assert.equal(problem.samples[0]?.output, '30\n');
    assert.equal(problem.samples[1]?.input, '2\n10 10\n');
    assert.equal(problem.samples[1]?.output, '0\n');
  });

  it('captures the explanation that follows an expected output', () => {
    assert.match(problem.samples[0]?.explanation ?? '', /Follow the path/);
    assert.equal(problem.samples[1]?.explanation, undefined);
  });

  it('does not pick up the Japanese sample block', () => {
    assert.ok(
      problem.samples.every((s) => !s.input.includes('99')),
      'Japanese 入力例 must not become a sample',
    );
  });
});

describe('convertVarToMath', () => {
  it('rewrites <var> into the span the KaTeX renderer expects', () => {
    assert.equal(
      convertVarToMath('<p>at most <var>10^5</var> stones</p>'),
      '<p>at most <span class="math math-inline">10^5</span> stones</p>',
    );
  });

  it('handles several occurrences on one line', () => {
    const out = convertVarToMath('<var>a</var> and <var>b</var>');
    assert.equal((out.match(/math-inline/g) ?? []).length, 2);
  });

  it('leaves markup without <var> untouched', () => {
    assert.equal(convertVarToMath('<p>plain</p>'), '<p>plain</p>');
  });
});

describe('problem keys', () => {
  it('leaves CSES ids bare so existing progress is preserved', () => {
    assert.equal(problemKey(DEFAULT_JUDGE, '1194'), '1194');
  });

  it('namespaces other judges', () => {
    assert.equal(problemKey('atcoder-dp', 'dp_a'), 'atcoder-dp:dp_a');
  });

  it('round-trips', () => {
    assert.deepEqual(parseProblemKey('atcoder-dp:dp_a'), { judge: 'atcoder-dp', id: 'dp_a' });
    assert.deepEqual(parseProblemKey('1194'), { judge: 'cses', id: '1194' });
  });

  it('does not mistake a colon in a CSES id for a judge prefix', () => {
    assert.deepEqual(parseProblemKey('weird:id'), { judge: 'cses', id: 'weird:id' });
  });
});
