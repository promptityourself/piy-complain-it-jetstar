# piy-complain-it-jetstar

The Jetstar live chat (complaints page) plays no sound when a new message arrives.
This browser console script adds a sound alert, a self test and a "copy chat" button.

Not affiliated with Jetstar. It only reads the page in your own browser and sends nothing anywhere.

## Use

1. Open the Jetstar page and start the Live Chat.
2. Open the DevTools Console (`Cmd+Option+J` on Mac, `Ctrl+Shift+J` on Windows).
3. Paste the full content of [`jetstar-chat-notifier.js`](jetstar-chat-notifier.js) and press Enter.
   Chrome can block the first paste: type `allow pasting`, press Enter, then paste again.
4. Click **🔔 Test sound** in the panel (bottom left). This also enables sound in the browser.
5. Click **🧪 Self test**. The report shows PASS/FAIL per check. Use **📋 Copy report** to share it.

A page reload removes the script. Paste it again after a reload.

## Panel buttons

| Button | Action |
| --- | --- |
| 🔔 Test sound | Plays the alert (three tones) and enables sound. Switch to another window within 10 s to test the repeat alarm. |
| 🧪 Self test | Plays the alert, injects hidden fake messages to test the detector, lists the chat elements and iframes it found, and shows the last detector decisions. |
| 📋 Copy chat | Copies the chat window text and every message the notifier saw, with arrival time. |
| 🎯 Pick chat area | Click the chat messages to watch only that element. Use it when auto mode misses messages. |
| 🔇 Mute | Turns the sound off and on. |
| ✕ | Removes the script from the page. |

When a message arrives while you look at another window or tab, the alert repeats every 3 s and the tab title flashes. Both stop when you come back to the page, click the panel, or click 🔇 Mute.

## How it works

A `MutationObserver` watches the page, same-origin iframes and open shadow roots.
New text counts as a message when an ancestor id/class looks like a chat widget
(`chat`, `webchat`, `message`, `liveagent`, ...). It ignores your own sent message
(the text you typed in the last 15 s), typing indicators, and changes outside the chat.

The Jetstar chat (Cognigy) adds the whole bot history again on every update. So inside the
chat area, the notifier compares the chat text with the text at the last check, and only the
new lines count. Lines with "You said:" are your own messages and do not make a sound.

Limit: a chat in a **cross-origin** iframe is not visible to the top page. The self test lists
such iframes. Then choose the iframe in the Console context drop-down (`top`) and paste again.

## Demo: the missed agent

`demo.html` is a fake airline chat ("Demo Air", not Jetstar). It shows what happens when a live agent joins while you look at another window: the agent asks once, then closes the chat.

1. Open `demo.html` in the browser, next to `jetstar-chat-notifier.js`.
2. Click **▶ Start scenario**, then **Send** in the chat, then switch to another window. The agent joins, waits, and disconnects.
3. Click **🔔 Load notifier** and **🔔 Test sound**, then run the scenario again. The sound repeats until you come back, and a reply keeps the agent.

The demo timings are invented. Jetstar's real timeouts are not known.

## Test

```sh
npm install
npm test   # headless browser tests: fake chat page + the missed-agent demo
```

The test uses your installed Google Chrome. Set `PW_CHANNEL=` to use Playwright's own Chromium.

## License

MIT
