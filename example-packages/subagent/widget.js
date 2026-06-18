/**
 * subagent/widget.js
 * Intercepts /parallel or /pa commands in the main chat.
 * Runs the task through parallel subagents and streams results
 * directly inside the chat as a native-looking AI bubble.
 *
 * No separate tab — everything happens inline in the existing conversation.
 */
(function () {
  const API = '/pkgs/subagent';

  // ── CSS (scoped, injected once) ────────────────────────────────────────────

  const CSS = `
  /* Orchestrator bubble wrapper — blends with existing .msg.msg-ai */
  .sa-bubble {
    border: 1px solid #232338;
    border-radius: 12px;
    overflow: hidden;
    margin-top: 6px;
  }

  /* header bar */
  .sa-hdr {
    display: flex; align-items: center; gap: 10px;
    padding: 10px 14px 9px;
    background: #12121e;
    border-bottom: 1px solid #1c1c30;
    font-size: 13px;
  }
  .sa-hdr-icon { font-size: 15px; }
  .sa-hdr-title { font-weight: 600; color: #c4c4e0; flex: 1; }
  .sa-phase {
    font-size: 10px; font-weight: 700; letter-spacing: .6px;
    text-transform: uppercase; padding: 2px 9px; border-radius: 10px;
  }
  .sa-phase-planning    { background:#1e293b; color:#60a5fa; }
  .sa-phase-running     { background:#1c1700; color:#facc15; }
  .sa-phase-synthesizing{ background:#180f30; color:#a78bfa; }
  .sa-phase-done        { background:#052e16; color:#4ade80; }
  .sa-phase-error       { background:#2d0000; color:#f87171; }

  /* agent grid */
  .sa-grid {
    display: flex; gap: 10px; padding: 12px 14px;
    flex-wrap: wrap; background: #0e0e1a;
    border-bottom: 1px solid #1c1c30;
  }
  .sa-card {
    background: #13131f; border: 1px solid #1e1e35;
    border-radius: 9px; padding: 10px 12px;
    min-width: 180px; max-width: 240px; flex: 1;
    display: flex; flex-direction: column; gap: 6px;
    transition: border-color .2s;
  }
  .sa-card.running { border-color: #ca8a04; }
  .sa-card.done    { border-color: #16a34a; }
  .sa-card.error   { border-color: #dc2626; }

  .sa-card-title  { font-size: 12px; font-weight: 600; color: #c4c4e0; }
  .sa-card-status {
    display: flex; align-items: center; gap: 5px;
    font-size: 10px; color: #6b7280;
  }
  .sa-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
  .sa-dot-pending  { background: #374151; }
  .sa-dot-running  { background: #ca8a04; animation: sa-blink 1s infinite; }
  .sa-dot-done     { background: #16a34a; }
  .sa-dot-error    { background: #dc2626; }
  @keyframes sa-blink { 0%,100%{opacity:1} 50%{opacity:.3} }

  .sa-card-out {
    font-size: 11px; color: #94a3b8; line-height: 1.5;
    max-height: 80px; overflow: hidden;
    display: -webkit-box; -webkit-line-clamp: 5;
    -webkit-box-orient: vertical;
    white-space: pre-wrap; word-break: break-word;
  }

  /* result section */
  .sa-result {
    padding: 12px 14px; background: #0e0e1a;
    font-size: 14px; color: #cbd5e1; line-height: 1.75;
    white-space: pre-wrap; word-break: break-word;
  }
  .sa-result-label {
    font-size: 10px; font-weight: 700; letter-spacing: .8px;
    text-transform: uppercase; color: #4b5563; margin-bottom: 8px;
  }
  .sa-result-placeholder { color: #4b5563; font-style: italic; }

  /* spinner inline */
  .sa-spin {
    width: 11px; height: 11px; border: 2px solid #333;
    border-top-color: #4f46e5; border-radius: 50%;
    animation: sa-rotate .8s linear infinite; flex-shrink: 0;
  }
  @keyframes sa-rotate { to { transform: rotate(360deg); } }
  `;

  function _injectCSS() {
    if (document.getElementById('sa-styles')) return;
    const s = document.createElement('style');
    s.id = 'sa-styles';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  // ── bubble builders ────────────────────────────────────────────────────────

  /**
   * Inject a user bubble into #chat-history (mirrors the .msg.msg-user pattern).
   */
  function _addUserBubble(task) {
    const box = document.getElementById('chat-history');
    if (!box) return;
    const wrap = document.createElement('div');
    wrap.className = 'msg msg-user';
    const r = document.createElement('div');
    r.className = 'role';
    r.textContent = 'You';
    const b = document.createElement('div');
    b.className = 'body';
    b.textContent = '/parallel ' + task;
    wrap.appendChild(r);
    wrap.appendChild(b);
    box.appendChild(wrap);
    wrap.scrollIntoView({ behavior: 'smooth', block: 'end' });
    return wrap;
  }

  /**
   * Inject a custom AI-style bubble that will host the orchestration UI.
   * Returns the bubble element so we can update it during streaming.
   */
  function _addOrchestratorBubble(task) {
    const box = document.getElementById('chat-history');
    if (!box) return null;

    const wrap = document.createElement('div');
    wrap.className = 'msg msg-ai';

    const role = document.createElement('div');
    role.className = 'role';
    role.textContent = '⚡ Subagent Orchestrator';

    const body = document.createElement('div');
    body.className = 'body';

    body.innerHTML = `
      <div class="sa-bubble">
        <div class="sa-hdr">
          <span class="sa-hdr-title">${_esc(task.slice(0, 120))}${task.length > 120 ? '…' : ''}</span>
          <span class="sa-phase sa-phase-planning" id="sa-phase-${wrap._uid = _uid()}">Planning…</span>
          <span class="sa-spin" id="sa-spin-${wrap._uid}"></span>
        </div>
        <div class="sa-grid" id="sa-grid-${wrap._uid}"></div>
        <div class="sa-result" id="sa-result-${wrap._uid}">
          <div class="sa-result-label">Result</div>
          <div class="sa-result-placeholder" id="sa-rtext-${wrap._uid}">Waiting for agents…</div>
        </div>
      </div>`;

    wrap.appendChild(role);
    wrap.appendChild(body);
    box.appendChild(wrap);
    wrap.scrollIntoView({ behavior: 'smooth', block: 'end' });
    return wrap;
  }

  // ── bubble updates ─────────────────────────────────────────────────────────

  function _phase(uid, phase) {
    const el = document.getElementById(`sa-phase-${uid}`);
    const sp = document.getElementById(`sa-spin-${uid}`);
    if (!el) return;
    const cls = {
      planning: 'sa-phase-planning', running: 'sa-phase-running',
      synthesizing: 'sa-phase-synthesizing', done: 'sa-phase-done', error: 'sa-phase-error',
    };
    const lbl = {
      planning: 'Planning…', running: 'Running', synthesizing: 'Synthesizing…',
      done: 'Done ✓', error: 'Error',
    };
    el.className = `sa-phase ${cls[phase] || ''}`;
    el.textContent = lbl[phase] || phase;
    if (sp) sp.style.display = phase === 'done' || phase === 'error' ? 'none' : '';
  }

  function _ensureCard(uid, id, title) {
    const grid = document.getElementById(`sa-grid-${uid}`);
    if (!grid) return;
    let card = document.getElementById(`sa-c-${uid}-${id}`);
    if (card) return card;
    card = document.createElement('div');
    card.id = `sa-c-${uid}-${id}`;
    card.className = 'sa-card';
    card.innerHTML = `
      <div class="sa-card-title">${_esc(title || 'Agent ' + id)}</div>
      <div class="sa-card-status">
        <span class="sa-dot sa-dot-pending" id="sa-dot-${uid}-${id}"></span>
        <span id="sa-st-${uid}-${id}">Pending</span>
      </div>
      <div class="sa-card-out" id="sa-out-${uid}-${id}"></div>`;
    grid.appendChild(card);
    return card;
  }

  function _updateCard(uid, id, status, delta) {
    const card = document.getElementById(`sa-c-${uid}-${id}`);
    const dot  = document.getElementById(`sa-dot-${uid}-${id}`);
    const st   = document.getElementById(`sa-st-${uid}-${id}`);
    const out  = document.getElementById(`sa-out-${uid}-${id}`);
    if (card) card.className = `sa-card ${status}`;
    if (dot)  dot.className  = `sa-dot sa-dot-${status}`;
    if (st) {
      const labels = { pending:'Pending', running:'Running…', done:'Done ✓', error:'Error ✕' };
      st.textContent = labels[status] || status;
    }
    if (out && delta) out.textContent = (out.textContent || '') + delta;
  }

  function _appendResult(uid, delta, isFirst) {
    const el = document.getElementById(`sa-rtext-${uid}`);
    if (!el) return;
    if (isFirst) {
      el.className = '';           // remove placeholder style
      el.textContent = delta;
    } else {
      el.textContent += delta;
    }
    // keep bubble in view while streaming
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // ── orchestration runner ───────────────────────────────────────────────────

  async function _runInBubble(task, bubble) {
    const uid = bubble._uid;
    let resultStarted = false;
    let ctrl = new AbortController();
    bubble._saAbort = ctrl;

    let resp;
    try {
      resp = await fetch(API + '/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task }),
        signal: ctrl.signal,
      });
    } catch (e) {
      _phase(uid, 'error');
      _appendResult(uid, 'Network error: ' + e.message, true);
      return;
    }

    if (!resp.ok) {
      _phase(uid, 'error');
      _appendResult(uid, 'Error: ' + resp.statusText, true);
      return;
    }

    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '';

    while (true) {
      let done, value;
      try { ({ done, value } = await reader.read()); } catch { break; }
      if (done) break;

      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        let ev;
        try { ev = JSON.parse(line.slice(6)); } catch { continue; }

        switch (ev.type) {
          case 'status':
            _phase(uid, ev.status);
            break;
          case 'plan':
            for (const st of (ev.subtasks || []))
              _ensureCard(uid, st.id, st.title);
            break;
          case 'agent_start':
            _ensureCard(uid, ev.id, ev.title);
            _updateCard(uid, ev.id, 'running', null);
            break;
          case 'delta':
            _updateCard(uid, ev.id, 'running', ev.delta);
            break;
          case 'subtask_done':
            _updateCard(uid, ev.id, 'done', null);
            break;
          case 'subtask_error':
            _updateCard(uid, ev.id, 'error', ' ' + (ev.error || ''));
            break;
          case 'result_delta':
            _appendResult(uid, ev.delta, !resultStarted);
            resultStarted = true;
            break;
          case 'done':
            _phase(uid, 'done');
            break;
          case 'error':
            _phase(uid, 'error');
            _appendResult(uid, 'Error: ' + ev.error, !resultStarted);
            resultStarted = true;
            break;
        }
      }
    }
  }

  // ── chat interception ──────────────────────────────────────────────────────

  let _hooked = false;

  function _hook() {
    if (_hooked) return;

    // Wait for the chat form to appear
    const tryHook = () => {
      const form = document.getElementById('chat-form');
      const textarea = document.getElementById('message');
      if (!form || !textarea) {
        setTimeout(tryHook, 500);
        return;
      }
      _hooked = true;

      // Intercept in CAPTURE phase — runs before chat.js's bubble-phase handler
      form.addEventListener('submit', _interceptSubmit, true);

      // Also intercept Enter key on textarea (some chat builds submit via keydown)
      textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          const msg = textarea.value.trim();
          if (_isParallelCmd(msg)) {
            // The form submit will fire immediately after; let our submit handler deal with it
          }
        }
      }, true);
    };

    tryHook();
  }

  function _isParallelCmd(msg) {
    return msg.startsWith('/parallel ') || msg.startsWith('/pa ');
  }

  function _extractTask(msg) {
    return msg.replace(/^\/(parallel|pa)\s+/, '').trim();
  }

  function _interceptSubmit(e) {
    const textarea = document.getElementById('message');
    if (!textarea) return;
    const msg = textarea.value.trim();
    if (!_isParallelCmd(msg)) return;

    // Stop chat.js from handling this
    e.stopImmediatePropagation();
    e.preventDefault();

    const task = _extractTask(msg);
    if (!task) return;

    // Clear input
    textarea.value = '';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));

    // Hide welcome screen if visible
    const welcome = document.querySelector('.welcome-screen, .welcome-message, #welcome-panel');
    if (welcome) welcome.style.display = 'none';
    const chatContainer = document.getElementById('chat-container');
    if (chatContainer) chatContainer.classList.remove('welcome-active');

    // Add messages
    _injectCSS();
    _addUserBubble(task);
    const bubble = _addOrchestratorBubble(task);
    if (bubble) _runInBubble(task, bubble);
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  let _uidCounter = 0;
  function _uid() { return String(++_uidCounter); }

  function _esc(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ── init ───────────────────────────────────────────────────────────────────

  // Hook as soon as the widget loads
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _hook);
  } else {
    _hook();
  }
})();
