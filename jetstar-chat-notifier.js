// Jetstar chat notifier — paste into the browser DevTools console on the chat page.
// Beeps (and flashes the tab title) when a new message arrives in the chat.
// Panel buttons: Test sound, Copy chat, Pick chat area, Mute, Close.
(() => {
  'use strict';

  if (window.__jqNotify) window.__jqNotify.destroy();

  // Ancestor id/class words that mark an element as part of a chat widget.
  const CHAT_HINT = /chat|webchat|cognigy|message|liveagent|embedded|conversation|transcript|jess/i;
  // Container names used to find the whole conversation for "Copy chat".
  const ROOT_HINT = /webchat|chat-?history|chat-?log|message-?list|messages|transcript|conversation/i;
  const TYPING = /^(.{0,40}\b(is )?typing\b.{0,10}|\.{1,3}|…)$/i;
  const OWN_ECHO_MS = 15000;
  const BATCH_MS = 600;
  const MIN_BEEP_GAP_MS = 1500;

  const state = {
    root: null,
    picked: false,
    muted: false,
    unseen: 0,
    ctx: null,
    draft: '',
    lastSent: '',
    lastSentAt: 0,
    lastBeep: 0,
    pending: [],
    batchTimer: null,
    titleTimer: null,
    origTitle: document.title,
    observers: [],
    hookedDocs: new WeakSet(),
    hookedFrames: new WeakSet(),
    log: [],
    cleanups: [],
  };

  // ---------- sound ----------
  function audio() {
    if (!state.ctx) state.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (state.ctx.state === 'suspended') state.ctx.resume();
    return state.ctx;
  }

  function beep() {
    const ctx = audio();
    const t = ctx.currentTime;
    [[880, 0], [1320, 0.18], [880, 0.36]].forEach(([freq, delay]) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t + delay);
      gain.gain.exponentialRampToValueAtTime(0.5, t + delay + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + delay + 0.16);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t + delay);
      osc.stop(t + delay + 0.2);
    });
  }

  // Browsers only allow sound after a user gesture: any click/key unlocks it.
  function unlock() {
    try { audio(); } catch (e) { /* no audio support */ }
    renderStatus();
  }

  // ---------- notification ----------
  function notify(texts) {
    state.unseen += texts.length;
    texts.forEach((text) => state.log.push({ at: new Date(), text }));
    const now = Date.now();
    if (!state.muted && now - state.lastBeep >= MIN_BEEP_GAP_MS) {
      state.lastBeep = now;
      try { beep(); } catch (e) { console.warn('[jq-notify] beep failed', e); }
    }
    if (document.hidden || !document.hasFocus()) flashTitle();
    console.log('[jq-notify] new message:', texts.join(' | '));
    renderStatus();
  }

  function flashTitle() {
    if (state.titleTimer) return;
    state.origTitle = document.title;
    let on = false;
    state.titleTimer = setInterval(() => {
      on = !on;
      document.title = on ? `🔔 (${state.unseen}) New chat message` : state.origTitle;
    }, 1000);
  }

  function stopFlash() {
    if (!state.titleTimer) return;
    clearInterval(state.titleTimer);
    state.titleTimer = null;
    document.title = state.origTitle;
  }

  // ---------- message detection ----------
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();

  function attr(el, name) {
    const v = el.getAttribute && el.getAttribute(name);
    return typeof v === 'string' ? v : '';
  }

  function inChatArea(node) {
    if (state.root) return state.root.contains(node);
    let el = node.nodeType === 1 ? node : node.parentElement;
    for (let depth = 0; el && depth < 15; depth++) {
      if (CHAT_HINT.test(attr(el, 'id') + ' ' + attr(el, 'class') + ' ' + attr(el, 'aria-label'))) return true;
      el = el.parentElement || (el.getRootNode && el.getRootNode().host) || null;
    }
    // Inside a same-origin iframe: the frame element itself may carry the hint.
    const frame = node.ownerDocument && node.ownerDocument.defaultView && node.ownerDocument.defaultView.frameElement;
    return !!(frame && CHAT_HINT.test(attr(frame, 'id') + ' ' + attr(frame, 'class') + ' ' + attr(frame, 'title')));
  }

  function isIgnored(node) {
    if (panel.contains(node)) return true;
    const el = node.nodeType === 1 ? node : node.parentElement;
    if (!el) return true;
    if (el.closest('input, textarea, [contenteditable="true"], script, style, noscript')) return true;
    return false;
  }

  function isOwnEcho(text) {
    if (!state.lastSent || Date.now() - state.lastSentAt > OWN_ECHO_MS) return false;
    const t = norm(text);
    return t === state.lastSent || (t.length <= state.lastSent.length + 40 && t.includes(state.lastSent));
  }

  function consider(node) {
    if (isIgnored(node) || !inChatArea(node)) return;
    const text = (node.nodeType === 3 ? node.data : node.innerText || node.textContent || '').trim();
    if (text.length < 2 || TYPING.test(text) || isOwnEcho(text)) return;
    if (state.pending.some((p) => p.includes(text) || text.includes(p))) return;
    state.pending.push(text);
    clearTimeout(state.batchTimer);
    state.batchTimer = setTimeout(flushBatch, BATCH_MS);
  }

  function flushBatch() {
    // Keep only outermost texts: a message row and its inner text node arrive together.
    const texts = state.pending.filter((t, i, all) => !all.some((o, j) => j !== i && o.length > t.length && o.includes(t)));
    state.pending = [];
    if (texts.length) notify(texts);
  }

  function onMutations(mutations) {
    for (const m of mutations) {
      if (m.type === 'characterData') { consider(m.target); continue; }
      m.addedNodes.forEach((node) => {
        consider(node);
        if (node.nodeType === 1) hookSubtree(node);
      });
    }
  }

  function observe(target) {
    const obs = new MutationObserver(onMutations);
    obs.observe(target, { childList: true, subtree: true, characterData: true });
    state.observers.push(obs);
  }

  function hookDoc(doc) {
    if (!doc || state.hookedDocs.has(doc) || !doc.documentElement) return;
    state.hookedDocs.add(doc);
    observe(doc.documentElement);
    trackSending(doc);
    hookSubtree(doc.documentElement);
  }

  // Same-origin iframes and open shadow roots are separate trees: observe them too.
  function hookSubtree(el) {
    const all = [el, ...el.querySelectorAll('*')];
    for (const node of all) {
      if (node.shadowRoot && !state.hookedDocs.has(node.shadowRoot)) {
        state.hookedDocs.add(node.shadowRoot);
        observe(node.shadowRoot);
        hookSubtree(node.shadowRoot);
      }
      if (node.tagName === 'IFRAME') hookFrame(node);
    }
  }

  function hookFrame(frame) {
    if (state.hookedFrames.has(frame)) return;
    state.hookedFrames.add(frame);
    const tryHook = () => { try { hookDoc(frame.contentDocument); } catch (e) { /* cross-origin */ } };
    tryHook();
    frame.addEventListener('load', tryHook);
  }

  // Remember what the user typed, so their own message echo does not beep.
  function trackSending(doc) {
    const isField = (el) => el && el.matches && el.matches('input, textarea, [contenteditable="true"]');
    const onInput = (e) => {
      if (isField(e.target)) state.draft = e.target.value !== undefined ? e.target.value : e.target.innerText;
    };
    const markSent = () => {
      if (norm(state.draft)) { state.lastSent = norm(state.draft); state.lastSentAt = Date.now(); }
    };
    const onKey = (e) => {
      unlock();
      if (e.key === 'Enter' && !e.shiftKey && isField(e.target)) markSent();
    };
    const onClick = (e) => {
      unlock();
      if (e.target.closest && e.target.closest('button, [role="button"]') && !panel.contains(e.target)) markSent();
    };
    doc.addEventListener('input', onInput, true);
    doc.addEventListener('keydown', onKey, true);
    doc.addEventListener('pointerdown', onClick, true);
    state.cleanups.push(() => {
      doc.removeEventListener('input', onInput, true);
      doc.removeEventListener('keydown', onKey, true);
      doc.removeEventListener('pointerdown', onClick, true);
    });
  }

  // ---------- copy chat ----------
  function allDocs() {
    const docs = [document];
    document.querySelectorAll('iframe').forEach((f) => {
      try { if (f.contentDocument) docs.push(f.contentDocument); } catch (e) { /* cross-origin */ }
    });
    return docs;
  }

  function findChatRoot() {
    if (state.root && state.root.isConnected) return state.root;
    let best = null;
    let bestLen = 0;
    for (const doc of allDocs()) {
      doc.querySelectorAll('[id], [class]').forEach((el) => {
        if (panel.contains(el) || el === doc.body || el === doc.documentElement) return;
        if (!ROOT_HINT.test(attr(el, 'id') + ' ' + attr(el, 'class'))) return;
        const len = (el.innerText || '').trim().length;
        if (len > bestLen) { best = el; bestLen = len; }
      });
    }
    return best;
  }

  function buildTranscript() {
    const root = findChatRoot();
    const lines = [
      'Jetstar chat transcript',
      `Copied: ${new Date().toString()}`,
      `Page: ${location.href}`,
      '',
      '===== Chat window text =====',
      root ? (root.innerText || '').trim() : '(chat area not found — use "Pick chat area", then copy again)',
    ];
    if (state.log.length) {
      lines.push('', '===== New messages seen by the notifier (with arrival time) =====');
      state.log.forEach(({ at, text }) => lines.push(`[${at.toLocaleTimeString()}] ${text}`));
    }
    return lines.join('\n');
  }

  async function copyChat() {
    const text = buildTranscript();
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch (e) { /* fallback below */ }
    if (!ok) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove();
    }
    if (ok) {
      flash(`Copied ${text.split('\n').length} lines`);
    } else {
      showManualCopy(text);
    }
  }

  function showManualCopy(text) {
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;inset:10%;z-index:2147483647;background:#fff;border:2px solid #ff5115;' +
      'border-radius:8px;padding:12px;display:flex;flex-direction:column;gap:8px;font:14px sans-serif;color:#000';
    box.innerHTML = '<b>Copy failed automatically. Press Cmd+C / Ctrl+C now, then Close.</b>';
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'flex:1;font:12px monospace';
    const close = document.createElement('button');
    close.textContent = 'Close';
    close.onclick = () => box.remove();
    box.append(ta, close);
    document.body.appendChild(box);
    ta.focus();
    ta.select();
  }

  // ---------- pick chat area ----------
  function startPick() {
    flash('Click on the chat messages area (Esc = cancel)');
    let hovered = null;
    const over = (e) => {
      if (panel.contains(e.target)) return;
      if (hovered) hovered.style.outline = hovered.__jqOutline || '';
      hovered = e.target;
      hovered.__jqOutline = hovered.style.outline;
      hovered.style.outline = '3px solid #ff5115';
    };
    const stop = () => {
      if (hovered) hovered.style.outline = hovered.__jqOutline || '';
      document.removeEventListener('mouseover', over, true);
      document.removeEventListener('click', click, true);
      document.removeEventListener('keydown', key, true);
    };
    const click = (e) => {
      if (panel.contains(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      stop();
      state.root = e.target;
      state.picked = true;
      flash('Chat area set');
      renderStatus();
    };
    const key = (e) => { if (e.key === 'Escape') { stop(); flash('Pick cancelled'); } };
    document.addEventListener('mouseover', over, true);
    document.addEventListener('click', click, true);
    document.addEventListener('keydown', key, true);
  }

  // ---------- panel ----------
  const panel = document.createElement('div');
  panel.id = 'jq-notify-panel';
  panel.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:2147483647;background:#000236;color:#fff;' +
    'font:13px/1.3 -apple-system,Segoe UI,sans-serif;border-radius:10px;padding:10px;box-shadow:0 4px 16px rgba(0,0,0,.4);' +
    'display:flex;flex-direction:column;gap:6px;min-width:220px';
  const title = document.createElement('div');
  title.style.cssText = 'font-weight:600';
  const status = document.createElement('div');
  status.style.cssText = 'font-size:12px;opacity:.85';
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px';

  function button(label, onClick) {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'background:#ff5115;color:#fff;border:0;border-radius:6px;padding:5px 9px;cursor:pointer;font:inherit';
    b.addEventListener('click', (e) => { e.stopPropagation(); unlock(); onClick(b); });
    row.appendChild(b);
    return b;
  }

  button('🔔 Test sound', () => { beep(); flash('Test sound played'); });
  button('📋 Copy chat', copyChat);
  button('🎯 Pick chat area', startPick);
  button('🔇 Mute', (b) => { state.muted = !state.muted; b.textContent = state.muted ? '🔊 Unmute' : '🔇 Mute'; renderStatus(); });
  button('✕', () => window.__jqNotify.destroy());
  panel.append(title, status, row);
  panel.addEventListener('click', () => { state.unseen = 0; stopFlash(); renderStatus(); });

  let flashMsg = '';
  let flashTimer = null;
  function flash(msg) {
    flashMsg = msg;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { flashMsg = ''; renderStatus(); }, 3000);
    renderStatus();
  }

  function renderStatus() {
    title.textContent = `Chat notifier${state.unseen ? ` · ${state.unseen} new` : ''}`;
    const locked = !state.ctx || state.ctx.state !== 'running';
    status.textContent = flashMsg ||
      [
        state.muted ? 'Muted' : locked ? 'Click "Test sound" once to enable sound' : 'Sound on',
        state.picked ? 'watching picked area' : 'watching all chat widgets',
      ].join(' · ');
  }

  const onFocus = () => { state.unseen = 0; stopFlash(); renderStatus(); };
  window.addEventListener('focus', onFocus);
  state.cleanups.push(() => window.removeEventListener('focus', onFocus));

  document.body.appendChild(panel);
  renderStatus();
  hookDoc(document);

  window.__jqNotify = {
    state,
    beep,
    copyChat,
    transcript: buildTranscript,
    destroy() {
      state.observers.forEach((o) => o.disconnect());
      state.cleanups.forEach((fn) => fn());
      clearTimeout(state.batchTimer);
      stopFlash();
      panel.remove();
      delete window.__jqNotify;
    },
  };
  console.log('[jq-notify] running. Click "Test sound" once to enable sound.');
})();
