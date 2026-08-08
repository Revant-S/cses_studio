// global acquireVsCodeApi.
// Practice contest panel: pick topics, draft a timed set, watch the clock.
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};

  /** Last full state pushed by the host. */
  let state = {
    judge: '',
    judgeName: '',
    phase: 'setup',
    topics: [],
    contest: undefined,
    remainingMs: 0,
    elapsedMs: 0,
    solved: 0,
    total: 0,
    history: [],
    defaults: { count: 4, minutes: 90 },
    limits: { minCount: 1, maxCount: 12, minMinutes: 5, maxMinutes: 600 },
  };

  /** Setup form, kept across repaints and reloads. */
  let form = {
    topics: saved.topics || [],
    count: saved.count || 0,
    minutes: saved.minutes || 0,
    includeSolved: saved.includeSolved === true,
    showHistory: saved.showHistory === true,
  };

  const DURATIONS = [30, 45, 60, 90, 120, 180];
  const REASON_ORDER = ['revision', 'struggled', 'attempted', 'fresh', 'filler'];
  const REASON_SHORT = {
    revision: '★ revise',
    struggled: 'retry',
    attempted: 'stumbled',
    fresh: 'new',
    filler: 'replay',
  };

  const el = (id) => document.getElementById(id);

  function persist() {
    vscode.setState(form);
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function countValue() {
    const limits = state.limits;
    return clamp(form.count || state.defaults.count, limits.minCount, limits.maxCount);
  }

  function minutesValue() {
    const limits = state.limits;
    return clamp(form.minutes || state.defaults.minutes, limits.minMinutes, limits.maxMinutes);
  }

  /** `h:mm:ss`, or `mm:ss` under an hour. */
  function formatClock(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
  }

  function formatMinutes(ms) {
    const minutes = Math.round(ms / 60000);
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
  }

  function formatDate(millis) {
    const date = new Date(millis);
    return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    })}`;
  }

  /** Applies bar widths through the CSSOM. */
  function applyBarWidths(root) {
    for (const fill of (root || document).querySelectorAll('[data-width]')) {
      const percent = Number(fill.dataset.width);
      fill.style.width = `${Number.isFinite(percent) ? clamp(percent, 0, 100) : 0}%`;
    }
  }

  // ---------------- Setup ----------------.

  function selectedTopics() {
    const known = new Set(state.topics.map((topic) => topic.name));
    return form.topics.filter((name) => known.has(name));
  }

  /** Problems the current selection can actually draw on. */
  function eligibleCount() {
    const chosen = selectedTopics();
    const wanted = chosen.length > 0 ? new Set(chosen) : undefined;
    let total = 0;
    for (const topic of state.topics) {
      if (wanted && !wanted.has(topic.name)) continue;
      total += form.includeSolved ? topic.total : topic.eligible;
    }
    return total;
  }

  /** Priority mix across the selection, so the draft is predictable up front. */
  function priorityMix() {
    const chosen = selectedTopics();
    const wanted = chosen.length > 0 ? new Set(chosen) : undefined;
    const mix = { revision: 0, struggled: 0, attempted: 0, fresh: 0, filler: 0 };
    for (const topic of state.topics) {
      if (wanted && !wanted.has(topic.name)) continue;
      for (const reason of REASON_ORDER) {
        mix[reason] += topic.counts[reason] || 0;
      }
    }
    return mix;
  }

  function renderSetup() {
    if (state.topics.length === 0) {
      return `<div class="empty">
  No problems are cached for ${escapeHtml(state.judgeName)} yet.<br>
  Fetch the problem list, then start a contest.
</div>`;
    }

    const chosen = new Set(selectedTopics());
    const eligible = eligibleCount();
    const mix = priorityMix();
    const count = countValue();
    const minutes = minutesValue();
    const drafted = Math.min(count, eligible);

    const topicRows = state.topics
      .map((topic) => {
        const on = chosen.has(topic.name);
        const available = form.includeSolved ? topic.total : topic.eligible;
        const priority = (topic.counts.revision || 0) + (topic.counts.struggled || 0);
        return `<button class="topic${on ? ' on' : ''}" data-topic="${escapeHtml(topic.name)}"
  role="checkbox" aria-checked="${on}"${available === 0 ? ' disabled' : ''}>
  <span class="tick">${on ? '☑' : '☐'}</span>
  <span class="topic-name">${escapeHtml(topic.name)}</span>
  ${priority > 0 ? `<span class="chip hot" title="Marked to revise or retried">${priority}</span>` : ''}
  <span class="topic-count">${available}</span>
</button>`;
      })
      .join('\n');

    const mixChips = REASON_ORDER.filter((reason) => mix[reason] > 0)
      .map(
        (reason) =>
          `<span class="chip ${reason}">${mix[reason]} ${escapeHtml(REASON_SHORT[reason])}</span>`,
      )
      .join('');

    return `<header class="head">
  <h2>New contest</h2>
  <span class="dim">${escapeHtml(state.judgeName)}</span>
</header>

<section class="block">
  <div class="block-head">
    <span class="label">Topics</span>
    <button class="link" data-act="topics-all">${chosen.size > 0 ? 'Clear' : 'Select all'}</button>
  </div>
  <div class="topics" role="group">${topicRows}</div>
  <p class="hint">${chosen.size === 0 ? 'Nothing selected — every topic is in play.' : `${chosen.size} topic${chosen.size === 1 ? '' : 's'} selected.`}</p>
</section>

<section class="block">
  <div class="block-head"><span class="label">Problems</span></div>
  <div class="stepper">
    <button data-act="count-down" aria-label="Fewer problems">−</button>
    <span class="stepper-value">${count}</span>
    <button data-act="count-up" aria-label="More problems">+</button>
  </div>
</section>

<section class="block">
  <div class="block-head"><span class="label">Duration</span></div>
  <div class="pills">
    ${DURATIONS.map(
      (value) =>
        `<button class="pill${value === minutes ? ' on' : ''}" data-minutes="${value}"
  aria-pressed="${value === minutes}">${value < 60 ? `${value}m` : `${value / 60}h`}</button>`,
    ).join('\n    ')}
  </div>
</section>

<section class="block">
  <button class="check${form.includeSolved ? ' on' : ''}" data-act="include-solved"
    role="checkbox" aria-checked="${form.includeSolved}">
    <span class="tick">${form.includeSolved ? '☑' : '☐'}</span>
    <span>Include problems already solved</span>
  </button>
</section>

<section class="block preview">
  <div class="preview-head">
    <strong>${drafted}</strong> problem${drafted === 1 ? '' : 's'} from
    <strong>${eligible}</strong> eligible
  </div>
  <div class="mix">${mixChips || '<span class="dim">Nothing eligible in this selection.</span>'}</div>
  <p class="hint">
    Drafted hardest-first: problems you marked to revise, then ones you needed
    several tries on, then the rest at random.
  </p>
</section>

<button class="btn-primary" data-act="start"${eligible === 0 ? ' disabled' : ''}>
  Start ${minutes < 60 ? `${minutes}-minute` : `${minutes / 60}-hour`} contest
</button>

${renderHistory()}`;
  }

  // ---------------- Live ----------------.

  function renderProblemRow(problem, running) {
    const solved = problem.solvedAt !== undefined;
    const opened = problem.openedAt !== undefined;
    const took = solved ? formatClock(problem.solvedAt - state.contest.startedAt) : '';

    return `<button class="prob${solved ? ' solved' : ''}${opened && !solved ? ' opened' : ''}"
  data-open="${escapeHtml(problem.id)}"${running ? '' : ' disabled'}>
  <span class="prob-label">${escapeHtml(problem.label)}</span>
  <span class="prob-body">
    <span class="prob-title">${escapeHtml(problem.title)}</span>
    <span class="prob-meta">
      <span class="chip ${problem.reason}">${escapeHtml(problem.reasonLabel)}</span>
      ${problem.priorAttempts > 0 ? `<span class="dim">${problem.priorAttempts} past fail${problem.priorAttempts === 1 ? '' : 's'}</span>` : ''}
      <span class="dim">${escapeHtml(problem.category)}</span>
    </span>
  </span>
  <span class="prob-state">${solved ? `<span class="ok">✓</span><span class="took">${took}</span>` : '·'}</span>
</button>`;
  }

  function renderLive() {
    const contest = state.contest;
    const percent = contest.durationMs > 0 ? (state.elapsedMs / contest.durationMs) * 100 : 0;
    const low = state.remainingMs <= 300000;

    return `<header class="head">
  <h2>Contest</h2>
  <span class="dim">${state.solved}/${state.total} solved</span>
</header>

<section class="clock${low ? ' low' : ''}">
  <div class="clock-time" id="clock">${formatClock(state.remainingMs)}</div>
  <div class="clock-sub">left of ${formatMinutes(contest.durationMs)}</div>
  <div class="bar"><div class="fill" id="clock-fill" data-width="${percent}"></div></div>
</section>

<div class="probs">${contest.problems.map((p) => renderProblemRow(p, true)).join('\n')}</div>

<div class="actions">
  <button class="btn-ghost" data-act="end">Give up &amp; see results</button>
</div>

<p class="hint">
  Solves are picked up automatically — submit from the statement or the test
  panel and the board updates itself.
</p>`;
  }

  // ---------------- Recap ----------------.

  function renderRecap() {
    const contest = state.contest;
    const outcomes = {
      finished: 'Solved everything',
      timeout: "Time's up",
      abandoned: 'Ended early',
    };
    const percent = state.total > 0 ? (state.solved / state.total) * 100 : 0;

    return `<header class="head">
  <h2>Results</h2>
  <span class="dim">${escapeHtml(outcomes[contest.endReason] || 'Ended')}</span>
</header>

<section class="score">
  <div class="score-value">${state.solved}<span class="dim">/${state.total}</span></div>
  <div class="score-sub">in ${formatClock(state.elapsedMs)} of ${formatMinutes(contest.durationMs)}</div>
  <div class="bar"><div class="fill" data-width="${percent}"></div></div>
</section>

<div class="probs">${contest.problems.map((p) => renderProblemRow(p, false)).join('\n')}</div>

<div class="actions">
  <button class="btn-primary" data-act="new-contest">New contest</button>
</div>

${renderHistory()}`;
  }

  // ---------------- History ----------------.

  function renderHistory() {
    if (state.history.length === 0) {
      return '';
    }
    const rows = state.history
      .map(
        (entry) => `<div class="hist-row">
  <span class="hist-score">${entry.solved}/${entry.total}</span>
  <span class="hist-body">
    <span>${escapeHtml(entry.topics.length > 0 ? entry.topics.join(', ') : 'All topics')}</span>
    <span class="dim">${formatDate(entry.startedAt)} · ${formatMinutes(entry.durationMs)}</span>
  </span>
</div>`,
      )
      .join('\n');

    return `<section class="block history">
  <div class="block-head">
    <button class="link" data-act="toggle-history">
      ${form.showHistory ? '▾' : '▸'} Past contests (${state.history.length})
    </button>
    ${form.showHistory ? '<button class="link" data-act="clear-history">Clear</button>' : ''}
  </div>
  ${form.showHistory ? `<div class="hist">${rows}</div>` : ''}
</section>`;
  }

  // ---------------- Shell ----------------.

  function render() {
    const root = el('root');
    if (state.phase === 'live') {
      root.className = 'live';
      root.innerHTML = renderLive();
    } else if (state.phase === 'recap') {
      root.className = 'recap';
      root.innerHTML = renderRecap();
    } else {
      root.className = 'setup';
      root.innerHTML = renderSetup();
    }
    applyBarWidths(root);
  }

  // ---------------- Events ----------------.

  document.addEventListener('click', (event) => {
    const topic = event.target.closest('[data-topic]');
    if (topic) {
      const name = topic.dataset.topic;
      const chosen = new Set(selectedTopics());
      if (chosen.has(name)) chosen.delete(name);
      else chosen.add(name);
      form.topics = [...chosen];
      persist();
      render();
      return;
    }

    const minutes = event.target.closest('[data-minutes]');
    if (minutes) {
      form.minutes = Number(minutes.dataset.minutes);
      persist();
      render();
      return;
    }

    const open = event.target.closest('[data-open]');
    if (open) {
      vscode.postMessage({ type: 'open', id: open.dataset.open });
      return;
    }

    const action = event.target.closest('[data-act]');
    if (!action) return;

    switch (action.dataset.act) {
      case 'topics-all':
        form.topics = selectedTopics().length > 0 ? [] : state.topics.map((topic) => topic.name);
        persist();
        render();
        break;
      case 'count-up':
        form.count = clamp(countValue() + 1, state.limits.minCount, state.limits.maxCount);
        persist();
        render();
        break;
      case 'count-down':
        form.count = clamp(countValue() - 1, state.limits.minCount, state.limits.maxCount);
        persist();
        render();
        break;
      case 'include-solved':
        form.includeSolved = !form.includeSolved;
        persist();
        render();
        break;
      case 'toggle-history':
        form.showHistory = !form.showHistory;
        persist();
        render();
        break;
      case 'clear-history':
        vscode.postMessage({ type: 'clearHistory' });
        break;
      case 'start':
        vscode.postMessage({
          type: 'start',
          topics: selectedTopics(),
          count: countValue(),
          minutes: minutesValue(),
          includeSolved: form.includeSolved,
        });
        break;
      case 'end':
        vscode.postMessage({ type: 'end' });
        break;
      case 'new-contest':
        vscode.postMessage({ type: 'newContest' });
        break;
      default:
        break;
    }
  });

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'state') {
      state = message.payload;
      render();
      return;
    }
    if (message.type === 'tick') {
      state.remainingMs = message.remainingMs;
      state.elapsedMs = message.elapsedMs;
      const clock = el('clock');
      if (clock) clock.textContent = formatClock(message.remainingMs);
      const fill = el('clock-fill');
      if (fill && state.contest && state.contest.durationMs > 0) {
        fill.style.width = `${clamp((message.elapsedMs / state.contest.durationMs) * 100, 0, 100)}%`;
      }
      const clockBox = document.querySelector('.clock');
      if (clockBox) clockBox.classList.toggle('low', message.remainingMs <= 300000);
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
