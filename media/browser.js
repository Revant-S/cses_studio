// global acquireVsCodeApi.
// Problem browser.
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};

  let data = { judge: '', judges: [], categories: [], statuses: {}, revisit: {} };

  let view = saved.view || 'list';
  let filter = saved.filter || 'all';
  let query = '';
  let activeId = saved.activeId || null;
  const collapsed = new Set(saved.collapsed || []);

  const el = (id) => document.getElementById(id);

  function persist() {
    vscode.setState({ view, filter, activeId, collapsed: [...collapsed] });
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function statusOf(id) {
    return data.statuses[id] || 'unsolved';
  }

  function isFlagged(id) {
    return data.revisit[id] === true;
  }

  // ---------------- Filtering ----------------.

  function matches(problem) {
    const status = statusOf(problem.id);
    if (filter === 'solved' && status !== 'solved') return false;
    if (filter === 'unsolved' && status === 'solved') return false;
    if (filter === 'attempted' && status !== 'attempted') return false;
    if (filter === 'revisit' && !isFlagged(problem.id)) return false;

    if (!query) return true;
    const q = query.toLowerCase();
    return (
      problem.title.toLowerCase().includes(q) ||
      problem.id.includes(q) ||
      problem.category.toLowerCase().includes(q)
    );
  }

  // ---------------- Rendering ----------------.

  /** Applies bar widths through the CSSOM. */
  function applyBarWidths(root) {
    for (const fill of (root || document).querySelectorAll('.fill[data-width]')) {
      const percent = Number(fill.dataset.width);
      fill.style.width = `${Number.isFinite(percent) ? percent : 0}%`;
    }
  }

  /** Judge switcher. */
  function renderJudgeNav() {
    const nav = el('judge-nav');
    if (!nav) return;
    if (!data.judges || data.judges.length < 2) {
      nav.innerHTML = '';
      return;
    }
    nav.innerHTML = data.judges
      .map(
        (j) =>
          `<button class="judge-tab" role="tab" data-judge="${escapeHtml(j.id)}"
   aria-selected="${j.id === data.judge}" title="${escapeHtml(j.name)}">${escapeHtml(j.label)}</button>`,
      )
      .join('');
  }

  function render() {
    renderJudgeNav();
    renderOverview();
    const root = el('list');
    root.className = view === 'gallery' ? 'gallery' : 'list';

    if (data.categories.length === 0) {
      root.innerHTML =
        '<div class="empty">No problems cached for this site yet.<br><button data-act="fetch">Fetch Problems</button></div>';
      return;
    }

    let shown = 0;
    const html = [];

    for (const category of data.categories) {
      const visible = category.problems.filter(matches);
      shown += visible.length;
      if (visible.length === 0) continue;

      const solved = visible.filter((p) => statusOf(p.id) === 'solved').length;
      // Searching should reveal matches, not hide them behind a collapsed header.
      const isCollapsed = collapsed.has(category.name) && !query && filter === 'all';
      const percent = visible.length ? Math.round((solved / visible.length) * 100) : 0;

      html.push(
        `<section class="category${isCollapsed ? ' collapsed' : ''}" data-cat="${escapeHtml(category.name)}">`,
        `<div class="category-head" data-act="toggle-cat">`,
        `<span class="chevron">▼</span>`,
        `<span class="category-name">${escapeHtml(category.name)}</span>`,
        `<span class="category-count">${solved}/${visible.length}</span>`,
        `</div>`,
        `<div class="category-bar"><div class="fill" data-width="${percent}"></div></div>`,
        `<div class="items">`,
        ...visible.map(view === 'gallery' ? renderCard : renderRow),
        `</div></section>`,
      );
    }

    if (shown === 0) {
      root.innerHTML = `<div class="empty">Nothing matches this filter.</div>`;
      return;
    }
    root.innerHTML = html.join('');
    applyBarWidths(root);
  }

  const STATUS_MARK = { solved: '✓', attempted: '', unsolved: '' };

  function renderRow(problem) {
    const status = statusOf(problem.id);
    const flagged = isFlagged(problem.id);
    const solvers =
      problem.solvedCount !== undefined ? `<span>${problem.solvedCount} solved</span>` : '';

    return `<div class="item${problem.id === activeId ? ' active' : ''}" data-id="${problem.id}" data-act="open">
  <span class="status ${status}">${STATUS_MARK[status]}</span>
  <span class="item-body">
    <span class="item-title">${escapeHtml(problem.title)}</span>
    <span class="item-meta"><span>#${problem.id}</span>${solvers}</span>
  </span>
  <button class="flag${flagged ? ' on' : ''}" data-act="flag" data-id="${problem.id}"
    title="${flagged ? 'Remove revision mark' : 'Mark for revision'}">${flagged ? '★' : '☆'}</button>
</div>`;
  }

  function renderCard(problem) {
    const status = statusOf(problem.id);
    const flagged = isFlagged(problem.id);

    return `<div class="card ${status}${problem.id === activeId ? ' active' : ''}" data-id="${problem.id}" data-act="open">
  <button class="flag${flagged ? ' on' : ''}" data-act="flag" data-id="${problem.id}"
    title="${flagged ? 'Remove revision mark' : 'Mark for revision'}">${flagged ? '★' : '☆'}</button>
  <div class="card-top"><span class="card-id">#${problem.id}</span></div>
  <div class="card-title">${escapeHtml(problem.title)}</div>
  <div class="card-foot"><span class="status ${status}">${STATUS_MARK[status]}</span></div>
</div>`;
  }

  function renderOverview() {
    const box = el('overview');
    let solved = 0;
    let attempted = 0;
    let total = 0;
    let flagged = 0;

    for (const category of data.categories) {
      for (const problem of category.problems) {
        total += 1;
        const status = statusOf(problem.id);
        if (status === 'solved') solved += 1;
        else if (status === 'attempted') attempted += 1;
        if (isFlagged(problem.id)) flagged += 1;
      }
    }

    if (total === 0) {
      box.innerHTML = '';
      return;
    }

    const solvedPct = (solved / total) * 100;
    const attemptedPct = (attempted / total) * 100;

    box.innerHTML = `
<div class="overview-head">
  <span><strong>${solved}</strong> <span class="dim">/ ${total} solved</span></span>
  <span class="dim">${Math.round(solvedPct)}%</span>
</div>
<div class="bar">
  <div class="fill" data-width="${solvedPct}"></div>
  <div class="fill attempted" data-width="${attemptedPct}"></div>
</div>
<div class="legend">
  <span><i class="dot solved"></i>${solved} solved</span>
  <span><i class="dot attempted"></i>${attempted} attempted</span>
  <span><i class="dot revisit"></i>${flagged} to revise</span>
  <span><i class="dot unsolved"></i>${total - solved - attempted} untouched</span>
</div>`;
    applyBarWidths(box);
  }

  // ---------------- Events ----------------.

  document.addEventListener('click', (event) => {
    const flag = event.target.closest('[data-act="flag"]');
    if (flag) {
      // Flagging must not also open the problem behind it.
      event.stopPropagation();
      vscode.postMessage({ type: 'toggleRevision', id: flag.dataset.id });
      return;
    }

    const head = event.target.closest('[data-act="toggle-cat"]');
    if (head) {
      const name = head.closest('.category').dataset.cat;
      if (collapsed.has(name)) collapsed.delete(name);
      else collapsed.add(name);
      persist();
      render();
      return;
    }

    const open = event.target.closest('[data-act="open"]');
    if (open) {
      activeId = open.dataset.id;
      persist();
      render();
      vscode.postMessage({ type: 'open', id: activeId });
      return;
    }

    if (event.target.closest('[data-act="fetch"]')) {
      vscode.postMessage({ type: 'fetch' });
      return;
    }

    const judgeTab = event.target.closest('[data-judge]');
    if (judgeTab) {
      // Switching judge replaces the whole dataset; clear per-list state.
      query = '';
      const search = el('search');
      if (search) search.value = '';
      vscode.postMessage({ type: 'selectJudge', judge: judgeTab.dataset.judge });
      return;
    }

    const seg = event.target.closest('[data-view]');
    if (seg) {
      view = seg.dataset.view;
      updateToggles();
      persist();
      render();
      return;
    }

    const pill = event.target.closest('[data-filter]');
    if (pill) {
      filter = pill.dataset.filter;
      updateToggles();
      persist();
      render();
    }
  });

  el('search').addEventListener('input', (event) => {
    query = event.target.value.trim();
    render();
  });

  function updateToggles() {
    for (const button of document.querySelectorAll('[data-view]')) {
      button.setAttribute('aria-pressed', String(button.dataset.view === view));
    }
    for (const button of document.querySelectorAll('[data-filter]')) {
      button.setAttribute('aria-pressed', String(button.dataset.filter === filter));
    }
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'data') {
      data = message.payload;
      render();
    } else if (message.type === 'active') {
      activeId = message.id;
      persist();
      render();
    }
  });

  updateToggles();
  vscode.postMessage({ type: 'ready' });
})();
