// Jetstar chat notifier — paste into the browser DevTools console on the chat page.
// Beeps (and flashes the tab title) when a new message arrives in the chat.
// Panel buttons: Test sound, Self test, Copy chat, Pick chat area, Mute, Close.
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
  const VERSION = '1.2.0';

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
    startedAt: new Date(),
    selfTest: null,
    // Detector counters and the last decisions, for the self-test report.
    stats: { mutations: 0, accepted: 0, notChat: 0, typing: 0, echo: 0, short: 0, duplicate: 0 },
    decisions: [],
  };

  function remember(reason, node, text) {
    if (state.selfTest && (text || '').includes(state.selfTest.marker)) return; // keep counters real
    state.stats[reason]++;
    if (reason === 'notChat' && state.decisions.filter((d) => d.reason === 'notChat').length >= 5) return;
    state.decisions.push({ at: new Date(), reason, text: (text || '').slice(0, 80), path: pathOf(node) });
    if (state.decisions.length > 25) state.decisions.shift();
  }

  function pathOf(node) {
    const parts = [];
    let el = node && (node.nodeType === 1 ? node : node.parentElement);
    for (let i = 0; el && i < 6; i++, el = el.parentElement) {
      const id = el.id ? '#' + el.id : '';
      const cls = (attr(el, 'class').trim().split(/\s+/).filter(Boolean).slice(0, 2).map((c) => '.' + c)).join('');
      parts.unshift(el.tagName.toLowerCase() + id + cls);
    }
    return parts.join(' > ');
  }

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
    if (isIgnored(node)) return;
    const text = (node.nodeType === 3 ? node.data : node.innerText || node.textContent || '').trim();
    if (!text) return;
    if (!inChatArea(node)) return remember('notChat', node, text);
    if (text.length < 2) return remember('short', node, text);
    if (TYPING.test(text)) return remember('typing', node, text);
    if (isOwnEcho(text)) return remember('echo', node, text);
    if (state.pending.some((p) => p.includes(text) || text.includes(p))) return remember('duplicate', node, text);
    remember('accepted', node, text);
    state.pending.push(text);
    clearTimeout(state.batchTimer);
    state.batchTimer = setTimeout(flushBatch, BATCH_MS);
  }

  function flushBatch() {
    // Keep only outermost texts: a message row and its inner text node arrive together.
    const texts = state.pending.filter((t, i, all) => !all.some((o, j) => j !== i && o.length > t.length && o.includes(t)));
    state.pending = [];
    // Self-test messages carry a marker: count them, never notify.
    const st = state.selfTest;
    const real = st ? texts.filter((t) => { if (t.includes(st.marker)) { st.hits.push(t); return false; } return true; }) : texts;
    if (real.length) notify(real);
  }

  function onMutations(mutations) {
    state.stats.mutations += mutations.length;
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

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* fallback below */ }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }

  async function copyChat() {
    const text = buildTranscript();
    if (await copyText(text)) {
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

  // ---------- self test ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Inject a hidden fake message into the real chat element (or the picked area), and report
  // whether the detector fired. Only without a chat element does the probe carry its own chat class.
  function probeTarget() {
    if (state.root && state.root.isConnected) return { el: state.root, where: 'picked chat area' };
    const root = findChatRoot();
    if (root) return { el: root, where: 'real chat element ' + pathOf(root) };
    return { el: document.body, where: 'page body with a fake chat class (no chat element found yet)', synthetic: true };
  }

  async function probe(kind, text, setup) {
    const marker = 'JQSELFTEST' + Math.random().toString(36).slice(2, 8);
    state.selfTest = { marker, hits: [] };
    const target = probeTarget();
    const el = document.createElement('div');
    el.className = 'jq-selftest' + (target.synthetic ? ' webchat-message-row' : '');
    el.style.cssText = 'position:fixed;left:-9999px;top:0';
    el.textContent = text.replace('{m}', marker);
    if (setup) setup(norm(el.textContent));
    target.el.appendChild(el);
    await sleep(BATCH_MS + 500);
    el.remove();
    const hits = state.selfTest.hits.length;
    state.selfTest = null;
    return hits;
  }

  function describe(el) {
    if (!el) return '(none)';
    const r = el.getBoundingClientRect();
    return `${pathOf(el)}  [text ${(el.innerText || '').trim().length} chars, ${Math.round(r.width)}x${Math.round(r.height)}px, ` +
      `${r.width && r.height ? 'visible' : 'hidden'}]`;
  }

  async function selfTest() {
    flash('Self test running… (you should hear 3 tones)');
    const out = [];
    const line = (ok, name, detail) => out.push(`${ok === null ? 'INFO' : ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);

    out.push(`Jetstar chat notifier self test (v${VERSION})`, `Run: ${new Date().toString()}`,
      `Page: ${location.href}`, `Browser: ${navigator.userAgent}`,
      `Notifier started: ${state.startedAt.toLocaleTimeString()}`, '', '== Checks ==');

    // Sound
    let audioState = 'unsupported';
    try { audio(); beep(); await sleep(150); audioState = state.ctx.state; } catch (e) { audioState = 'error: ' + e.message; }
    line(audioState === 'running', 'Sound engine', `AudioContext state = ${audioState} (did you hear 3 tones?)`);
    line(null, 'Mute', state.muted ? 'MUTED — no sound will play' : 'off');

    // Clipboard
    line(!!(navigator.clipboard && window.isSecureContext), 'Clipboard API', `secure context = ${window.isSecureContext}`);

    // Context
    line(null, 'Running in', window.top === window ? 'top page' : 'an iframe');
    line(null, 'Tab', `hidden = ${document.hidden}, focused = ${document.hasFocus()}`);

    // Detector probes
    const target = probeTarget();
    line(!target.synthetic, 'Chat element found', target.synthetic ? 'NOT found — open the chat, then run the self test again' : 'yes');
    out.push(`      fake messages placed in: ${target.where}`);
    const savedSent = [state.lastSent, state.lastSentAt];
    const msgHits = await probe('message', 'Agent: self test message {m}');
    line(msgHits > 0, 'Detects a new chat message', `${msgHits} hit(s) in ${state.root ? 'picked area' : 'auto mode'}`);
    line(null, 'Real chat messages notified so far', `${state.log.length}` + (state.log.length ? '' : ' — send a message in the chat and run the self test again after the reply'));
    const echoHits = await probe('echo', 'My own text {m}', (t) => { state.lastSent = t; state.lastSentAt = Date.now(); });
    [state.lastSent, state.lastSentAt] = savedSent;
    line(echoHits === 0, 'Ignores my own sent message', `${echoHits} hit(s), expected 0`);
    const typingHits = await probe('typing', '{m} is typing...');
    line(typingHits === 0, 'Ignores typing indicator', `${typingHits} hit(s), expected 0`);

    // Chat discovery
    out.push('', '== Chat discovery ==');
    out.push(`Chat area for copy: ${state.picked ? 'picked' : 'auto'} → ${describe(findChatRoot())}`);
    const candidates = [];
    allDocs().forEach((doc) => doc.querySelectorAll('[id], [class]').forEach((el) => {
      if (panel.contains(el) || el.classList.contains('jq-selftest') || /^(SCRIPT|STYLE|LINK|META)$/.test(el.tagName)) return;
      if (CHAT_HINT.test(attr(el, 'id') + ' ' + attr(el, 'class'))) candidates.push(el);
    }));
    const outer = candidates.filter((el) => !candidates.some((o) => o !== el && o.contains(el)));
    out.push(`Elements with chat-like id/class: ${candidates.length} (outermost ${outer.length}):`);
    outer.slice(0, 10).forEach((el) => out.push('  - ' + describe(el)));
    const frames = [...document.querySelectorAll('iframe')];
    out.push(`Iframes: ${frames.length}`);
    frames.slice(0, 15).forEach((f) => {
      let access = 'cross-origin (NOT watched)';
      try { if (f.contentDocument) access = 'same-origin (watched)'; } catch (e) { /* cross-origin */ }
      out.push(`  - ${pathOf(f)} src=${(f.src || '(none)').slice(0, 120)} title=${attr(f, 'title') || '-'} → ${access}`);
    });
    const shadows = [...document.querySelectorAll('*')].filter((el) => el.shadowRoot).length;
    out.push(`Open shadow roots: ${shadows}`);
    const globals = ['embedded_svc', 'embeddedservice_bootstrap', 'liveagent', 'initWebchat', 'webchat', 'Cognigy']
      .filter((g) => typeof window[g] !== 'undefined');
    out.push(`Chat vendor globals found: ${globals.join(', ') || '(none)'}`);

    // Activity
    out.push('', '== Activity since start ==');
    out.push('Counters: ' + Object.entries(state.stats).map(([k, v]) => `${k}=${v}`).join(', '));
    out.push(`Messages notified: ${state.log.length}${state.log.length ? ', last at ' + state.log[state.log.length - 1].at.toLocaleTimeString() : ''}`);
    out.push('Last detector decisions (newest last):');
    state.decisions.filter((d) => !d.text.includes('JQSELFTEST')).slice(-15)
      .forEach((d) => out.push(`  [${d.at.toLocaleTimeString()}] ${d.reason}: "${d.text}"  @ ${d.path}`));

    const fails = out.filter((l) => l.startsWith('FAIL')).length;
    out.splice(7, 0, `Result: ${fails ? fails + ' check(s) FAILED' : 'all checks passed'}`);
    const report = out.join('\n');
    state.lastReport = report;
    console.log(report);
    showReport(report, fails);
    return report;
  }

  function showReport(report, fails) {
    const box = document.createElement('div');
    box.id = 'jq-notify-report';
    box.style.cssText = 'position:fixed;inset:8% 10%;z-index:2147483647;background:#fff;color:#000;border:2px solid ' +
      (fails ? '#d00' : '#0a7a2f') + ';border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:8px;font:14px sans-serif';
    const head = document.createElement('b');
    head.textContent = fails ? `Self test: ${fails} check(s) failed — copy this and send it to Claude` : 'Self test: all checks passed';
    const ta = document.createElement('textarea');
    ta.value = report;
    ta.readOnly = true;
    ta.style.cssText = 'flex:1;font:12px monospace';
    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:8px';
    const mk = (label, fn) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = 'background:#ff5115;color:#fff;border:0;border-radius:6px;padding:6px 12px;cursor:pointer';
      b.onclick = fn;
      bar.appendChild(b);
      return b;
    };
    const copyBtn = mk('📋 Copy report', async () => {
      copyBtn.textContent = (await copyText(report)) ? 'Copied ✓' : 'Copy failed: select the text';
    });
    mk('Close', () => box.remove());
    box.append(head, ta, bar);
    box.addEventListener('click', (e) => e.stopPropagation());
    document.body.appendChild(box);
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
  button('🧪 Self test', selfTest);
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
    selfTest,
    destroy() {
      state.observers.forEach((o) => o.disconnect());
      state.cleanups.forEach((fn) => fn());
      clearTimeout(state.batchTimer);
      stopFlash();
      panel.remove();
      const report = document.getElementById('jq-notify-report');
      if (report) report.remove();
      delete window.__jqNotify;
    },
  };
  console.log('[jq-notify] running. Click "Test sound" once to enable sound.');
})();
