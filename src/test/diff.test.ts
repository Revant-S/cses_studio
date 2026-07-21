import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { diffLines, firstDifference, normalizeOutput, outputsMatch } from '../services/diff';

const trimming = { trimTrailingWhitespace: true };
const strict = { trimTrailingWhitespace: false };

describe('normalizeOutput', () => {
  it('strips trailing blank lines and per-line trailing whitespace', () => {
    assert.deepEqual(normalizeOutput('a  \nb\t\n\n\n', trimming), ['a', 'b']);
  });

  it('preserves leading whitespace, which is significant', () => {
    assert.deepEqual(normalizeOutput('  a\n', trimming), ['  a']);
  });

  it('normalizes CRLF line endings', () => {
    assert.deepEqual(normalizeOutput('a\r\nb\r\n', trimming), ['a', 'b']);
  });

  it('keeps trailing blanks when trimming is disabled', () => {
    assert.deepEqual(normalizeOutput('a\n\n', strict), ['a', '', '']);
  });
});

describe('outputsMatch', () => {
  it('accepts output missing the final newline', () => {
    assert.equal(outputsMatch('3 10 5 1\n', '3 10 5 1', trimming), true);
  });

  it('accepts trailing spaces on a line', () => {
    assert.equal(outputsMatch('42\n', '42   \n', trimming), true);
  });

  it('rejects a genuinely different value', () => {
    assert.equal(outputsMatch('42\n', '43\n', trimming), false);
  });

  it('rejects extra output lines', () => {
    assert.equal(outputsMatch('1\n', '1\n2\n', trimming), false);
  });

  it('treats internal whitespace as significant', () => {
    assert.equal(outputsMatch('1 2\n', '1  2\n', trimming), false);
  });
});

describe('diffLines', () => {
  it('is empty for identical output', () => {
    assert.deepEqual(diffLines('a\nb\n', 'a\nb\n', trimming), []);
  });

  it('marks a changed line as removed then added', () => {
    const diff = diffLines('a\nb\n', 'a\nc\n', trimming);
    assert.deepEqual(
      diff.map((line) => [line.type, line.text]),
      [
        ['context', 'a'],
        ['removed', 'b'],
        ['added', 'c'],
      ],
    );
  });

  it('reports pure insertions as added', () => {
    const diff = diffLines('a\n', 'a\nb\n', trimming);
    assert.deepEqual(
      diff.filter((l) => l.type === 'added').map((l) => l.text),
      ['b'],
    );
  });

  it('collapses long runs of unchanged context', () => {
    const expected = Array.from({ length: 60 }, (_, i) => `line${i}`).join('\n');
    const actual = expected.replace('line30', 'WRONG');
    const diff = diffLines(expected, actual, trimming);

    assert.ok(
      diff.some((line) => line.text === '…'),
      'expected a collapse marker',
    );
    assert.ok(diff.length < 30, `diff should be compact, got ${diff.length} lines`);
    assert.ok(diff.some((line) => line.type === 'removed' && line.text === 'line30'));
    assert.ok(diff.some((line) => line.type === 'added' && line.text === 'WRONG'));
  });

  it('truncates pathologically long output instead of hanging', () => {
    const huge = Array.from({ length: 5000 }, (_, i) => String(i)).join('\n');
    const diff = diffLines('1\n', huge, trimming, { maxLines: 100 });
    assert.ok(diff.some((line) => line.text.includes('truncated')));
  });
});

describe('firstDifference', () => {
  it('reports the 1-based line number of the first mismatch', () => {
    const difference = firstDifference('1\n2\n3\n', '1\n9\n3\n', trimming);
    assert.deepEqual(difference, { line: 2, expected: '2', actual: '9' });
  });

  it('reports missing lines', () => {
    const difference = firstDifference('1\n2\n', '1\n', trimming);
    assert.deepEqual(difference, { line: 2, expected: '2', actual: '(no line)' });
  });

  it('returns undefined when equal', () => {
    assert.equal(firstDifference('1\n', '1\n', trimming), undefined);
  });
});
