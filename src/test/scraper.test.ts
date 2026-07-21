import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ProblemStatus } from '../models/problem';
import { parseHtml, sanitizeHtml } from '../services/html';
import { CsesScraper, extractTaskId, parseSamples, statusFromIconClass } from '../services/scraper';
import { CsesClient } from '../services/csesClient';
import { nullLogger } from '../core/logger';

/** Trimmed copy of a real cses.fi task page, kept in the shape the parser sees. */
const TASK_PAGE = `<!DOCTYPE html><html><body>
<div class="content">
<ul class="task-constraints">
<li><b>Time limit:</b> 1.50 s</li>
<li><b>Memory limit:</b> 512 MB</li>
</ul>
<div class="md"><p>Consider an algorithm on <span class="math math-inline">n</span>.</p>
<h1 id="input">Input</h1>
<p>The only input line contains an integer <span class="math math-inline">n</span>.</p>
<h1 id="output">Output</h1>
<p>Print all values.</p>
<h1 id="constraints">Constraints</h1>
<ul><li><span class="math math-inline">1 \\le n \\le 10^6</span></li></ul>
<h1 id="example">Example</h1>
<p>Input:</p>
<pre>3
</pre>
<p>Output:</p>
<pre>3 10 5 16 8 4 2 1
</pre>
<p>Explanation: the sequence halves and triples.</p></div>
</div></body></html>`;

const summary = {
  id: '1068',
  title: 'Weird Algorithm',
  category: 'Introductory Problems',
  url: 'https://cses.fi/problemset/task/1068',
};

function scraper(): CsesScraper {
  return new CsesScraper(new CsesClient(nullLogger), nullLogger);
}

describe('parseProblem', () => {
  const problem = scraper().parseProblem(summary, TASK_PAGE);

  it('reads the time and memory limits', () => {
    assert.equal(problem.timeLimit, 1.5);
    assert.equal(problem.memoryLimit, 512);
  });

  it('splits the statement into sections', () => {
    assert.match(problem.statement, /Consider an algorithm/);
    assert.match(problem.input, /only input line/);
    assert.match(problem.output, /Print all values/);
    assert.match(problem.constraints, /10\^6/);
  });

  it('does not leak later sections into the statement', () => {
    assert.doesNotMatch(problem.statement, /Print all values/);
  });

  it('preserves math markup for KaTeX to render in the webview', () => {
    assert.match(problem.constraints, /class="math math-inline"/);
  });

  it('extracts the sample with its explanation', () => {
    assert.equal(problem.samples.length, 1);
    assert.equal(problem.samples[0]?.input, '3\n');
    assert.equal(problem.samples[0]?.output, '3 10 5 16 8 4 2 1\n');
    assert.match(problem.samples[0]?.explanation ?? '', /halves and triples/);
  });

  it('carries the summary fields through', () => {
    assert.equal(problem.id, '1068');
    assert.equal(problem.category, 'Introductory Problems');
  });
});

describe('parseIndex', () => {
  const INDEX_PAGE = `<div class="content">
<h2>General</h2>
<ul class="task-list"><li class="text"><a href="/problemset/text/2433">Introduction</a></ul>
<h2>Introductory Problems</h2>
<ul class="task-list">
<li class="task"><a href="/problemset/task/1068">Weird Algorithm</a><span class="detail">171823 / 179570</span> <span class="task-score icon full"></span>
<li class="task"><a href="/problemset/task/1083">Missing Number</a><span class="detail">148396 / 155168</span> <span class="task-score icon zero"></span>
</ul>
<h2>Sorting and Searching</h2>
<ul class="task-list">
<li class="task"><a href="/problemset/task/1621">Distinct Numbers</a><span class="detail">10 / 20</span> <span class="task-score icon "></span>
</ul></div>`;

  const instance = scraper() as unknown as {
    parseIndex(html: string): Array<{ name: string; problems: unknown[] }>;
  };
  const categories = instance.parseIndex(INDEX_PAGE);

  it('skips link-only lists such as "General"', () => {
    assert.deepEqual(
      categories.map((c) => c.name),
      ['Introductory Problems', 'Sorting and Searching'],
    );
  });

  it('collects the problems under each heading', () => {
    assert.equal(categories[0]?.problems.length, 2);
    assert.equal(categories[1]?.problems.length, 1);
  });

  it('parses solver counts', () => {
    const first = categories[0]?.problems[0] as { solvedCount: number; attemptedCount: number };
    assert.equal(first.solvedCount, 171823);
    assert.equal(first.attemptedCount, 179570);
  });
});

describe('statusFromIconClass', () => {
  it('maps "full" to solved', () => {
    assert.equal(statusFromIconClass('task-score icon full'), ProblemStatus.Solved);
  });

  it('maps "zero" to attempted', () => {
    assert.equal(statusFromIconClass('task-score icon zero'), ProblemStatus.Attempted);
  });

  it('treats a bare icon (anonymous session) as unsolved', () => {
    assert.equal(statusFromIconClass('task-score icon '), ProblemStatus.Unsolved);
  });
});

describe('extractTaskId', () => {
  it('pulls the id from a task href', () => {
    assert.equal(extractTaskId('/problemset/task/1068'), '1068');
  });

  it('ignores non-task links', () => {
    assert.equal(extractTaskId('/problemset/text/2433'), undefined);
  });
});

describe('parseSamples', () => {
  function nodes(html: string) {
    return parseHtml(`<div>${html}</div>`).childNodes[0]!.childNodes as never;
  }

  it('pairs labelled input and output blocks', () => {
    const samples = parseSamples(nodes('<p>Input:</p><pre>1\n</pre><p>Output:</p><pre>2\n</pre>'));
    assert.equal(samples.length, 1);
    assert.equal(samples[0]?.input, '1\n');
    assert.equal(samples[0]?.output, '2\n');
  });

  it('splits multiple examples on a repeated input label', () => {
    const samples = parseSamples(
      nodes(
        '<p>Input:</p><pre>1\n</pre><p>Output:</p><pre>2\n</pre><p>Input:</p><pre>3\n</pre><p>Output:</p><pre>4\n</pre>',
      ),
    );
    assert.equal(samples.length, 2);
    assert.equal(samples[1]?.input, '3\n');
    assert.equal(samples[1]?.output, '4\n');
    assert.deepEqual(
      samples.map((s) => s.index),
      [1, 2],
    );
  });

  it('handles an interactive transcript with no output block', () => {
    const samples = parseSamples(nodes('<p>Input:</p><pre>3\n? 3 2\n</pre>'));
    assert.equal(samples.length, 1);
    assert.equal(samples[0]?.output, '');
  });

  it('decodes entities inside sample data', () => {
    const samples = parseSamples(nodes('<p>Input:</p><pre>a &lt; b &amp; c\n</pre>'));
    assert.equal(samples[0]?.input, 'a < b & c\n');
  });

  it('preserves interior blank lines but normalizes the trailing newline', () => {
    const samples = parseSamples(nodes('<p>Input:</p><pre>1\n\n2\n\n\n</pre>'));
    assert.equal(samples[0]?.input, '1\n\n2\n');
  });
});

describe('sanitizeHtml', () => {
  it('removes script elements', () => {
    const root = sanitizeHtml(parseHtml('<div><p>ok</p><script>alert(1)</script></div>'));
    assert.doesNotMatch(root.toString(), /script/);
    assert.match(root.toString(), /ok/);
  });

  it('strips inline event handlers', () => {
    const root = sanitizeHtml(parseHtml('<div><img src="x.png" onerror="alert(1)"></div>'));
    assert.doesNotMatch(root.toString(), /onerror/);
  });

  it('strips javascript: URLs but keeps ordinary links', () => {
    const root = sanitizeHtml(
      parseHtml('<div><a href="javascript:alert(1)">a</a><a href="/ok">b</a></div>'),
    );
    assert.doesNotMatch(root.toString(), /javascript:/);
    assert.match(root.toString(), /href="\/ok"/);
  });
});
