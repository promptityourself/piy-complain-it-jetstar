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
| 🔔 Test sound | Plays the alert (three tones) and enables sound. |
| 🧪 Self test | Plays the alert, injects hidden fake messages to test the detector, lists the chat elements and iframes it found, and shows the last detector decisions. |
| 📋 Copy chat | Copies the chat window text and every message the notifier saw, with arrival time. |
| 🎯 Pick chat area | Click the chat messages to watch only that element. Use it when auto mode misses messages. |
| 🔇 Mute | Turns the sound off and on. |
| ✕ | Removes the script from the page. |

The tab title flashes when a message arrives while you are in another tab.

## How it works

A `MutationObserver` watches the page, same-origin iframes and open shadow roots.
New text counts as a message when an ancestor id/class looks like a chat widget
(`chat`, `webchat`, `message`, `liveagent`, ...). It ignores your own sent message
(the text you typed in the last 15 s), typing indicators, and changes outside the chat.

Limit: a chat in a **cross-origin** iframe is not visible to the top page. The self test lists
such iframes. Then choose the iframe in the Console context drop-down (`top`) and paste again.

## Test

```sh
npm install
npm test   # headless browser test with a fake chat page
```

The test uses your installed Google Chrome. Set `PW_CHANNEL=` to use Playwright's own Chromium.

## License

MIT
