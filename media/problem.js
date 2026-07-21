// global acquireVsCodeApi, katex.
// Webview client for the problem viewer.
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  // ---------------- Math ----------------.

  /** CSES ships LaTeX inside `<span class="math math-inline|math-display">`. */
  function renderMath() {
    if (typeof katex === 'undefined') {
      return;
    }
    const macros = {};
    for (const element of document.querySelectorAll('.math')) {
      const source = element.textContent;
      try {
        katex.render(source, element, {
          displayMode: element.classList.contains('math-display'),
          throwOnError: false,
          globalGroup: true,
          macros,
        });
      } catch {
        element.textContent = source;
      }
    }
  }

  // ---------------- Helpers ----------------.

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function post(type, payload) {
    vscode.postMessage({ type, ...payload });
  }

  function byId(id) {
    return document.getElementById(id);
  }

  // ---------------- Toolbar & copy buttons ----------------.

  document.addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]');
    if (action) {
      handleAction(action.dataset.action, action);
      return;
    }
    const header = event.target.closest('.result-header');
    if (header) {
      const body = header.nextElementSibling;
      if (body && body.classList.contains('result-body')) {
        body.hidden = !body.hidden;
      }
    }
  });

  function handleAction(action, element) {
    switch (action) {
      case 'open-editor':
        post('openEditor');
        break;
      case 'run-samples':
        post('runSamples');
        break;
      case 'submit':
        post('submit');
        break;
      case 'open-browser':
        post('openInBrowser');
        break;
      case 'refresh':
        post('refresh');
        break;
      case 'run-custom':
        runCustom();
        break;
      case 'stop-custom':
        post('stopCustom');
        break;
      case 'copy': {
        const target = byId(element.dataset.target);
        if (target) {
          navigator.clipboard.writeText(target.textContent).then(() => flash(element, 'Copied'));
        }
        break;
      }
      case 'use-sample': {
        const input = byId(element.dataset.target);
        const box = byId('custom-input');
        if (input && box) {
          box.value = input.textContent;
          box.scrollIntoView({ behavior: 'smooth', block: 'center' });
          box.focus();
        }
        break;
      }
      default:
        break;
    }
  }

  /** Momentarily swaps a button's label to acknowledge an action. */
  function flash(element, message) {
    const original = element.textContent;
    element.textContent = message;
    element.disabled = true;
    setTimeout(() => {
      element.textContent = original;
      element.disabled = false;
    }, 1000);
  }

  // ---------------- Custom test ----------------.

  function runCustom() {
    const box = byId('custom-input');
    if (!box) {
      return;
    }
    setCustomRunning(true);
    byId('custom-result').innerHTML =
      '<div class="empty"><span class="spinner"></span> Running…</div>';
    post('runCustom', { input: box.value });
  }

  function setCustomRunning(running) {
    const run = byId('btn-run-custom');
    const stop = byId('btn-stop-custom');
    if (run) {
      run.disabled = running;
    }
    if (stop) {
      stop.hidden = !running;
    }
  }

  function renderCustomResult(result) {
    setCustomRunning(false);
    const container = byId('custom-result');
    if (!container) {
      return;
    }
    if (result.error) {
      container.innerHTML = `<div class="result errored"><div class="result-header"><span class="icon-warn">⚠</span><span class="verdict">${escapeHtml(result.error)}</span></div></div>`;
      return;
    }

    const status = result.timedOut ? 'errored' : result.exitCode === 0 ? 'passed' : 'failed';
    const label = result.timedOut
      ? 'Timed out'
      : result.exitCode === 0
        ? 'Finished'
        : `Exited with code ${result.exitCode}`;

    const parts = [
      `<div class="result ${status}">`,
      `<div class="result-header"><span class="verdict">${escapeHtml(label)}</span>`,
      `<span class="timing">${result.durationMs} ms</span></div>`,
      '<div class="result-body">',
      '<div class="io-grid">',
      `<div><div class="io-title">stdout</div><pre class="io-block">${escapeHtml(result.stdout) || '<span class="empty">(empty)</span>'}</pre></div>`,
      `<div><div class="io-title">stderr</div><pre class="io-block">${escapeHtml(result.stderr) || '<span class="empty">(empty)</span>'}</pre></div>`,
      '</div></div></div>',
    ];
    container.innerHTML = parts.join('');
  }

  // ---------------- Sample results ----------------.

  function renderSampleResults(payload) {
    const container = byId('sample-results');
    if (!container) {
      return;
    }

    if (payload.status === 'running') {
      container.innerHTML = `<div class="empty"><span class="spinner"></span> ${escapeHtml(payload.message || 'Running samples…')}</div>`;
      return;
    }
    if (payload.status === 'error') {
      container.innerHTML = `<div class="result errored"><div class="result-header"><span class="icon-warn">⚠</span><span class="verdict">${escapeHtml(payload.message)}</span></div>${payload.detail ? `<div class="result-body"><pre class="io-block">${escapeHtml(payload.detail)}</pre></div>` : ''}</div>`;
      return;
    }

    const results = payload.results || [];
    if (results.length === 0) {
      container.innerHTML = '<div class="empty">No samples to run.</div>';
      return;
    }

    const passed = results.filter((r) => r.passed).length;
    const allPassed = passed === results.length;
    const html = [
      `<div class="summary-bar ${allPassed ? 'all-passed' : 'has-failures'}">`,
      `${allPassed ? '✓' : '✗'} ${passed} / ${results.length} sample${results.length === 1 ? '' : 's'} passed`,
      '</div>',
    ];

    for (const result of results) {
      html.push(renderOneResult(result));
    }
    container.innerHTML = html.join('');
  }

  function renderOneResult(result) {
    const state = result.passed ? 'passed' : result.kind === 'runtime' ? 'errored' : 'failed';
    const icon = result.passed
      ? '<span class="icon-pass">✓</span>'
      : '<span class="icon-fail">✗</span>';

    const rows = [
      `<div class="result ${state}">`,
      `<div class="result-header">${icon}<span class="verdict">Sample ${result.index} ${escapeHtml(result.label)}</span>`,
      `<span class="timing">${result.durationMs} ms</span></div>`,
      // Passing cases collapse by default to keep failures prominent.
      `<div class="result-body"${result.passed ? ' hidden' : ''}>`,
      '<div class="io-grid">',
      `<div><div class="io-title">Input</div><pre class="io-block">${escapeHtml(result.input)}</pre></div>`,
      `<div><div class="io-title">Expected</div><pre class="io-block">${escapeHtml(result.expected)}</pre></div>`,
      '</div>',
      `<div class="io-title" style="margin-top:12px">Received</div><pre class="io-block">${escapeHtml(result.actual) || '<span class="empty">(empty)</span>'}</pre>`,
    ];

    if (result.stderr) {
      rows.push(
        `<div class="io-title" style="margin-top:12px">stderr</div><pre class="io-block">${escapeHtml(result.stderr)}</pre>`,
      );
    }
    if (!result.passed && result.diff && result.diff.length > 0) {
      rows.push('<div class="io-title" style="margin-top:12px">Diff</div>');
      rows.push(`<pre class="io-block">${renderDiff(result.diff)}</pre>`);
    }
    rows.push('</div></div>');
    return rows.join('');
  }

  const DIFF_GUTTER = { added: '+', removed: '-', context: ' ' };

  function renderDiff(diff) {
    return diff
      .map(
        (line) =>
          `<span class="diff-line ${line.type}"><span class="diff-gutter">${DIFF_GUTTER[line.type] || ' '}</span>${escapeHtml(line.text)}</span>`,
      )
      .join('');
  }

  // ---------------- Host messages ----------------.

  window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.type) {
      case 'customResult':
        renderCustomResult(message.result);
        break;
      case 'sampleResults':
        renderSampleResults(message);
        break;
      case 'status':
        updateStatus(message.status);
        break;
      default:
        break;
    }
  });

  function updateStatus(status) {
    const chip = byId('status-chip');
    if (!chip) {
      return;
    }
    chip.className = `chip status-${status}`;
    chip.textContent = status.charAt(0).toUpperCase() + status.slice(1);
  }

  // ---------------- Init ----------------.

  // Restore scroll position and custom input across panel hide/show.
  const previous = vscode.getState() || {};
  const customBox = byId('custom-input');
  if (customBox && previous.customInput) {
    customBox.value = previous.customInput;
  }
  if (customBox) {
    customBox.addEventListener('input', () => {
      vscode.setState({ ...(vscode.getState() || {}), customInput: customBox.value });
    });
  }

  renderMath();
  post('ready');
})();
