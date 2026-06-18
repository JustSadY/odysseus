/**
 * subagent/widget.js
 * Mission Control: break tasks into parallel subagents, watch them run live.
 *
 * Features:
 *  - Full-page app view with task input + live agent grid + streamed result
 *  - /parallel <task> command in main chat auto-routes here
 *  - Job history sidebar
 */
(function () {
  const pkg = window.OdysseusPkg;
  if (!pkg?.registerAppView) {
    console.warn('[subagent] OdysseusPkg.registerAppView not available');
    return;
  }

  const API = '/pkgs/subagent';
  let _mounted = false;
  let _currentStream = null;   // AbortController
  let _jobs = [];
  let _activeJob = null;       // current job object (live)
  let _view = 'input';         // 'input' | 'running' | 'done' | 'history'

  // ── CSS ─────────────────────────────────────────────────────────────────────

  const CSS = `
  #sa-root {
    display: flex; height: 100%; width: 100%; background: #0d0d1a;
    font-family: system-ui, sans-serif; color: #e2e8f0; overflow: hidden;
  }

  /* sidebar */
  #sa-sidebar {
    width: 220px; flex-shrink: 0; background: #10101e; border-right: 1px solid #1e1e35;
    display: flex; flex-direction: column; overflow: hidden;
  }
  #sa-sidebar-hdr {
    padding: 14px 14px 8px; font-size: 11px; font-weight: 700;
    text-transform: uppercase; letter-spacing: 1px; color: #4b5563;
  }
  #sa-sidebar-list { flex: 1; overflow-y: auto; padding: 0 6px 8px; }
  .sa-job-item {
    padding: 7px 10px; border-radius: 7px; cursor: pointer; margin-bottom: 3px;
    border: 1px solid transparent; transition: background 0.12s;
  }
  .sa-job-item:hover { background: #1a1a2e; }
  .sa-job-item.active { background: #1e1e35; border-color: #3b3b5a; }
  .sa-job-title { font-size: 12px; color: #cbd5e1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sa-job-meta  { font-size: 10px; color: #4b5563; margin-top: 2px; }
  .sa-new-btn {
    margin: 8px; padding: 8px; background: #1e1e35; color: #818cf8;
    border: 1px solid #3b3b5a; border-radius: 8px; cursor: pointer; font-size: 13px;
    text-align: center; transition: background 0.12s;
  }
  .sa-new-btn:hover { background: #252545; }

  /* main area */
  #sa-main { flex: 1; display: flex; flex-direction: column; min-width: 0; overflow: hidden; }

  /* ── input view ── */
  #sa-input-view {
    flex: 1; display: flex; flex-direction: column; align-items: center;
    justify-content: center; padding: 40px 60px; gap: 24px;
  }
  #sa-input-title { font-size: 22px; font-weight: 700; color: #f1f5f9; }
  #sa-input-sub   { font-size: 14px; color: #64748b; text-align: center; max-width: 500px; line-height: 1.6; }
  #sa-task-input  {
    width: 100%; max-width: 700px; min-height: 120px; resize: vertical;
    background: #13131f; border: 1px solid #2d2d4a; border-radius: 10px;
    color: #e2e8f0; font-size: 15px; padding: 14px 16px; outline: none;
    font-family: inherit; line-height: 1.6;
  }
  #sa-task-input:focus { border-color: #4f46e5; }
  #sa-task-input::placeholder { color: #4b5563; }
  .sa-btn-row { display: flex; gap: 10px; width: 100%; max-width: 700px; justify-content: flex-end; }
  .sa-btn {
    padding: 9px 22px; border: none; border-radius: 8px;
    cursor: pointer; font-size: 14px; font-weight: 500; transition: opacity 0.15s;
  }
  .sa-btn:hover { opacity: 0.85; }
  .sa-btn-primary { background: #4f46e5; color: #fff; }
  .sa-btn-secondary { background: #1e1e35; color: #94a3b8; border: 1px solid #2d2d4a; }
  #sa-auto-toggle {
    display: flex; align-items: center; gap: 8px; width: 100%; max-width: 700px;
    font-size: 12px; color: #64748b; cursor: pointer;
  }
  #sa-auto-toggle input { cursor: pointer; accent-color: #4f46e5; }

  /* ── running view ── */
  #sa-running-view { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
  #sa-run-header {
    padding: 14px 20px; border-bottom: 1px solid #1e1e35;
    display: flex; align-items: center; gap: 12px; flex-shrink: 0;
  }
  #sa-run-task { font-size: 14px; color: #94a3b8; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sa-phase-badge {
    padding: 3px 10px; border-radius: 12px; font-size: 11px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.5px;
  }
  .phase-planning    { background: #1e293b; color: #60a5fa; }
  .phase-running     { background: #1e1e00; color: #facc15; }
  .phase-synthesizing{ background: #1a1035; color: #a78bfa; }
  .phase-done        { background: #052e16; color: #4ade80; }
  .phase-error       { background: #2d0000; color: #f87171; }

  #sa-agents-grid {
    display: flex; gap: 12px; padding: 16px 20px; flex-wrap: wrap; flex-shrink: 0;
    border-bottom: 1px solid #1e1e35; min-height: 160px; align-content: flex-start;
  }
  .sa-agent-card {
    background: #12121f; border: 1px solid #1e1e35; border-radius: 10px;
    padding: 12px 14px; width: 240px; min-height: 120px;
    display: flex; flex-direction: column; gap: 8px; transition: border-color 0.2s;
  }
  .sa-agent-card.running { border-color: #ca8a04; }
  .sa-agent-card.done    { border-color: #16a34a; }
  .sa-agent-card.error   { border-color: #dc2626; }
  .sa-card-title { font-size: 12px; font-weight: 600; color: #cbd5e1; }
  .sa-card-status {
    font-size: 10px; display: flex; align-items: center; gap: 5px; color: #6b7280;
  }
  .sa-card-output {
    font-size: 11px; color: #94a3b8; flex: 1; overflow: hidden;
    display: -webkit-box; -webkit-line-clamp: 5; -webkit-box-orient: vertical;
    line-height: 1.5; white-space: pre-wrap; word-break: break-word;
  }
  .sa-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
  .dot-pending  { background: #374151; }
  .dot-running  { background: #ca8a04; animation: sa-blink 1s infinite; }
  .dot-done     { background: #16a34a; }
  .dot-error    { background: #dc2626; }
  @keyframes sa-blink { 0%,100% { opacity:1; } 50% { opacity:0.3; } }

  /* ── result panel ── */
  #sa-result-panel {
    flex: 1; overflow-y: auto; padding: 20px 24px; min-height: 0;
  }
  #sa-result-label {
    font-size: 11px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 1px; color: #4b5563; margin-bottom: 12px;
  }
  #sa-result-body {
    font-size: 14px; color: #cbd5e1; line-height: 1.75;
    white-space: pre-wrap; word-break: break-word;
  }
  #sa-result-body h1,#sa-result-body h2,#sa-result-body h3 {
    color: #f1f5f9; margin-top: 1em; margin-bottom: 0.4em;
  }

  /* ── spinner ── */
  .sa-spinner {
    width: 12px; height: 12px; border: 2px solid #333;
    border-top-color: #4f46e5; border-radius: 50%;
    animation: sa-spin 0.8s linear infinite; flex-shrink: 0;
  }
  @keyframes sa-spin { to { transform: rotate(360deg); } }

  /* scrollbar */
  #sa-result-panel::-webkit-scrollbar,
  #sa-sidebar-list::-webkit-scrollbar { width: 5px; }
  #sa-result-panel::-webkit-scrollbar-thumb,
  #sa-sidebar-list::-webkit-scrollbar-thumb { background: #2d2d4a; border-radius: 3px; }
  `;

  // ── DOM helpers ──────────────────────────────────────────────────────────────

  function _css() {
    if (document.getElementById('sa-styles')) return;
    const s = document.createElement('style');
    s.id = 'sa-styles';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function _el(id) { return document.getElementById(id); }
  function _txt(id, v) { const e = _el(id); if (e) e.textContent = v; }

  // ── render shell ─────────────────────────────────────────────────────────────

  function _renderShell(container) {
    container.innerHTML = `
      <div id="sa-root">
        <div id="sa-sidebar">
          <div class="sa-new-btn" onclick="__sa.newJob()">+ New Task</div>
          <div id="sa-sidebar-hdr">History</div>
          <div id="sa-sidebar-list"></div>
        </div>
        <div id="sa-main">
          ${_htmlInputView()}
          <div id="sa-running-view" style="display:none"></div>
        </div>
      </div>`;
  }

  function _htmlInputView() {
    return `
      <div id="sa-input-view">
        <div id="sa-input-title">⚡ Subagent Orchestrator</div>
        <div id="sa-input-sub">
          Describe a complex task. The orchestrator will break it into<br>
          independent subtasks and run them in parallel simultaneously.
        </div>
        <textarea id="sa-task-input" placeholder="e.g. Research the top 5 AI frameworks for multi-agent systems, compare their strengths, weaknesses, and use cases, then write a decision guide for a startup."></textarea>
        <label id="sa-auto-toggle">
          <input type="checkbox" id="sa-auto-cb" checked>
          Auto-detect and intercept /parallel commands from main chat
        </label>
        <div class="sa-btn-row">
          <button class="sa-btn sa-btn-secondary" onclick="__sa.planOnly()">Preview Plan</button>
          <button class="sa-btn sa-btn-primary" onclick="__sa.run()">▶ Run Parallel</button>
        </div>
      </div>`;
  }

  function _renderRunningView(job) {
    const main = _el('sa-main');
    if (!main) return;
    _el('sa-input-view').style.display = 'none';
    const rv = _el('sa-running-view');
    rv.style.display = 'flex';
    rv.style.flexDirection = 'column';
    rv.style.overflow = 'hidden';
    rv.style.flex = '1';
    rv.innerHTML = `
      <div id="sa-run-header">
        <span class="sa-phase-badge phase-planning" id="sa-phase-badge">Planning</span>
        <span id="sa-run-task">${_esc(job.task.slice(0, 120))}</span>
        <button class="sa-btn sa-btn-secondary" style="padding:4px 12px;font-size:12px"
          onclick="__sa.cancel()">Cancel</button>
      </div>
      <div id="sa-agents-grid"></div>
      <div id="sa-result-panel">
        <div id="sa-result-label">Result</div>
        <div id="sa-result-body" style="color:#4b5563;font-style:italic;">
          Waiting for agents to complete…
        </div>
      </div>`;
  }

  // ── sidebar ──────────────────────────────────────────────────────────────────

  function _renderSidebar() {
    const list = _el('sa-sidebar-list');
    if (!list) return;
    if (!_jobs.length) {
      list.innerHTML = '<div style="padding:10px 12px;font-size:11px;color:#374151">No jobs yet</div>';
      return;
    }
    list.innerHTML = _jobs.map(j => `
      <div class="sa-job-item${_activeJob && _activeJob.id === j.id ? ' active' : ''}"
           onclick="__sa.loadJob('${j.id}')">
        <div class="sa-job-title">${_esc(j.task.slice(0, 60))}</div>
        <div class="sa-job-meta">${j.status} · ${j.agent_count || 0} agents</div>
      </div>`).join('');
  }

  // ── agent cards ──────────────────────────────────────────────────────────────

  function _ensureCard(id, title) {
    const grid = _el('sa-agents-grid');
    if (!grid) return;
    let card = document.getElementById(`sa-card-${id}`);
    if (!card) {
      card = document.createElement('div');
      card.id = `sa-card-${id}`;
      card.className = 'sa-agent-card pending';
      card.innerHTML = `
        <div class="sa-card-title">${_esc(title || `Agent ${id}`)}</div>
        <div class="sa-card-status">
          <span class="sa-dot dot-pending" id="sa-dot-${id}"></span>
          <span id="sa-st-${id}">Pending</span>
        </div>
        <div class="sa-card-output" id="sa-out-${id}"></div>`;
      grid.appendChild(card);
    }
    return card;
  }

  function _updateCard(id, status, delta) {
    const card = document.getElementById(`sa-card-${id}`);
    const dot  = _el(`sa-dot-${id}`);
    const st   = _el(`sa-st-${id}`);
    const out  = _el(`sa-out-${id}`);

    if (card) {
      card.className = `sa-agent-card ${status}`;
    }
    if (dot) {
      dot.className = `sa-dot dot-${status}`;
    }
    if (st) {
      const labels = { pending: 'Pending', running: 'Running…', done: 'Done ✓', error: 'Error ✕' };
      st.textContent = labels[status] || status;
    }
    if (out && delta) {
      out.textContent = (out.textContent || '') + delta;
    }
  }

  function _setPhaseBadge(phase) {
    const el = _el('sa-phase-badge');
    if (!el) return;
    const cls = {
      planning: 'phase-planning', running: 'phase-running',
      synthesizing: 'phase-synthesizing', done: 'phase-done', error: 'phase-error',
    };
    el.className = `sa-phase-badge ${cls[phase] || ''}`;
    const labels = {
      planning: 'Planning', running: 'Running', synthesizing: 'Synthesizing',
      done: 'Done', error: 'Error',
    };
    el.textContent = labels[phase] || phase;
  }

  // ── API helpers ──────────────────────────────────────────────────────────────

  async function _api(method, path, body) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const r = await fetch(API + path, opts);
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      throw new Error(e.detail || r.statusText);
    }
    return r.json();
  }

  async function _loadHistory() {
    try {
      _jobs = await _api('GET', '/jobs');
      _renderSidebar();
    } catch (e) {
      console.error('[subagent] history error', e);
    }
  }

  // ── run orchestration ────────────────────────────────────────────────────────

  async function _run(task) {
    if (!task.trim()) return;
    if (_currentStream) _currentStream.abort();
    _currentStream = new AbortController();

    _activeJob = { id: null, task, status: 'planning', subtasks: [], agents: {} };
    _renderRunningView(_activeJob);

    const resp = await fetch(API + '/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task }),
      signal: _currentStream.signal,
    });

    if (!resp.ok) {
      _setPhaseBadge('error');
      _txt('sa-result-body', 'Error: ' + resp.statusText);
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let resultText = '';

    while (true) {
      let done, value;
      try {
        ({ done, value } = await reader.read());
      } catch (e) {
        break;
      }
      if (done) break;

      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        let ev;
        try { ev = JSON.parse(line.slice(6)); } catch { continue; }

        switch (ev.type) {
          case 'job_created':
            _activeJob.id = ev.job_id;
            break;

          case 'status':
            _activeJob.status = ev.status;
            _setPhaseBadge(ev.status);
            break;

          case 'plan':
            for (const st of (ev.subtasks || [])) {
              _ensureCard(st.id, st.title);
            }
            break;

          case 'agent_start':
            _ensureCard(ev.id, ev.title);
            _updateCard(ev.id, 'running', null);
            break;

          case 'delta':
            _updateCard(ev.id, 'running', ev.delta);
            break;

          case 'subtask_done':
            _updateCard(ev.id, 'done', null);
            break;

          case 'subtask_error':
            _updateCard(ev.id, 'error', ev.error || 'Error');
            break;

          case 'result_delta':
            resultText += ev.delta;
            const rb = _el('sa-result-body');
            if (rb) {
              if (rb.style.fontStyle === 'italic') rb.style.fontStyle = '';
              rb.textContent = resultText;
            }
            break;

          case 'done':
            _activeJob.status = 'done';
            _setPhaseBadge('done');
            _loadHistory();
            break;

          case 'error':
            _setPhaseBadge('error');
            const reb = _el('sa-result-body');
            if (reb) reb.textContent = 'Error: ' + ev.error;
            break;
        }
      }
    }
  }

  // ── plan preview ─────────────────────────────────────────────────────────────

  async function _planOnly() {
    const ta = _el('sa-task-input');
    if (!ta || !ta.value.trim()) return;
    const task = ta.value.trim();

    const btn = document.querySelector('.sa-btn-secondary');
    if (btn) { btn.textContent = 'Planning…'; btn.disabled = true; }

    try {
      const r = await _api('POST', '/plan', { task });
      const subtasks = r.subtasks || [];
      const msg = subtasks.map((st, i) =>
        `${i + 1}. ${st.title}\n   ${st.task.slice(0, 120)}${st.task.length > 120 ? '…' : ''}`
      ).join('\n\n');
      alert(`Plan (${subtasks.length} parallel agents):\n\n${msg}`);
    } catch (e) {
      alert('Error: ' + e.message);
    } finally {
      if (btn) { btn.textContent = 'Preview Plan'; btn.disabled = false; }
    }
  }

  // ── cancel ───────────────────────────────────────────────────────────────────

  function _cancel() {
    if (_currentStream) { _currentStream.abort(); _currentStream = null; }
    _showInput();
  }

  function _showInput() {
    const iv = _el('sa-input-view');
    const rv = _el('sa-running-view');
    if (iv) iv.style.display = 'flex';
    if (rv) { rv.style.display = 'none'; rv.innerHTML = ''; }
    _activeJob = null;
  }

  // ── load historical job ───────────────────────────────────────────────────────

  async function _loadJob(jid) {
    try {
      const j = await _api('GET', `/jobs/${jid}`);
      _activeJob = j;
      _renderRunningView(j);
      _setPhaseBadge(j.status);
      for (const st of (j.subtasks || [])) {
        const agent = j.agents?.[st.id] || {};
        const card = _ensureCard(st.id, st.title);
        if (card) {
          _updateCard(st.id, agent.status || 'pending', null);
          const out = _el(`sa-out-${st.id}`);
          if (out) out.textContent = (agent.output || '').slice(0, 400);
        }
      }
      const rb = _el('sa-result-body');
      if (rb && j.result) {
        rb.style.fontStyle = '';
        rb.textContent = j.result;
      }
      _renderSidebar();
    } catch (e) {
      console.error('[subagent] loadJob error', e);
    }
  }

  // ── chat command hook ────────────────────────────────────────────────────────

  let _chatHookInstalled = false;

  function _installChatHook() {
    if (_chatHookInstalled) return;
    _chatHookInstalled = true;

    // Watch for the chat submit button
    const observer = new MutationObserver(() => {
      const form = document.querySelector('form[data-testid="chat-form"], #chat-form, form.chat-input-form');
      if (!form || form._saHooked) return;
      form._saHooked = true;

      form.addEventListener('submit', async (e) => {
        const cb = _el('sa-auto-cb');
        if (!cb || !cb.checked) return;

        const ta = form.querySelector('textarea');
        const msg = ta?.value?.trim() || '';
        if (!msg.startsWith('/parallel ') && !msg.startsWith('/pa ')) return;

        e.preventDefault();
        e.stopImmediatePropagation();

        const task = msg.replace(/^\/(parallel|pa)\s+/, '');
        ta.value = '';

        // Switch to subagent view and run
        const closeBtn = document.querySelector('[data-pkg-close="subagent"], #pkg-app-close');
        // Open subagent view
        pkg?.registerAppView && _openView();
        await new Promise(r => setTimeout(r, 200));
        _run(task);
      }, true);
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  function _openView() {
    // Trigger the sidebar button for this package if it exists
    const btn = document.querySelector('[data-pkg-id="subagent"]');
    if (btn) btn.click();
  }

  // ── escape ───────────────────────────────────────────────────────────────────

  function _esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── mount / unmount ───────────────────────────────────────────────────────────

  function _mount(container) {
    _mounted = true;
    _css();
    _renderShell(container);

    // Expose actions for onclick handlers
    window.__sa = {
      run:      () => { const ta = _el('sa-task-input'); if (ta) _run(ta.value); },
      planOnly: _planOnly,
      cancel:   _cancel,
      newJob:   () => { _showInput(); },
      loadJob:  _loadJob,
    };

    _installChatHook();
    _loadHistory();
  }

  function _unmount() {
    _mounted = false;
    if (_currentStream) { _currentStream.abort(); _currentStream = null; }
    delete window.__sa;
  }

  // ── register ──────────────────────────────────────────────────────────────────

  pkg.registerAppView('subagent', {
    icon:      '⚡',
    label:     'Subagent',
    onMount:   _mount,
    onUnmount: _unmount,
  });
})();
