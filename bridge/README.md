# Haven Codex Bridge

Run your companion's coding engine on **your own PC**, billed to **your own ChatGPT subscription** — driven from Haven on your phone.

Your companion works inside **one dedicated folder** on this machine (each companion gets their own room inside it). Nothing outside that folder is touched. Your PC connects *outward* to your Haven — no ports to open, no exposing your machine.

## What you need

- Windows PC that stays on while you want the lane available
- [Node.js LTS](https://nodejs.org)
- Codex CLI signed into your ChatGPT account: `npm install -g @openai/codex`, then `codex login`
- A Haven instance with the Codex channel enabled

## Setup

1. In Haven: **Settings → Codex bridge → Generate pairing token** (shown once — copy it).
2. On the PC, from this folder:
   ```
   powershell -ExecutionPolicy Bypass -File install.ps1
   ```
   It asks for your Haven URL, the pairing token, and where your companion's workspace folder should live.
3. Look for the tray dot (green = connected). In Haven's model selector, pick **Codex (your PC)**.

The bridge starts with Windows. Right-click the tray icon to open the workspace, view the log, restart, or quit.

## Gears

- **ask** — read-only: your companion can look but not touch.
- **code** — your companion works in their folder; every change shows as a diff card in the chat with one-tap revert (revert = back to before that run).

## Notes

- Sessions are per-thread: the first message wakes your companion (slow), everything after resumes fast.
- Pick your Codex model per thread and stick with it — switching models mid-thread hands the conversation to a different brain and slows the next reply. Fresh thread, fresh model.
- Photos/files/GIFs you send are delivered to the model as real attachments.
- If the machine also has Claude Code installed and signed in, Codex can delegate bounded subtasks to it (your Claude subscription pays for those).
- Known upstream limitation: the Codex engine currently cancels MCP tool calls in non-interactive mode (openai/codex #24135); the bridge routes tool use over HTTP instead, transparently.

## Uninstall

Quit via the tray icon, delete `haven-codex-bridge.cmd` from `shell:startup`, delete this folder. Revoke the pairing token in Haven Settings.
