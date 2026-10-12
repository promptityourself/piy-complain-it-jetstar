# piy-complain-it-jetstar — agent notes

- **The repo is PUBLIC.** It was built during mate's own Jetstar claim. Never put claim data in it —
  booking codes, flight numbers, amounts, names (also the agent's), case IDs, or real chat text — not
  even inside a test fixture. Fixtures use placeholders (`receipt_ABC123.pdf`). A real Qantas booking
  code once leaked through a fixture copied from a live chat log and needed a history rewrite
  (2026-10-12). The claim evidence lives on the share, outside the repo.
- Before a push, grep `git log -p` for the claim terms, with a positive control (a term you know is there).
- The real Jetstar chat is Cognigy webchat: it redraws the whole history on each update, and own
  messages carry "You said:". `test/rerender.test.js` reproduces it; keep its v1.3.0 control
  (loaded from commit `a2eb1d9`) — it proves the test can see the bug.
- Project page: https://promptityourself.com/projects/complain-it-jetstar/ (mergodon/promptityourself-web#118).
