// Fake Cognigy-like chat that re-adds the whole bot history on every update (as seen on
// jetstar.com). Only real new agent messages may beep. Control: the v1.3.0 script, which
// lacks the re-render filter, must show the bug on the same page.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const channel = process.env.PW_CHANNEL === undefined ? 'chrome' : process.env.PW_CHANNEL;
const current = fs.readFileSync(path.join(root, 'jetstar-chat-notifier.js'), 'utf8');
const v130 = execFileSync('git', ['show', 'a2eb1d9:jetstar-chat-notifier.js'], { cwd: root, encoding: 'utf8' });

const html = `<!doctype html><html><head><title>Complaints | Jetstar</title></head><body>
<div class="webchat-root"><div class="webchat-chat-history" id="hist">
  <div id="bots"></div><div id="live"></div><div class="sr-live" aria-live="polite" id="sr"></div>
</div><textarea id="inp"></textarea><button id="send">Send</button></div>
<script>
  const BOT = ["Hi. I'm Jess, Jetstar's virtual assistant. I'm here to help you with your Jetstar questions.",
    'Transferring to an agent.', 'Thanks for your patience. You are currently in the queue.'];
  function rerender() { // Cognigy re-adds every bot row as new nodes
    const bots = document.getElementById('bots');
    bots.textContent = '';
    BOT.forEach((t) => { const d = document.createElement('div'); d.className = 'webchat-message-row bot'; d.textContent = t; bots.appendChild(d); });
  }
  function row(who, time, text) {
    rerender();
    const d = document.createElement('div');
    d.className = 'webchat-message-row ' + (who === 'You' ? 'user' : 'agent');
    d.innerText = 'At ' + time + ',' + who + ' said:\\n' + time + '\\n' + text;
    document.getElementById('live').appendChild(d);
    document.getElementById('sr').textContent = who + ' said: ' + text;
  }
  rerender();
  document.getElementById('inp').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); const v = e.target.value; e.target.value = ''; setTimeout(() => row('You', '12:05 AM', v), 300); }
  });
  window.fake = { row, rerender };
</script></body></html>`;

async function run(browser, script) {
  const page = await browser.newPage();
  await page.addInitScript(() => {
    window.__osc = 0;
    window.__focused = true;
    Document.prototype.hasFocus = () => window.__focused;
    const Orig = window.AudioContext;
    window.AudioContext = class extends Orig {
      createOscillator() { const o = super.createOscillator(); const s = o.start.bind(o); o.start = (...a) => { window.__osc++; return s(...a); }; return o; }
    };
  });
  await page.route('https://cognigy.test/**', (r) => r.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('https://cognigy.test/');
  await page.waitForTimeout(300);
  await page.evaluate(script);
  await page.click('button:has-text("Test sound")'); // enables sound; counts as 1 beep
  await page.waitForTimeout(2000);
  const beeps = async () => (await page.evaluate(() => window.__osc)) / 3;
  const step = async (fn) => { const b = await beeps(); await fn(); await page.waitForTimeout(2200); return (await beeps()) - b; };
  const r = {};
  r.agent = await step(() => page.evaluate(() => window.fake.row('Jetstar Human Agent', '12:05 AM', 'So the claim is the flight difference?')));
  r.own = await step(async () => { await page.fill('#inp', 'that is correct'); await page.press('#inp', 'Enter'); });
  r.upload = await step(() => page.evaluate(() => window.fake.row('You', '12:07 AM', 'receipt_ABC123.pdf 262.73 KB')));
  r.rerenderOnly = await step(() => page.evaluate(() => window.fake.rerender()));
  r.same1 = await step(() => page.evaluate(() => window.fake.row('Jetstar Human Agent', '12:18 AM', "I'll just need another minute or two - thanks for sitting tight.")));
  r.same2 = await step(() => page.evaluate(() => window.fake.row('Jetstar Human Agent', '12:28 AM', "I'll just need another minute or two - thanks for sitting tight.")));
  r.log = await page.evaluate(() => window.__jqNotify.state.log.map((e) => e.text));
  r.stats = await page.evaluate(() => window.__jqNotify.state.stats);
  await page.close();
  return r;
}

(async () => {
  const browser = await chromium.launch(channel ? { channel } : {});
  const results = [];
  const check = (name, cond, detail) => results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}  (${detail})`);

  const n = await run(browser, current);
  check('re-render: new agent message beeps once', n.agent === 1, `beeps=${n.agent}`);
  check('re-render: own typed message does not beep', n.own === 0, `beeps=${n.own}`);
  check('re-render: own upload ("You said:") does not beep', n.upload === 0, `beeps=${n.upload}`);
  check('re-render: history re-added alone does not beep', n.rerenderOnly === 0 && n.stats.rerender > 0, `beeps=${n.rerenderOnly}, rerender=${n.stats.rerender}`);
  check('re-render: two identical agent messages beep twice', n.same1 === 1 && n.same2 === 1, `beeps=${n.same1}+${n.same2}`);
  check('re-render: log has only the new agent texts', n.log.length === 3 && !n.log.some((t) => t.includes("I'm Jess")) &&
    n.log[0].includes('flight difference') && n.log.filter((t) => t.includes('another minute')).length === 2, JSON.stringify(n.log));

  // Control: v1.3.0 on the same page must show the bug, or this test could not detect it.
  const o = await run(browser, v130);
  const oldExtra = o.own + o.upload + o.rerenderOnly;
  check('control: v1.3.0 beeps on re-renders (bug reproduced)', oldExtra > 0, `own=${o.own}, upload=${o.upload}, rerenderOnly=${o.rerenderOnly}`);
  check('control: v1.3.0 logs the old bot history (bug reproduced)', o.log.some((t) => t.includes("I'm Jess")), `${o.log.length} log entries`);

  console.log(results.join('\n'));
  await browser.close();
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
})();
