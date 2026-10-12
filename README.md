# piy-complain-it-jetstar

The Jetstar live chat (complaints page) plays no sound when a new message arrives.
This browser console script adds a sound alert, a self test and a "copy chat" button.

Not affiliated with Jetstar. It only reads the page in your own browser and sends nothing anywhere.

## Video recap (one page)

**The problem.** The Jetstar complaints chat makes no sound when the agent replies. You wait in another
window, you miss the reply, and the agent disconnects.

**The prompt** (all the requests, merged into one):

> I have to make a Jetstar complaint in their live chat, but I get no sound when a new message
> arrives. Create a script that I can paste into the browser console. It must:
> 1. Play a sound when a new chat message arrives. Ignore my own messages and the "typing" indicator.
> 2. Have a **Test sound** button, so I can check that I hear it.
> 3. Keep playing the sound until I come back to the page. Test it like this: I click Test sound,
>    switch to another window, and the alarm repeats.
> 4. Have a **Copy chat** button, so I can paste the whole chat back to you and you help me with my case.
> 5. Have a **Self test** button with a detailed PASS/FAIL report that you can use to fix the script.
>
> Here is the page source of the chat window. This is an open source project.

**What I captured** during the real claim (and what the video shows):

| Capture | What it is | Why it matters |
| --- | --- | --- |
| Page source | The HTML of the complaints page, pasted at the start | Claude found the chat widget (Cognigy webchat) in it |
| Self test report | The 🧪 output: sound, clipboard, chat element, detector checks, iframes, counters | Claude read it and fixed the script remotely (v1.1 → v1.2) |
| Chat transcript | The 📋 output: chat window text + every new message with its arrival time | Claude drafted each reply, and the transcript exposed a bug: Cognigy redraws the full history on each update (fixed in v1.4) |

**The tests.** `npm test` opens fake chat pages in a headless Chrome and counts the beeps. It checks
that an agent message beeps, your own message and "typing" do not, the alarm repeats while you are
away and stops when you come back, Copy chat fills the clipboard, and the self test fails when the
watcher is broken. A second test replays a Cognigy-style history redraw. It also runs the old v1.3.0
script as a control, to prove that the test can see the bug.

**Recording script (shot list):**

1. Show the Jetstar complaints page and the chat. Say: "No sound when the agent replies."
2. Show the prompt above.
3. Open DevTools (`Cmd+Option+J`), paste the script, press Enter. The panel appears bottom left.
4. Click **🔔 Test sound**. Switch to another window. The alarm repeats. Come back. It stops.
5. Click **🧪 Self test**. Show the PASS lines. Click **📋 Copy report**.
6. Send a chat message. When the reply arrives, show the beep and the flashing tab title.
7. Click **📋 Copy chat**. Paste it to Claude. Show Claude write the next reply.
8. In a terminal, run `npm test`. Show the PASS lines and the v1.3.0 control.

Before you record, blur or crop your booking details in the chat. This repo has no claim data, and
the video must not show any either.

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

## Test

```sh
npm install
npm test   # headless browser tests on fake chat pages
```

The test uses your installed Google Chrome. Set `PW_CHANNEL=` to use Playwright's own Chromium.

## License

MIT
