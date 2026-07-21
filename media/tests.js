// global acquireVsCodeApi.
// Bottom test panel: one tab per sample plus a custom-input tab.
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};

  let problem = null;
  let cases = []; // { key, index, input, output, judge }
  let results = {}; // case key -> result
  let custom = saved.custom || '';
  let customResult = null;
  let activeTab = saved.activeTab || 0; // 0..n-1 samples, 'custom'
  let running = false;

  const el = (id) => document.getElementById(id);

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function persist() {
    vscode.setState({ custom, activeTab });
  }

  // ---------------- Header & tabs ----------------.

  function renderHead() {
    el('problem').innerHTML = problem
      ? `${escapeHtml(problem.title)} <span class="pid">#${escapeHtml(problem.id)}</span>`
      : '<span class="dim">No problem open</span>';

    el('btn-run').disabled = running || !problem;
    el('btn-run-all').disabled = running || !problem || cases.length === 0;
    el('btn-submit').disabled = running || !problem;
    el('btn-run').innerHTML = running
      ? '<span class="spinner"></span> Running'
      : activeTab === 'custom'
        ? '▶ Run custom'
        : '▶ Run case';
  }

  const MARKS = { passed: 'pass', 'wrong-answer': 'fail', timeout: 'warn', runtime: 'warn' };

  function renderTabs() {
    const tabs = cases.map((c, index) => {
      const result = results[c.key];
      const kind = result ? MARKS[result.kind] || 'fail' : '';
      const glyph = !result ? '' : result.passed ? '✓' : '✗';
      // Judge cases keep the judge's own test number so they map back to CSES.
      const label = c.judge ? `Test ${c.index}` : `Case ${c.index}`;
      return `<button class="tab${c.judge ? ' judge' : ''}" role="tab" data-tab="${index}" aria-selected="${activeTab === index}">
  ${glyph ? `<span class="mark ${kind}">${glyph}</span>` : ''}${label}
</button>`;
    });

    tabs.push(
      `<button class="tab" role="tab" data-tab="custom" aria-selected="${activeTab === 'custom'}">Custom</button>`,
    );
    el('tabs').innerHTML = tabs.join('');
  }

  // ---------------- Panes ----------------.

  function renderBody() {
    const body = el('body');

    if (!problem) {
      body.innerHTML =
        '<div class="empty">Open a problem from the CSES view to run its sample tests here.</div>';
      return;
    }

    if (activeTab === 'custom') {
      body.innerHTML = renderCustomPane();
      const box = el('custom-input');
      box.value = custom;
      box.addEventListener('input', () => {
        custom = box.value;
        persist();
      });
      return;
    }

    const current = cases[activeTab];
    if (!current) {
      body.innerHTML = '<div class="empty">This problem has no sample tests.</div>';
      return;
    }
    body.innerHTML = renderSamplePane(current, results[current.key]);
  }

  function renderSamplePane(sample, result) {
    const parts = [];

    if (sample.judge) {
      parts.push(
        `<div class="judge-note">Imported from judge test ${sample.index} of your last submission.</div>`,
      );
    }

    if (result) {
      const cls = result.passed ? 'pass' : result.kind === 'wrong-answer' ? 'fail' : 'warn';
      parts.push(
        `<div class="verdict ${cls}">${result.passed ? '✓' : '✗'} ${escapeHtml(result.label)}`,
        `<span class="timing">${result.durationMs} ms</span></div>`,
      );
      if (result.summary) {
        parts.push(`<div class="summary">${escapeHtml(result.summary)}</div>`);
      }
    }

    parts.push(
      '<div class="io-grid">',
      `<div><div class="io-title"><span>Input</span></div><pre class="io">${escapeHtml(sample.input)}</pre></div>`,
      `<div><div class="io-title"><span>Expected</span></div><pre class="io">${escapeHtml(sample.output)}</pre></div>`,
      '</div>',
    );

    if (result) {
      parts.push(
        `<div class="section-gap"><div class="io-title"><span>Your output</span></div>`,
        `<pre class="io${result.passed ? '' : ' bad'}">${escapeHtml(result.actual) || '(empty)'}</pre></div>`,
      );
      if (result.stderr) {
        parts.push(
          `<div class="section-gap"><div class="io-title"><span>stderr</span></div>`,
          `<pre class="io">${escapeHtml(result.stderr)}</pre></div>`,
        );
      }
      if (!result.passed && result.diff && result.diff.length) {
        parts.push(
          `<div class="section-gap"><div class="io-title"><span>Diff</span></div>`,
          `<pre class="io">${renderDiff(result.diff)}</pre></div>`,
        );
      }
    }
    return parts.join('');
  }

  function renderCustomPane() {
    const parts = [
      '<div class="io-title"><span>Custom input</span></div>',
      '<textarea id="custom-input" spellcheck="false" placeholder="Type input for your program…"></textarea>',
    ];

    if (customResult) {
      if (customResult.error) {
        parts.push(
          `<div class="verdict warn section-gap">⚠ ${escapeHtml(customResult.error)}</div>`,
        );
      } else {
        const ok = customResult.exitCode === 0 && !customResult.timedOut;
        const label = customResult.timedOut
          ? 'Timed out'
          : ok
            ? 'Finished'
            : `Exited with code ${customResult.exitCode}`;
        parts.push(
          `<div class="verdict ${ok ? 'pass' : 'fail'} section-gap">${ok ? '✓' : '✗'} ${escapeHtml(label)}`,
          `<span class="timing">${customResult.durationMs} ms</span></div>`,
          '<div class="io-grid">',
          `<div><div class="io-title"><span>stdout</span></div><pre class="io">${escapeHtml(customResult.stdout) || '(empty)'}</pre></div>`,
          `<div><div class="io-title"><span>stderr</span></div><pre class="io">${escapeHtml(customResult.stderr) || '(empty)'}</pre></div>`,
          '</div>',
        );
      }
    }
    return parts.join('');
  }

  const GUTTER = { added: '+', removed: '-', context: ' ' };

  function renderDiff(diff) {
    return diff
      .map(
        (line) =>
          `<span class="diff-line ${line.type}"><span class="diff-gutter">${GUTTER[line.type] || ' '}</span>${escapeHtml(line.text)}</span>`,
      )
      .join('');
  }

  function renderAll() {
    renderHead();
    renderTabs();
    renderBody();
  }

  // ---------------- Events ----------------.

  document.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-tab]');
    if (tab) {
      const value = tab.dataset.tab;
      activeTab = value === 'custom' ? 'custom' : Number(value);
      persist();
      renderAll();
      return;
    }

    const action = event.target.closest('[data-act]');
    if (!action || action.disabled) return;

    switch (action.dataset.act) {
      case 'run':
        if (activeTab === 'custom') {
          vscode.postMessage({ type: 'runCustom', input: custom });
        } else {
          const current = cases[activeTab];
          if (current) vscode.postMessage({ type: 'runCase', key: current.key });
        }
        break;
      case 'run-all':
        vscode.postMessage({ type: 'runAll' });
        break;
      case 'submit':
        vscode.postMessage({ type: 'submit' });
        break;
      case 'statement':
        vscode.postMessage({ type: 'openStatement' });
        break;
      default:
        break;
    }
  });

  window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.type) {
      case 'problem': {
        problem = message.problem;
        const samples = (message.samples || []).map((c) => ({
          ...c,
          key: `s${c.index}`,
          judge: false,
        }));
        const judge = (message.judgeCases || []).map((c) => ({
          ...c,
          key: `j${c.index}`,
          judge: true,
        }));
        cases = [...samples, ...judge];
        results = {};
        customResult = null;
        if (activeTab !== 'custom' && activeTab >= cases.length) activeTab = 0;
        renderAll();
        break;
      }
      case 'running':
        running = message.running;
        renderHead();
        break;
      case 'result': {
        const key = message.result.key;
        if (!key) break;
        results[key] = message.result;
        // Jump to the first failure so the interesting case is on screen.
        if (message.focus && !message.result.passed) {
          const position = cases.findIndex((c) => c.key === key);
          if (position >= 0) activeTab = position;
        }
        renderAll();
        break;
      }
      case 'customResult':
        customResult = message.result;
        activeTab = 'custom';
        running = false;
        renderAll();
        break;
      case 'clear':
        results = {};
        renderAll();
        break;
      default:
        break;
    }
  });

  renderAll();
  vscode.postMessage({ type: 'ready' });
})();
