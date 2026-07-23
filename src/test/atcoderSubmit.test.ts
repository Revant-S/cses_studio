import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Verdict } from '../models/verdict';
import { CookieJar } from '../services/cookieJar';
import { extractCsrfToken } from '../services/identity';
import {
  findLatestSubmissionId,
  parseLanguageOptions,
  parseSubmissionPage,
  pickLanguageId,
} from '../services/atcoderSubmitter';

describe('AtCoder CSRF token', () => {
  it('decodes HTML entities in the token', () => {
    const html = '<input type="hidden" name="csrf_token" value="jwPyGY0Q6P&#43;97u&#43;xyz=" />';
    assert.equal(extractCsrfToken(html), 'jwPyGY0Q6P+97u+xyz=');
  });

  it('returns undefined when the field is absent', () => {
    assert.equal(extractCsrfToken('<form><input name="username"></form>'), undefined);
  });
});

describe('parseLanguageOptions', () => {
  const PAGE = `<div id="select-lang">
<select name="data.LanguageId">
<option value="">-</option>
<option value="5001">C++ 20 (gcc 12.2)</option>
<option value="5002">C++ 23 (gcc 12.2)</option>
<option value="5003">C++ 20 (Clang 16.0.6)</option>
<option value="5055">Python (CPython 3.11.4)</option>
<option value="5078">Python (PyPy 3.10-v7.3.12)</option>
</select></div>
<select name="data.SomethingElse"><option value="9">no</option></select>`;

  it('reads only the language select', () => {
    const options = parseLanguageOptions(PAGE);
    assert.equal(options.length, 5);
    assert.ok(!options.some((o) => o.id === '9'), 'must ignore unrelated selects');
  });

  it('skips the empty placeholder option', () => {
    assert.ok(!parseLanguageOptions(PAGE).some((o) => o.id === ''));
  });

  it('returns nothing when the select is missing', () => {
    assert.deepEqual(parseLanguageOptions('<div>no form here</div>'), []);
  });

  it('picks the newest GCC C++ rather than Clang or an older standard', () => {
    const options = parseLanguageOptions(PAGE);
    assert.equal(pickLanguageId(options, 'cpp'), '5002');
  });

  it('prefers PyPy for Python, which CPython rarely matches on DP limits', () => {
    const options = parseLanguageOptions(PAGE);
    assert.equal(pickLanguageId(options, 'python'), '5078');
  });

  it('returns undefined when no option matches the language', () => {
    const onlyRust = [{ id: '5054', label: 'Rust (rustc 1.70.0)' }];
    assert.equal(pickLanguageId(onlyRust, 'cpp'), undefined);
  });
});

describe('findLatestSubmissionId', () => {
  const LIST = `<table><tbody>
<tr>
  <td>2026-07-22 10:00</td>
  <td><a href="/contests/dp/tasks/dp_b">B - Frog 2</a></td>
  <td><a href="/contests/dp/submissions/61111111">Detail</a></td>
</tr>
<tr>
  <td>2026-07-22 09:00</td>
  <td><a href="/contests/dp/tasks/dp_a">A - Frog 1</a></td>
  <td><a href="/contests/dp/submissions/60000000">Detail</a></td>
</tr>
</tbody></table>`;

  it('matches the row for the task submitted, not merely the newest', () => {
    assert.equal(findLatestSubmissionId(LIST, 'dp_a'), '60000000');
  });

  it('finds a different task on the same page', () => {
    assert.equal(findLatestSubmissionId(LIST, 'dp_b'), '61111111');
  });

  it('falls back to the first submission link when the task cannot be matched', () => {
    assert.equal(findLatestSubmissionId(LIST, 'dp_zz'), '61111111');
  });
});

describe('parseSubmissionPage', () => {
  const page = (status: string, extra = ''): string =>
    `<table>
<tr><th>Task</th><td>A - Frog 1</td></tr>
<tr><th>Status</th><td><span id="judge-status">${status}</span></td></tr>
<tr><th>Exec Time</th><td>12 ms</td></tr>
<tr><th>Memory</th><td>3456 KB</td></tr>
</table>${extra}`;

  it('maps AtCoder abbreviations', () => {
    assert.equal(parseSubmissionPage('1', 'u', page('AC')).verdict, Verdict.Accepted);
    assert.equal(parseSubmissionPage('1', 'u', page('WA')).verdict, Verdict.WrongAnswer);
    assert.equal(parseSubmissionPage('1', 'u', page('TLE')).verdict, Verdict.TimeLimitExceeded);
    assert.equal(parseSubmissionPage('1', 'u', page('MLE')).verdict, Verdict.MemoryLimitExceeded);
    assert.equal(parseSubmissionPage('1', 'u', page('RE')).verdict, Verdict.RuntimeError);
    assert.equal(parseSubmissionPage('1', 'u', page('CE')).verdict, Verdict.CompileError);
  });

  it('treats WJ as still judging so polling continues', () => {
    assert.equal(parseSubmissionPage('1', 'u', page('WJ')).verdict, Verdict.Pending);
  });

  it('treats an "n/m" progress counter as still judging', () => {
    // This is the trap: 3/26 is progress, not a final verdict.
    assert.equal(parseSubmissionPage('1', 'u', page('3/26')).verdict, Verdict.Pending);
  });

  it('reads exec time and memory', () => {
    const result = parseSubmissionPage('1', 'u', page('AC'));
    assert.equal(result.time, '12 ms');
    assert.equal(result.memory, '3456 KB');
  });

  it('collects the per-case table', () => {
    const cases = `<table><tbody>
<tr><td>00_sample_01.txt</td><td>AC</td><td>10 ms</td></tr>
<tr><td>01_random_01.txt</td><td>WA</td><td>11 ms</td></tr>
</tbody></table>`;
    const result = parseSubmissionPage('1', 'u', page('WA', cases));

    assert.equal(result.tests.length, 2);
    assert.equal(result.tests[1]?.verdict, Verdict.WrongAnswer);
  });

  it('does not mistake summary rows for test cases', () => {
    const result = parseSubmissionPage('1', 'u', page('AC'));
    assert.equal(result.tests.length, 0);
  });
});

describe('cookie persistence safety', () => {
  /** AtCoder's REVEL_FLASH echoes the submitted form back. */
  it('never persists REVEL_FLASH, which contains the password', () => {
    const jar = new CookieJar();
    jar.set('REVEL_SESSION', 'abc123');
    jar.set('REVEL_FLASH', '%00error%3AError.%00%00password%3Ahunter2%00');

    const exported = jar.export();
    assert.deepEqual(
      exported.map((c) => c.name),
      ['REVEL_SESSION'],
    );
    assert.ok(
      !JSON.stringify(exported).includes('hunter2'),
      'no part of a flash cookie may reach storage',
    );
  });

  it('still sends the flash cookie on live requests', () => {
    const jar = new CookieJar();
    jar.set('REVEL_SESSION', 'abc');
    jar.set('REVEL_FLASH', 'x');
    assert.match(jar.toHeader() ?? '', /REVEL_FLASH=x/);
  });

  it('round-trips the session cookie through storage', () => {
    const jar = new CookieJar();
    jar.set('REVEL_SESSION', 'abc123');
    const restored = CookieJar.from(jar.export());
    assert.equal(restored.get('REVEL_SESSION'), 'abc123');
  });
});
