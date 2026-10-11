const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
// Headless browser test: fake chat page, counts beeps by stubbing the oscillator.
// Uses installed Google Chrome by default; set PW_CHANNEL='' for Playwright's own Chromium.
const script = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'jetstar-chat-notifier.js'), 'utf8');
const channel = process.env.PW_CHANNEL ?? 'chrome';

const html = `<!doctype html><html><head><title>Complaints | Jetstar</title></head><body>
<div class="carousel" id="deals"></div>
<div id="webchatWindow" class="webchat">
  <div class="webchat-chat-history"><div class="webchat-message-row bot">Hi, I'm Jess. How can I help?</div></div>
  <textarea id="inp"></textarea><button id="send">Send</button>
</div>
<iframe id="liveagentFrame" srcdoc="<div class='chat-log'></div>"></iframe>
</body></html>`;

(async () => {
  const browser = await chromium.launch(channel ? { channel } : {});
  const page = await browser.newPage();
  // Count beeps by stubbing the oscillator start.
  await page.addInitScript(() => {
    window.__osc = 0;
    const Orig = window.AudioContext;
    window.AudioContext = class extends Orig {
      createOscillator() { const o = super.createOscillator(); const s = o.start.bind(o); o.start = (...a) => { window.__osc++; return s(...a); }; return o; }
    };
  });
  await page.route('https://chat.test/**', r => r.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('https://chat.test/');
  await page.waitForTimeout(200);
  await page.evaluate(script);
  const beeps = async () => (await page.evaluate(() => window.__osc)) / 3; // 3 tones per beep
  const wait = () => page.waitForTimeout(2000);
  const results = [];
  const check = (name, cond, detail) => results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}  (${detail})`);

  // Positive control: the Test button must register as one beep.
  await page.click('button:has-text("Test sound")'); await wait();
  let b = await beeps(); check('test button beeps (control)', b === 1, `beeps=${b}`);

  // Bot/agent message in chat history -> beep.
  await page.evaluate(() => { const d = document.createElement('div'); d.className = 'webchat-message-row bot'; d.textContent = 'An agent will join shortly.'; document.querySelector('.webchat-chat-history').appendChild(d); });
  await wait(); let b2 = await beeps(); check('agent message beeps', b2 === b + 1, `beeps=${b2}`); b = b2;

  // User's own message echo -> no beep.
  await page.fill('#inp', 'My flight JQ123 was cancelled');
  await page.press('#inp', 'Enter');
  await page.evaluate(() => { const d = document.createElement('div'); d.className = 'webchat-message-row user'; d.textContent = 'My flight JQ123 was cancelled'; document.querySelector('.webchat-chat-history').appendChild(d); });
  await wait(); b2 = await beeps(); check('own message does not beep', b2 === b, `beeps=${b2}`); b = b2;

  // Typing indicator -> no beep.
  await page.evaluate(() => { const d = document.createElement('div'); d.textContent = 'Agent is typing...'; document.querySelector('.webchat-chat-history').appendChild(d); });
  await wait(); b2 = await beeps(); check('typing indicator does not beep', b2 === b, `beeps=${b2}`); b = b2;

  // Non-chat page change -> no beep.
  await page.evaluate(() => { document.getElementById('deals').textContent = 'Sale: Bali from $199'; });
  await wait(); b2 = await beeps(); check('non-chat change does not beep', b2 === b, `beeps=${b2}`); b = b2;

  // Same-origin iframe chat -> beep.
  await page.evaluate(() => { const doc = document.getElementById('liveagentFrame').contentDocument; const d = doc.createElement('p'); d.textContent = 'Agent Sam: I can see your booking.'; doc.querySelector('.chat-log').appendChild(d); });
  await wait(); b2 = await beeps(); check('iframe agent message beeps', b2 === b + 1, `beeps=${b2}`); b = b2;

  // Transcript content.
  const t = await page.evaluate(() => window.__jqNotify.transcript());
  check('transcript has chat text', t.includes("Hi, I'm Jess") && t.includes('My flight JQ123 was cancelled'), 'chat window text');
  check('transcript has timed log', /\[\d.*\] Agent Sam: I can see your booking\./.test(t), 'notifier log');

  // Copy button writes clipboard.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.click('text=Copy chat'); await page.waitForTimeout(300);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  check('copy button fills clipboard', clip.startsWith('Jetstar chat transcript') && clip.includes('An agent will join'), `${clip.length} chars`);

  // Self test: healthy page -> all pass, no extra notification.
  const logBefore = await page.evaluate(() => window.__jqNotify.state.log.length);
  await page.click('button:has-text("Self test")');
  await page.waitForSelector('#jq-notify-report', { timeout: 10000 });
  const rep = await page.evaluate(() => document.querySelector('#jq-notify-report textarea').value);
  check('self test: all pass', rep.includes('Result: all checks passed') && !/^FAIL/m.test(rep), (rep.match(/^(PASS|FAIL).*$/mg) || []).join(' | '));
  check('self test: report sections', ['== Chat discovery ==', '== Activity since start ==', 'same-origin (watched)', 'accepted: "Agent Sam'].every((x) => rep.includes(x)), 'discovery + decisions');
  check('self test probes the real chat element', rep.includes('PASS  Chat element found') && rep.includes('fake messages placed in: real chat element') && rep.includes('div#webchatWindow.webchat'), 'probe target');
  check('self test keeps counters real', /accepted=2, notChat=1, typing=1, echo=1,/.test(rep), (rep.match(/Counters: .*/) || [''])[0]);
  const logAfter = await page.evaluate(() => window.__jqNotify.state.log.length);
  check('self test does not add fake messages to log', logAfter === logBefore, `${logBefore} -> ${logAfter}`);
  await page.click('#jq-notify-report >> text=Close');
  // Control: break the watcher -> detection check must FAIL.
  await page.evaluate(() => window.__jqNotify.state.observers.forEach((o) => o.disconnect()));
  const rep2 = await page.evaluate(() => window.__jqNotify.selfTest());
  check('self test FAILS when watcher is broken (control)', /^FAIL  Detects a new chat message/m.test(rep2) && rep2.includes('1 check(s) FAILED'), (rep2.match(/^FAIL.*$/m) || ['no FAIL'])[0]);
  console.log('\n--- self test report sample ---\n' + rep);

  // Destroy removes panel.
  await page.evaluate(() => window.__jqNotify.destroy());
  check('close removes panel', !(await page.$('#jq-notify-panel')), 'panel gone');

  console.log(results.join('\n'));
  console.log('\n--- transcript sample ---\n' + t);
  await browser.close();
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
})();
