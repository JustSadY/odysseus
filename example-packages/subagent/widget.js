/**
 * subagent/widget.js
 * Registers /parallel and /pa slash commands in the main chat.
 * Tasks are broken into parallel subagents and results stream
 * directly into the conversation as a native AI bubble.
 */
(function () {
  const pkg = window.OdysseusPkg;
  if (!pkg?.registerSlashCommand) {
    // pkg-api may not have loaded yet — retry after a tick
    setTimeout(() => {
      if (window.OdysseusPkg?.registerSlashCommand) init();
      else console.warn('[subagent] registerSlashCommand not available');
    }, 500);
    return;
  }
  init();

  function init() {
    _injectCSS();
    pkg.registerSlashCommand('parallel', _handleCmd);
    pkg.registerSlashCommand('pa',       _handleCmd);
  }

  const API = '/pkgs/subagent';

  // ── CSS (scoped, injected once) ────────────────────────────────────────────

  const CSS = `
  .sa-bubble {
    border: 1px solid #232338; border-radius: 12px; overflow: hidden; margin-top: 6px;
  }
  .sa-hdr {
    display:flex; align-items:center; gap:10px; padding:10px 14px 9px;
    background:#12121e; border-bottom:1px solid #1c1c30; font-size:13px;
  }
  .sa-hdr-title { font-weight:600; color:#c4c4e0; flex:1; }
  .sa-phase {
    font-size:10px; font-weight:700; letter-spacing:.6px;
    text-transform:uppercase; padding:2px 9px; border-radius:10px;
  }
  .sa-phase-planning    { background:#1e293b; color:#60a5fa; }
  .sa-phase-running     { background:#1c1700; color:#facc15; }
  .sa-phase-synthesizing{ background:#180f30; color:#a78bfa; }
  .sa-phase-done        { background:#052e16; color:#4ade80; }
  .sa-phase-error       { background:#2d0000; color:#f87171; }

  .sa-grid {
    display:flex; gap:10px; padding:12px 14px; flex-wrap:wrap;
    background:#0e0e1a; border-bottom:1px solid #1c1c30;
  }
  .sa-card {
    background:#13131f; border:1px solid #1e1e35; border-radius:9px;
    padding:10px 12px; min-width:180px; max-width:240px; flex:1;
    display:flex; flex-direction:column; gap:6px; transition:border-color .2s;
  }
  .sa-card.running { border-color:#ca8a04; }
  .sa-card.done    { border-color:#16a34a; }
  .sa-card.error   { border-color:#dc2626; }
  .sa-card-title  { font-size:12px; font-weight:600; color:#c4c4e0; }
  .sa-card-status { display:flex; align-items:center; gap:5px; font-size:10px; color:#6b7280; }
  .sa-dot { width:7px; height:7px; border-radius:50%; flex-shrink:0; }
  .sa-dot-pending { background:#374151; }
  .sa-dot-running { background:#ca8a04; animation:sa-blink 1s infinite; }
  .sa-dot-done    { background:#16a34a; }
  .sa-dot-error   { background:#dc2626; }
  @keyframes sa-blink { 0%,100%{opacity:1} 50%{opacity:.3} }
  .sa-card-out {
    font-size:11px; color:#94a3b8; line-height:1.5; max-height:80px; overflow:hidden;
    display:-webkit-box; -webkit-line-clamp:5; -webkit-box-orient:vertical;
    white-space:pre-wrap; word-break:break-word;
  }

  .sa-result { padding:12px 14px; background:#0e0e1a; font-size:14px; color:#cbd5e1; line-height:1.75; white-space:pre-wrap; word-break:break-word; }
  .sa-result-label { font-size:10px; font-weight:700; letter-spacing:.8px; text-transform:uppercase; color:#4b5563; margin-bottom:8px; }
  .sa-result-placeholder { color:#4b5563; font-style:italic; }

  .sa-spin {
    width:11px; height:11px; border:2px solid #333; border-top-color:#4f46e5;
    border-radius:50%; animation:sa-rotate .8s linear infinite; flex-shrink:0;
  }
  @keyframes sa-rotate { to { transform:rotate(360deg); } }
  `;

  function _injectCSS() {
    if (document.getElementById('sa-styles')) return;
    const s = document.createElement('style');
    s.id = 'sa-styles'; s.textContent = CSS;
    document.head.appendChild(s);
  }

  // ── command handler ────────────────────────────────────────────────────────

  async function _handleCmd(args /*, ctx — unused */) {
    const task = args.join(' ').trim();
    if (!task) {
      _chatReply('<b>Usage:</b> /parallel &lt;task description&gt;<br>Runs the task with multiple parallel subagents simultaneously.');
      return;
    }
    const bubble = _addOrchestratorBubble(task);
    if (bubble) await _runInBubble(task, bubble);
  }

  // ── bubble builders ────────────────────────────────────────────────────────

  let _uidN = 0;
  function _uid() { return String(++_uidN); }

  /** Inject a plain HTML reply (like slashReply does). */
  function _chatReply(html) {
    const box = document.getElementById('chat-history');
    if (!box) return;
    const wrap = document.createElement('div');
    wrap.className = 'msg msg-ai';
    const r = document.createElement('div'); r.className = 'role'; r.textContent = '⚡ Subagent';
    const b = document.createElement('div'); b.className = 'body'; b.innerHTML = html;
    wrap.appendChild(r); wrap.appendChild(b); box.appendChild(wrap);
    wrap.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }

  function _addOrchestratorBubble(task) {
    const box = document.getElementById('chat-history');
    if (!box) return null;

    const uid = _uid();
    const wrap = document.createElement('div');
    wrap.className = 'msg msg-ai';
    wrap._saUid = uid;

    const r = document.createElement('div');
    r.className = 'role';
    r.textContent = '⚡ Subagent Orchestrator';

    const b = document.createElement('div');
    b.className = 'body';
    b.innerHTML = `
      <div class="sa-bubble">
        <div class="sa-hdr">
          <span class="sa-hdr-title">${_esc(task.slice(0, 120))}${task.length > 120 ? '…' : ''}</span>
          <span class="sa-phase sa-phase-planning" id="sa-ph-${uid}">Planning…</span>
          <span class="sa-spin" id="sa-sp-${uid}"></span>
        </div>
        <div class="sa-grid" id="sa-gr-${uid}"></div>
        <div class="sa-result" id="sa-rs-${uid}">
          <div class="sa-result-label">Result</div>
          <div class="sa-result-placeholder" id="sa-rt-${uid}">Waiting for agents…</div>
        </div>
      </div>`;

    wrap.appendChild(r);
    wrap.appendChild(b);
    box.appendChild(wrap);
    wrap.scrollIntoView({ behavior: 'smooth', block: 'end' });
    return wrap;
  }

  // ── bubble updates ─────────────────────────────────────────────────────────

  function _phase(uid, phase) {
    const el = document.getElementById(`sa-ph-${uid}`);
    const sp = document.getElementById(`sa-sp-${uid}`);
    if (!el) return;
    const cls = { planning:'sa-phase-planning', running:'sa-phase-running', synthesizing:'sa-phase-synthesizing', done:'sa-phase-done', error:'sa-phase-error' };
    const lbl = { planning:'Planning…', running:'Running', synthesizing:'Synthesizing…', done:'Done ✓', error:'Error' };
    el.className = `sa-phase ${cls[phase] || ''}`;
    el.textContent = lbl[phase] || phase;
    if (sp) sp.style.display = (phase === 'done' || phase === 'error') ? 'none' : '';
  }

  function _ensureCard(uid, id, title) {
    const grid = document.getElementById(`sa-gr-${uid}`);
    if (!grid) return;
    if (document.getElementById(`sa-c-${uid}-${id}`)) return;
    const card = document.createElement('div');
    card.id = `sa-c-${uid}-${id}`; card.className = 'sa-card';
    card.innerHTML = `
      <div class="sa-card-title">${_esc(title || 'Agent ' + id)}</div>
      <div class="sa-card-status">
        <span class="sa-dot sa-dot-pending" id="sa-d-${uid}-${id}"></span>
        <span id="sa-s-${uid}-${id}">Pending</span>
      </div>
      <div class="sa-card-out" id="sa-o-${uid}-${id}"></div>`;
    grid.appendChild(card);
  }

  function _updateCard(uid, id, status, delta) {
    const card = document.getElementById(`sa-c-${uid}-${id}`);
    const dot  = document.getElementById(`sa-d-${uid}-${id}`);
    const st   = document.getElementById(`sa-s-${uid}-${id}`);
    const out  = document.getElementById(`sa-o-${uid}-${id}`);
    if (card) card.className = `sa-card ${status}`;
    if (dot)  dot.className  = `sa-dot sa-dot-${status}`;
    if (st) { const lbl = { pending:'Pending', running:'Running…', done:'Done ✓', error:'Error ✕' }; st.textContent = lbl[status] || status; }
    if (out && delta) out.textContent = (out.textContent || '') + delta;
  }

  let _resultStarted = {};
  function _appendResult(uid, delta) {
    const el = document.getElementById(`sa-rt-${uid}`);
    if (!el) return;
    if (!_resultStarted[uid]) {
      _resultStarted[uid] = true;
      el.className = '';
      el.textContent = delta;
    } else {
      el.textContent += delta;
    }
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // ── orchestration runner ───────────────────────────────────────────────────

  async function _runInBubble(task, bubble) {
    const uid = bubble._saUid;

    let resp;
    try {
      resp = await fetch(API + '/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task }),
      });
    } catch (e) {
      _phase(uid, 'error');
      _appendResult(uid, 'Network error: ' + e.message);
      return;
    }
    if (!resp.ok) {
      _phase(uid, 'error');
      _appendResult(uid, 'Error: ' + resp.statusText);
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
          case 'status':        _phase(uid, ev.status); break;
          case 'plan':
            for (const st of (ev.subtasks || [])) _ensureCard(uid, st.id, st.title);
            break;
          case 'agent_start':   _ensureCard(uid, ev.id, ev.title); _updateCard(uid, ev.id, 'running', null); break;
          case 'delta':         _updateCard(uid, ev.id, 'running', ev.delta); break;
          case 'subtask_done':  _updateCard(uid, ev.id, 'done', null); break;
          case 'subtask_error': _updateCard(uid, ev.id, 'error', ' ' + (ev.error || '')); break;
          case 'result_delta':  _appendResult(uid, ev.delta); break;
          case 'done':          _phase(uid, 'done'); break;
          case 'error':         _phase(uid, 'error'); _appendResult(uid, 'Error: ' + ev.error); break;
        }
      }
    }

    delete _resultStarted[uid];
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  function _esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
})();
