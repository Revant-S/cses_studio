import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { type HTMLElement, parseHtml, resolveUrls, sanitizeHtml } from '../services/html';
import { parseSamples } from '../services/scraper';

const root = path.resolve(__dirname, '..', '..');
const read = (relative: string): string => fs.readFileSync(path.join(root, relative), 'utf8');

const TASK_URL = 'https://cses.fi/problemset/task/1071';

describe('resolveUrls', () => {
  it('points a root-relative image at the judge', () => {
    const html =
      '<p>Here are the first five layers:\n<center><img class="invertible" src="/file/bba36f26" alt="" /></center></p>';
    const resolved = resolveUrls(html, TASK_URL);

    assert.match(resolved, /src="https:\/\/cses\.fi\/file\/bba36f26"/);
  });

  it('keeps the attributes that size and theme the image', () => {
    const html = '<img class="invertible" src="/file/382652cc" width="250" height="" alt="" />';
    const resolved = resolveUrls(html, TASK_URL);

    assert.match(resolved, /class="invertible"/);
    assert.match(resolved, /width="250"/);
  });

  it('leaves an already absolute URL alone', () => {
    const html = '<img src="https://cses.fi/file/abc">';

    assert.equal(resolveUrls(html, TASK_URL), html);
  });

  it('is idempotent, so a re-render never doubles a prefix', () => {
    const once = resolveUrls('<img src="/file/abc">', TASK_URL);

    assert.equal(resolveUrls(once, TASK_URL), once);
  });

  it('resolves a document-relative link against the task page', () => {
    const resolved = resolveUrls('<a href="1072">next</a>', TASK_URL);

    assert.match(resolved, /href="https:\/\/cses\.fi\/problemset\/task\/1072"/);
  });

  it('leaves an in-page anchor relative so it still scrolls the panel', () => {
    const html = '<a href="#input">Input</a>';

    assert.equal(resolveUrls(html, TASK_URL), html);
  });

  it('resolves AtCoder statement images against their contest page', () => {
    const resolved = resolveUrls(
      '<img src="/img/dp/knapsack.png">',
      'https://atcoder.jp/contests/dp/tasks/dp_d',
    );

    assert.match(resolved, /src="https:\/\/atcoder\.jp\/img\/dp\/knapsack\.png"/);
  });

  it('gives a protocol-relative URL the page scheme', () => {
    const resolved = resolveUrls('<img src="//cses.fi/file/abc">', TASK_URL);

    assert.match(resolved, /src="https:\/\/cses\.fi\/file\/abc"/);
  });

  it('passes empty and image-free statements straight through', () => {
    assert.equal(resolveUrls('', TASK_URL), '');
    assert.equal(resolveUrls('<p>No pictures here.</p>', TASK_URL), '<p>No pictures here.</p>');
  });

  it('leaves a base URL it cannot parse untouched instead of throwing', () => {
    const html = '<img src="/file/abc">';

    assert.equal(resolveUrls(html, 'not a url'), html);
  });

  it('keeps sample blocks byte-for-byte when a statement is rewritten', () => {
    const html = '<img src="/file/abc"><pre>3\n2 3\n1 1\n</pre>';
    const resolved = resolveUrls(html, TASK_URL);

    assert.match(resolved, /<pre>3\n2 3\n1 1\n<\/pre>/);
  });
});

describe('statement images in the problem panel', () => {
  it('renders every section with the problem URL as the base', () => {
    const source = read('src/views/problemWebview.ts');
    for (const section of ['Statement', 'Input', 'Output', 'Constraints', 'Notes']) {
      assert.match(
        source,
        new RegExp(`renderSection\\('${section}', problem\\.\\w+, problem\\.url\\)`),
        `the ${section} section must resolve its URLs`,
      );
    }
  });

  it('allows remote images through the panel CSP', () => {
    assert.match(read('src/views/problemWebview.ts'), /img-src \$\{webview\.cspSource\} https:/);
  });

  it('fits a wide diagram to the statement measure', () => {
    const css = read('media/problem.css');
    const block = css.slice(css.indexOf('.prose img {'));
    const body = block.slice(block.indexOf('{'), block.indexOf('}'));

    assert.match(body, /max-width:\s*100%/);
  });

  it('inverts CSES line art on dark themes', () => {
    assert.match(read('media/problem.css'), /body\.vscode-dark \.prose img\.invertible/);
  });
});

/** The Example section of CSES 3111, where the figure sits in the explanation. */
const EXAMPLE_SECTION = `<p>Input:</p>
<pre>4
1 2 5
</pre>
<p>Output:</p>
<pre>12
</pre>
<p><em>Explanation</em>: The following figure corresponds to the sample input:
<center><img class="invertible" src="/file/16b8144" alt="" /></center>
Here <span class="math math-inline">d(1,2)=5</span>, so the sum is 12.</p>`;

/** CSES 3306 splits the same explanation across three paragraphs. */
const SPLIT_EXAMPLE_SECTION = `<p>Input:</p>
<pre>4 2
</pre>
<p>Output:</p>
<pre>5
</pre>
<p><em>Explanation</em>: The following figure shows the map:</p>
<p><center><img class="invertible" src="/file/45b7b85" alt="" /></center></p>
<p>In this case, the best choice is the free campsite on the right.</p>`;

/** Runs an Example section through the same path the scraper uses. */
function samplesOf(section: string): ReturnType<typeof parseSamples> {
  const root = sanitizeHtml(parseHtml(`<div class="md">${section}</div>`));
  const md = root.querySelector('div.md');
  return parseSamples((md?.childNodes ?? []) as HTMLElement[]);
}

describe('example figures', () => {
  it('keeps the figure drawn inside an explanation', () => {
    const [sample] = samplesOf(EXAMPLE_SECTION);

    assert.match(sample?.explanationHtml ?? '', /<img[^>]*src="\/file\/16b8144"/);
  });

  it('still reads the input and output around it', () => {
    const [sample] = samplesOf(EXAMPLE_SECTION);

    assert.equal(sample?.input, '4\n1 2 5\n');
    assert.equal(sample?.output, '12\n');
  });

  it('still exposes the explanation as plain text for older consumers', () => {
    const [sample] = samplesOf(EXAMPLE_SECTION);

    assert.match(sample?.explanation ?? '', /The following figure corresponds/);
    assert.doesNotMatch(sample?.explanation ?? '', /<img/);
  });

  it('collects an explanation split across several paragraphs', () => {
    const [sample] = samplesOf(SPLIT_EXAMPLE_SECTION);

    assert.match(sample?.explanationHtml ?? '', /<img[^>]*src="\/file\/45b7b85"/);
    assert.match(sample?.explanationHtml ?? '', /the best choice is the free campsite/);
  });

  it('resolves an explanation figure against the task page', () => {
    const [sample] = samplesOf(EXAMPLE_SECTION);
    const rendered = resolveUrls(sample?.explanationHtml ?? '', TASK_URL);

    assert.match(rendered, /src="https:\/\/cses\.fi\/file\/16b8144"/);
  });

  it('keeps the explanation of an interactive task, which has no output block', () => {
    const [sample] = samplesOf(
      '<pre>3\n? 3 2\nNO\n</pre><p>Explanation: The hidden permutation is [3, 1, 2].</p>',
    );

    assert.match(sample?.explanation ?? '', /The hidden permutation/);
    assert.match(sample?.explanationHtml ?? '', /The hidden permutation/);
  });

  it('leaves an example with no explanation alone', () => {
    const [sample] = samplesOf('<p>Input:</p><pre>1\n</pre><p>Output:</p><pre>2\n</pre>');

    assert.equal(sample?.explanation, undefined);
    assert.equal(sample?.explanationHtml, undefined);
  });

  it('renders the explanation markup instead of escaping it', () => {
    const source = read('src/views/problemWebview.ts');

    assert.match(source, /sample\.explanationHtml\b/);
    assert.match(source, /resolveUrls\(sample\.explanationHtml, baseUrl\)/);
  });
});
