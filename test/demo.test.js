// Runs the missed-agent demo twice: without a reply (agent disconnects) and with the
// notifier loaded while the page is not in focus (alarm repeats, the reply keeps the agent).
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const channel = process.env.PW_CHANNEL === undefined ? 'chrome' : process.env.PW_CHANNEL;
const files = {
  'demo.html': ['text/html', fs.readFileSync(path.join(root, 'demo.html'), 'utf8')],
  'jetstar-chat-notifier.js': ['text/javascript', fs.readFileSync(path.join(root, 'jetstar-chat-notifier.js'), 'utf8')],
};

async function openDemo(browser, scale) {
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
  await page.route('https://demo.test/**', (r) => {
    const f = files[new URL(r.request().url()).pathname.slice(1)];
    return f ? r.fulfill({ contentType: f[0], body: f[1] }) : r.fulfill({ status: 404, body: '' });
  });
  await page.goto(`https://demo.test/demo.html?scale=${scale}`);
  return page;
}

(async () => {
  const browser = await chromium.launch(channel ? { channel } : {});
  const results = [];
  const check = (name, cond, detail) => results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}  (${detail})`);
  const beeps = (page) => page.evaluate(() => window.__osc / 3);

  // 1. No notifier, no reply -> the agent disconnects.
  let page = await openDemo(browser, 0.3); // agent joins after 4.5 s, closes ~8 s later
  await page.click('#start');
  await page.click('#send');
  await page.waitForFunction(() => window.demo.state() === 'ended', null, { timeout: 30000 });
  const out1 = await page.textContent('#outcome');
  check('no reply: agent disconnects', /missed the agent/.test(out1), out1.trim());
  check('no reply: input disabled', await page.isDisabled('#inp'), 'chat closed');
  await page.close();

  // 2. Notifier loaded, page not in focus -> alarm repeats; a reply keeps the agent.
  page = await openDemo(browser, 0.5); // agent closes ~13 s after joining
  await page.click('#loadNotifier');
  await page.waitForSelector('#jq-notify-panel');
  await page.click('button:has-text("Test sound")');
  await page.click('#start');
  await page.click('#send');
  await page.waitForTimeout(3500); // bot replies arrive while you still look
  await page.evaluate(() => { window.__jqNotify.state.testArmedUntil = 0; window.__focused = false; window.dispatchEvent(new Event('blur')); });
  const before = await beeps(page);
  await page.waitForFunction(() => document.body.innerText.includes('has joined the chat'), null, { timeout: 30000 });
  await page.waitForTimeout(7500); // join beep + alarm repeats every 3 s
  const after = await beeps(page);
  check('agent joins while away: sound repeats', after - before >= 3, `beeps ${before} -> ${after}`);
  const ownBeeps = await page.evaluate(() => window.__jqNotify.state.decisions.filter((d) => d.reason === 'echo').length);
  check('own first message not notified', ownBeeps >= 1, `echo decisions=${ownBeeps}`);
  await page.evaluate(() => { window.__focused = true; window.dispatchEvent(new Event('focus')); });
  await page.fill('#inp', 'Yes, I am here!');
  await page.press('#inp', 'Enter');
  await page.waitForTimeout(1500);
  const out2 = await page.textContent('#outcome');
  check('reply in time: agent stays', /caught the agent/.test(out2) && await page.evaluate(() => window.demo.state()) === 'caught', out2.trim());
  await page.waitForTimeout(12000);
  check('reply in time: no disconnect later', await page.evaluate(() => window.demo.state()) === 'caught' && !(await page.isDisabled('#inp')), 'still open');
  const alarm = await page.evaluate(() => !!window.__jqNotify.state.alarmTimer);
  check('focus stopped the alarm', !alarm, `alarmTimer=${alarm}`);
  await page.close();

  console.log(results.join('\n'));
  await browser.close();
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
})();
