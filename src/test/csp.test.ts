import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';


const root = path.resolve(__dirname, '..', '..');
const read = (relative: string): string => fs.readFileSync(path.join(root, relative), 'utf8');

const STRICT_CSP_SCRIPTS = ['media/browser.js', 'media/tests.js', 'media/contest.js'];

describe('strict-CSP webview assets', () => {
  for (const file of STRICT_CSP_SCRIPTS) {
    it(`${file} emits no inline style attributes`, () => {
      const source = read(file);
      // Ignore the explanatory comments that mention the attribute by name.
      const offenders = source
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
        .filter((line) => /style\s*=\s*["'`]/.test(line));

      assert.deepEqual(
        offenders,
        [],
        `inline style attributes are blocked by CSP; set properties via element.style instead`,
      );
    });
  }

  it('bar fills default to zero width so a missing width never reads as full', () => {
    const bars: Array<[string, string]> = [
      ['media/browser.css', '.bar .fill'],
      ['media/browser.css', '.category-bar .fill'],
      ['media/contest.css', '.bar .fill'],
    ];
    for (const [file, selector] of bars) {
      const css = read(file);
      const block = css.slice(css.indexOf(selector));
      const body = block.slice(block.indexOf('{'), block.indexOf('}'));
      assert.match(body, /width:\s*0/, `${file} ${selector} must declare width: 0`);
    }
  });

  it('the browser view keeps a strict style-src', () => {
    const source = read('src/views/problemBrowserView.ts');
    assert.match(source, /style-src \$\{webview\.cspSource\}`/);
    assert.doesNotMatch(source, /style-src[^`]*unsafe-inline/);
  });

  it('applies widths through the CSSOM instead', () => {
    assert.match(read('media/browser.js'), /\.style\.width\s*=/);
  });
});
