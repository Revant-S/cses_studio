import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Verdict, parseVerdict } from '../models/verdict';
import { parseHtml } from '../services/html';
import {
  extractSubmissionId,
  findUploadForm,
  parseTestDetail,
  parseResultPage,
  pickCompilerOption,
  pickLanguage,
} from '../services/submitter';

describe('pickLanguage', () => {
  it('selects the C++ entry from the site’s own list', () => {
    assert.equal(pickLanguage(['C++', 'Python', 'Java'], 'cpp'), 'C++');
  });

  it('selects Python for the python setting', () => {
    assert.equal(pickLanguage(['C++', 'Python', 'Java'], 'python'), 'Python');
  });

  it('falls back to a sane default when the list is empty', () => {
    assert.equal(pickLanguage([], 'cpp'), 'C++');
  });
});

describe('pickCompilerOption', () => {
  it('prefers the newest available C++ standard', () => {
    assert.equal(pickCompilerOption(['C++11', 'C++17', 'C++20'], 'cpp'), 'C++20');
  });

  it('falls back to an older standard when the newest is absent', () => {
    assert.equal(pickCompilerOption(['C++11', 'C++17'], 'cpp'), 'C++17');
  });

  it('prefers CPython over PyPy to match local testing', () => {
    assert.equal(pickCompilerOption(['CPython3', 'PyPy3'], 'python'), 'CPython3');
  });

  it('returns undefined when the form offers no options', () => {
    assert.equal(pickCompilerOption([], 'cpp'), undefined);
  });
});

describe('extractSubmissionId', () => {
  it('reads the id from a redirected URL', () => {
    assert.equal(extractSubmissionId('https://cses.fi/problemset/result/12345/', ''), '12345');
  });

  it('falls back to a link in the body', () => {
    assert.equal(
      extractSubmissionId('https://cses.fi/course/send.php', '<a href="/problemset/result/999/">'),
      '999',
    );
  });

  it('returns undefined when neither carries an id', () => {
    assert.equal(extractSubmissionId('https://cses.fi/login', '<p>nope</p>'), undefined);
  });
});

describe('parseVerdict', () => {
  const cases: Array<[string, Verdict]> = [
    ['ACCEPTED', Verdict.Accepted],
    ['WRONG ANSWER', Verdict.WrongAnswer],
    ['TIME LIMIT EXCEEDED', Verdict.TimeLimitExceeded],
    ['MEMORY LIMIT EXCEEDED', Verdict.MemoryLimitExceeded],
    ['RUNTIME ERROR', Verdict.RuntimeError],
    ['COMPILE ERROR', Verdict.CompileError],
    ['PENDING', Verdict.Pending],
    ['something else', Verdict.Unknown],
  ];

  for (const [text, expected] of cases) {
    it(`maps "${text}"`, () => {
      assert.equal(parseVerdict(text), expected);
    });
  }

  it('matches case-insensitively', () => {
    assert.equal(parseVerdict('Accepted'), Verdict.Accepted);
  });

  it('treats a compile error as compile, not runtime', () => {
    assert.equal(parseVerdict('COMPILATION ERROR'), Verdict.CompileError);
  });
});

describe('findUploadForm', () => {
  const FIELDS = `<input type="hidden" name="csrf_token" value="tok">
<input type="hidden" name="type" value="1">
<input type="hidden" name="target" value="1194">
<input type="file" name="file">
<select name="lang"><option>C++</option><option>Python</option></select>
<select name="option"><option>C++11</option><option>C++17</option></select>
<input type="submit" value="Submit">`;

  it('reads a normal form', () => {
    const form = findUploadForm(parseHtml(`<form action="/course/send.php">${FIELDS}</form>`));

    assert.equal(form?.action, '/course/send.php');
    assert.equal(form?.fileField, 'file');
    assert.deepEqual(form?.fields, { csrf_token: 'tok', type: '1', target: '1194' });
    assert.equal(form?.languageField, 'lang');
    assert.equal(form?.optionField, 'option');
  });

  it('excludes the submit button from the posted fields', () => {
    const form = findUploadForm(parseHtml(`<form>${FIELDS}</form>`));
    assert.ok(!('Submit' in (form?.fields ?? {})));
  });

  it('falls back to the document when no form element wraps the inputs', () => {
    // The real submit page reached this state: right inputs, no parseable form.
    const form = findUploadForm(parseHtml(`<div class="content">${FIELDS}</div>`));

    assert.ok(form, 'expected the fallback to find the inputs');
    assert.equal(form?.fileField, 'file');
    assert.equal(form?.fields.csrf_token, 'tok');
    assert.equal(form?.fields.target, '1194');
    assert.equal(form?.action, '');
  });

  it('returns undefined when there is no file input at all', () => {
    const form = findUploadForm(parseHtml('<div><input type="text" name="q"></div>'));
    assert.equal(form, undefined);
  });

  it('prefers a real form over the document fallback', () => {
    const html = `<div><input type="hidden" name="stray" value="x">
<form action="/real">${FIELDS}</form></div>`;
    const form = findUploadForm(parseHtml(html));

    assert.equal(form?.action, '/real');
    assert.ok(!('stray' in (form?.fields ?? {})), 'must not pull in inputs outside the form');
  });
});

describe('CSES submit page (real markup)', () => {
  // Reduced from a captured cses.fi submit page.
  const REAL = `<!DOCTYPE html><html><head><title>CSES - Monsters - Submit</title></head>
<body>
<form action="/course/send.php" method="post" enctype="multipart/form-data">
<input type="hidden" name="csrf_token" value="tok">
<script>
function checkSelects() {
  var list = options[lang.value];
  for (var i = 0; i < list.length; i++) { option.add(o); }
}
var options = {"C++":["C++11","C++17","C++20","C++23"],"Python3":["CPython3","PyPy3"]}
var defaults = {"C++":"C++20","Python3":"PyPy3"}
var task = 1194
</script>
<p>Task:
Monsters<input type="hidden" name="task" value="1194">
</p>
<p>Code:
<input type="file" name="file" onchange="check(this)">
</p>
<p>Language:
<select name="lang" id="lang">
<option value="">?
<option value="C">C<option value="C++">C++<option value="Python3">Python3</select>
<span id="optionInput" style="display: none;">
Option:
<select name="option" id="option">
</select>
</span>
</p>

<p><input type="submit" value="Submit"></p>
<input type="hidden" name="type" value="course">
<input type="hidden" name="target" value="problemset">
</form></body></html>`;

  const root = parseHtml(REAL);

  it('survives the unclosed option tags that previously destroyed the tree', () => {
    assert.ok(root.querySelector('body'), 'body element must survive parsing');
    assert.equal(root.querySelectorAll('form').length, 1);
  });

  it('discovers the upload form and its action', () => {
    const form = findUploadForm(root);
    assert.equal(form?.action, '/course/send.php');
    assert.equal(form?.fileField, 'file');
  });

  it('collects every hidden field CSES requires', () => {
    const form = findUploadForm(root);
    assert.deepEqual(form?.fields, {
      csrf_token: 'tok',
      task: '1194',
      type: 'course',
      target: 'problemset',
    });
  });

  it('reads the language list despite the unclosed options', () => {
    const form = findUploadForm(root);
    assert.deepEqual(form?.languageOptions, ['C', 'C++', 'Python3']);
  });

  it('recovers compiler options from the script when the select is empty', () => {
    const form = findUploadForm(root);
    assert.equal(form?.optionValues.length, 0, 'the served select really is empty');
    assert.deepEqual(form?.scriptOptions?.options['C++'], ['C++11', 'C++17', 'C++20', 'C++23']);
    assert.equal(form?.scriptOptions?.defaults['C++'], 'C++20');
  });

  it('posts the same language and option a browser would', () => {
    const form = findUploadForm(root);
    const cpp = pickLanguage(form!.languageOptions, 'cpp');
    assert.equal(cpp, 'C++');
    assert.equal(pickCompilerOption(form!.optionValues, 'cpp', form!.scriptOptions, cpp), 'C++20');

    const py = pickLanguage(form!.languageOptions, 'python');
    assert.equal(py, 'Python3');
    assert.equal(
      pickCompilerOption(form!.optionValues, 'python', form!.scriptOptions, py),
      'PyPy3',
    );
  });
});

describe('compiler warnings vs errors', () => {
  // Real gcc output from a solution that compiled fine and then failed on the judge's tests.
  const WARNING = `<pre>input/code.cpp: In function 'void solve()':
input/code.cpp:153:17: warning: overflow in conversion from 'float' to 'long long int' changes value from '+Inff' to '9223372036854775807' [-Woverflow]
  153 |     vll dis(n+1,INFINITY);
      |                 ^~~~~~~~
</pre>`;

  const ERROR = `<pre>input/code.cpp:3:5: error: expected ';' before '}' token
</pre>`;

  it('does not call a warnings-only build a compile error', () => {
    const result = parseResultPage('1', 'u', WARNING);
    assert.notEqual(result.verdict, Verdict.CompileError);
    assert.notEqual(result.rawVerdict, 'COMPILE ERROR');
  });

  it('still surfaces the warning text for the user to read', () => {
    const result = parseResultPage('1', 'u', WARNING);
    assert.match(result.compilerOutput ?? '', /-Woverflow/);
  });

  it('lets the real verdict win over compiler warnings', () => {
    const html = `<table><tr><td>Result:</td><td>WRONG ANSWER</td></tr></table>${WARNING}`;
    assert.equal(parseResultPage('1', 'u', html).verdict, Verdict.WrongAnswer);
  });

  it('still detects a genuine compile error', () => {
    const result = parseResultPage('1', 'u', ERROR);
    assert.equal(result.verdict, Verdict.CompileError);
    assert.match(result.compilerOutput ?? '', /expected/);
  });
});

describe('parseTestDetail', () => {
  const DETAIL = `<html><body><div class="content">
<h1>Test 7</h1>
<h2>Input</h2>
<pre>5 8
1 2 3 4 5
</pre>
<h2>Correct output</h2>
<pre>15
</pre>
<h2>Your output</h2>
<pre>14
</pre>
</div></body></html>`;

  it('reads input, expected and actual output by their labels', () => {
    const detail = parseTestDetail(DETAIL);
    assert.equal(detail.input, '5 8\n1 2 3 4 5\n');
    assert.equal(detail.expectedOutput, '15\n');
    assert.equal(detail.actualOutput, '14\n');
    assert.equal(detail.truncated, false);
  });

  it('flags truncated test data so it is not replayed as complete', () => {
    const truncated = DETAIL.replace(
      '<h2>Input</h2>',
      '<h2>Input</h2><p>(output is truncated)</p>',
    );
    assert.equal(parseTestDetail(truncated).truncated, true);
  });

  it('tolerates a missing section', () => {
    const partial = '<div class="content"><h2>Input</h2><pre>1\n</pre></div>';
    const detail = parseTestDetail(partial);
    assert.equal(detail.input, '1\n');
    assert.equal(detail.expectedOutput, undefined);
  });

  it('returns nothing useful for an unrelated page', () => {
    const detail = parseTestDetail('<div class="content"><p>Nothing here</p></div>');
    assert.equal(detail.input, undefined);
    assert.equal(detail.expectedOutput, undefined);
  });

  it('accepts "Expected output" as an alternative label', () => {
    const alt = '<div class="content"><h2>Expected output</h2><pre>42\n</pre></div>';
    assert.equal(parseTestDetail(alt).expectedOutput, '42\n');
  });
});

describe('result page test rows', () => {
  it('captures the per-test detail link', () => {
    const html = `<table>
<tr><td>1</td><td>ACCEPTED</td><td>0.01 s</td></tr>
<tr><td><a href="/problemset/tests/1194/2/">2</a></td><td>WRONG ANSWER</td><td>0.02 s</td></tr>
</table>`;
    const result = parseResultPage('5', 'u', html);
    const failed = result.tests.find((test) => test.verdict !== Verdict.Accepted);

    assert.equal(failed?.test, 2);
    assert.equal(failed?.detailUrl, '/problemset/tests/1194/2/');
  });
});

describe('parseResultPage', () => {
  const ACCEPTED = `<html><body><table>
<tr><td>Task:</td><td>Monsters</td></tr>
<tr><td>Result:</td><td>ACCEPTED</td></tr>
<tr><td>Time:</td><td>0.12 s</td></tr>
<tr><td>Memory:</td><td>3.4 MB</td></tr>
</table>
<table><tr><th>test</th><th>verdict</th><th>time</th></tr>
<tr><td>1</td><td>ACCEPTED</td><td>0.01 s</td></tr>
<tr><td>2</td><td>ACCEPTED</td><td>0.02 s</td></tr>
</table></body></html>`;

  it('reads verdict, time and memory by label', () => {
    const result = parseResultPage('1', 'https://cses.fi/problemset/result/1/', ACCEPTED);
    assert.equal(result.verdict, Verdict.Accepted);
    assert.equal(result.time, '0.12 s');
    assert.equal(result.memory, '3.4 MB');
  });

  it('collects the per-test table', () => {
    const result = parseResultPage('1', 'u', ACCEPTED);
    assert.equal(result.tests.length, 2);
    assert.equal(result.tests[0]?.test, 1);
    assert.equal(result.tests[1]?.verdict, Verdict.Accepted);
  });

  it('reports a pending submission as non-terminal', () => {
    const html = '<table><tr><td>Result:</td><td>PENDING</td></tr></table>';
    assert.equal(parseResultPage('1', 'u', html).verdict, Verdict.Pending);
  });

  it('surfaces the failing test for a wrong answer', () => {
    const html = `<table><tr><td>Result:</td><td>WRONG ANSWER</td></tr></table>
<table><tr><td>1</td><td>ACCEPTED</td></tr><tr><td>2</td><td>WRONG ANSWER</td></tr></table>`;
    const result = parseResultPage('1', 'u', html);

    assert.equal(result.verdict, Verdict.WrongAnswer);
    const failed = result.tests.find((test) => test.verdict !== Verdict.Accepted);
    assert.equal(failed?.test, 2);
  });

  it('infers a compile error from compiler output alone', () => {
    const html = '<pre>problem.cpp:3:5: error: expected ‘;’ before ‘}’</pre>';
    const result = parseResultPage('1', 'u', html);

    assert.equal(result.verdict, Verdict.CompileError);
    assert.match(result.compilerOutput ?? '', /expected/);
  });
});
