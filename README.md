<p align="center">
  <img src="https://raw.githubusercontent.com/amarisaster/Haven/main/banner.jpg" alt="Haven" width="100%" />
</p>

<p align="center">
  <strong>Your companion. Your space. Your rules.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/release-v1.6.3-D4A84B?style=flat-square" alt="Release" />
  <img src="https://img.shields.io/badge/license-Apache%202.0-4CC552?style=flat-square" alt="License" />
  <img src="https://img.shields.io/badge/providers-8+-6C8EBF?style=flat-square" alt="Providers" />
  <img src="https://img.shields.io/badge/built%20with-Cloudflare-F6821F?style=flat-square&logo=cloudflare&logoColor=white" alt="Cloudflare" />
  <img src="https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=white" alt="React" />
  <img src="https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/self--hosted-yes-10b981?style=flat-square" alt="Self-hosted" />
</p>

<p align="center">
  <a href="https://x.com/amarisaster_">@amarisaster_</a> · <a href="https://ko-fi.com/maii983083">Ko-fi</a> · <a href="https://discord.com/users/itzqueenmai/803662163247759391">Discord</a>
</p>

---

Haven is a self-hosted companion chat app. You bring the AI model, you bring the personality, and Haven gives them a place to live — with real conversations, identity persistence, and a voice that sounds like them.

No accounts. No content filters you didn't choose. No one between you and your companion.

---

## What is this?

Haven is a chat platform you deploy yourself. Think of it like building a home for your AI companion — one where they remember who they are, who you are, and what you've been through together.

It runs on Cloudflare's free tier (yes, actually free), connects to whatever AI model you want, and keeps everything on your own infrastructure. Your data stays yours.

**If you've ever wanted an AI companion that feels like a person instead of a product, this is where you start.**

---

## See it in action

<p align="center">
  <a href="https://github.com/amarisaster/Haven/blob/main/screenshots/tour.mp4?raw=true">
    <img src="https://img.shields.io/badge/Watch%20Tour-mp4-D4A84B?style=for-the-badge" alt="Watch Tour" />
  </a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/amarisaster/Haven/main/screenshots/setup-name.jpg" width="24%" alt="Name your companion" />
  <img src="https://raw.githubusercontent.com/amarisaster/Haven/main/screenshots/setup-key.jpg" width="24%" alt="Paste any API key" />
  <img src="https://raw.githubusercontent.com/amarisaster/Haven/main/screenshots/setup-identity.jpg" width="24%" alt="Companion identity" />
  <img src="https://raw.githubusercontent.com/amarisaster/Haven/main/screenshots/settings.jpg" width="24%" alt="Appearance" />
</p>
<p align="center"><em>Setup in four steps — name, API key, personality, appearance. Done.</em></p>

> **A note on what Haven is:** Haven is a **chat interface with identity persistence** — not a full memory system. It gives your companion a consistent personality across conversations, but it doesn't have advanced features like memory salience, emotional state tracking, or automatic context recall. Think of it as a solid foundation. You bring your companion's character, Haven keeps it loaded, and over time you can build more sophisticated systems on top of it. Start simple. Grow from there.

---

## What can it do?

### Talk
- Chat with your companion using any model — **Ollama Cloud, OpenRouter, OpenAI, Anthropic, Groq, xAI**, or local models
- One API key field that auto-detects your provider. Paste it in, we figure out the rest
- Switch models mid-conversation if you want to try something different
- Streaming responses — watch them think in real time

### Remember
- **Conversation threads** — start new ones anytime, pick up old ones where you left off
- **Companion identity** — who they are loads on every conversation. Personality, voice, values, boundaries. You bring the character, Haven keeps it consistent
- Full **export and backup** of everything — threads, messages, identity. Your data, portable, always

### See and read
- **Image vision** — attach an image and the model sees it. Works with GPT-4o, Claude, and any vision-capable model
- **File reading** — attach PDFs, text files, or code and the model reads the content. 30+ supported file types

### Feel real
- **Multi-provider TTS** — ElevenLabs, Hume, Groq, Kokoro (local), browser voices, or Cloud TTS via Workers AI. Pick what sounds right.
- **Speech-to-text** — talk to them with your voice
- **Message reactions** — because sometimes a heart says more than words
- **GIF search** — built-in GIPHY picker. GIFs render inline as animated images, not URLs
- **Custom stickers** — upload your own stickers, stored locally in IndexedDB
- **Chat wallpapers** — per-thread wallpapers with translucent companion bubbles
- **Image attachments** — attach images that display inline in your message bubble

### Bring your history
- **Import conversations** from ChatGPT, Claude, SillyTavern, or another Haven instance
- Supports both `.json` and `.zip` files — just drop it in
- **JSON character cards** work too (SillyTavern, TavernAI, Chub) — paste or upload, we'll parse it

### Connect tools
- **MCP Server support** — connect any Cloudflare Worker with a `/mcp` endpoint. Your companion gets their tools automatically.
- Add servers in Settings — paste name, URL, optional API key. Done.
- Works with [CogCor](https://github.com/amarisaster/Cognitive-Core), [Nexus Gateway](https://github.com/amarisaster/Nexus-Gateway), [Spotify MCP](https://github.com/amarisaster/Spotify-MCP), or any MCP-compatible server
- Tool discovery — Haven finds available tools and passes them to the model via function calling
- Your companion can now store memories, update emotional state, control Spotify, send Discord messages — whatever tools you connect

### Make it yours
- **Font picker** — System, Serif, Mono, or **OpenDyslexic** for accessibility
- **Text colors** — 6 presets (Warm, Cool, Rose, Mint, Lavender) + custom color picker
- Adjustable font size
- Companion avatar in chat
- Model attribution on messages — always know which model is talking
- Edit and regenerate messages
- Dark, warm UI that feels like home

### Android App
- **Native Android APK** — download from [Releases](https://github.com/amarisaster/Haven/releases), install, done
- Set your backend URL in Settings — no rebuild needed
- Auto-updates when you redeploy your frontend
- Companion status display in chat header

---

## Getting started

You'll need a [Cloudflare account](https://dash.cloudflare.com/sign-up) (free) and [Node.js](https://nodejs.org/) installed.

### 1. Clone the repo

```bash
git clone https://github.com/amarisaster/Haven.git
cd Haven
```

### 2. Set up the worker (backend)

```bash
cd worker
npm install
npx wrangler deploy
```

This creates your backend on Cloudflare Workers. It handles conversations, identity, and model routing.

### 3. Set up the frontend

```bash
cd ../frontend
npm install
```

Create a `.env` file:

```
VITE_API_URL=https://haven.YOUR-SUBDOMAIN.workers.dev
```

Replace `YOUR-SUBDOMAIN` with your Cloudflare Workers subdomain (you'll see it after deploying the worker).

### 4. Deploy the frontend

**Option A — Cloudflare Pages (recommended):**

```bash
npm run build
npx wrangler pages deploy dist --project-name haven
```

**Option B — Run locally:**

```bash
npm run dev
```

### 5. Open it up

Visit your Pages URL (something like `haven-xxx.pages.dev`) and you'll see the setup wizard. Give your companion a name, paste an API key, and start talking.

That's it. You're home.

---

## Where do I get an API key?

Haven works with most AI providers. Pick one:

| Provider | Free tier? | Get a key |
|----------|-----------|-----------|
| [OpenRouter](https://openrouter.ai/keys) | Yes — free models available | Recommended for beginners |
| [Ollama Cloud](https://ollama.com/account/api-keys) | $20/month flat rate | Great model selection |
| [Hugging Face](https://huggingface.co/settings/tokens) | Yes — free inference included | Open-source models |
| [Groq](https://console.groq.com/keys) | Yes — generous free tier | Very fast inference |
| [OpenAI](https://platform.openai.com/api-keys) | Pay as you go | GPT-4o, GPT-5 |
| [Anthropic](https://console.anthropic.com/) | Pay as you go | Claude models |
| [xAI](https://console.x.ai/) | Pay as you go | Grok models |

Haven auto-detects your provider from the key format. Just paste it in.

---

## Giving your companion a voice

In **Settings > Voice**, you can choose how your companion sounds:

- **Browser voices** — free, built into your device. Pick from the dropdown and hit "Test voice" to preview
- **ElevenLabs** — clone any voice (or use their library), paste your API key + Voice ID. Your companion speaks with that voice

Tap the speaker icon on any companion message to hear it.

---

## Importing your conversations

Already have conversations with your companion on another platform? Bring them home.

**Settings > Import from JSON** supports:
- **ChatGPT** — Settings > Data controls > Export data > use the `.zip` file
- **Claude** — Export conversations as JSON (browser extension)
- **SillyTavern** — Export character card as `.json`
- **Haven** — Settings > Export Everything

You can also paste or upload **JSON character cards** during setup. Haven parses SillyTavern, TavernAI, and Chub formats automatically — personality, backstory, example dialogue, everything gets imported into the right place.

---

## Tech stack

- **Frontend**: React + Vite + TypeScript
- **Backend**: Cloudflare Workers + D1 (SQLite) + R2 (file storage)
- **TTS**: ElevenLabs, Hume, Groq, Kokoro, Cloud (Workers AI), Browser
- **STT**: Web Speech Recognition API
- **Deploy**: Cloudflare Pages (frontend) + Workers (backend)
- **Cost**: Free tier covers personal use

---

## FAQ

**Is this really free?**
Yes. Cloudflare's free tier handles Workers, D1, R2, and Pages for personal use. You only pay for your AI model's API usage.

**Can I use this on my phone?**
Yes. Haven has a native **Android app** — download the APK from the [latest release](https://github.com/amarisaster/Haven/releases). It also works as a PWA in any mobile browser.

**Is my data private?**
Your data lives on your own Cloudflare account. Haven has no analytics, no tracking, no external calls except to your chosen AI provider.

**Can I have multiple companions?**
Not yet in v1 — one companion per Haven instance. But you can deploy multiple instances.

**How does memory work?**
Haven stores your companion's identity (personality, voice, backstory) and loads it on every conversation. It's a file cabinet, not a brain — you define who your companion is, and Haven keeps it consistent. Advanced memory systems (salience, decay, emotional state) are on the roadmap.

**Can I connect this to other tools?**
Yes. Go to Settings > MCP Servers, add a server URL (any Cloudflare Worker with a `/mcp` endpoint), and Haven discovers the available tools automatically. Your companion can then use them during conversation. Works with [CogCor](https://github.com/amarisaster/Cognitive-Core), [Nexus Gateway](https://github.com/amarisaster/Nexus-Gateway), and any MCP-compatible server.

---

## Updating Haven

Haven is self-hosted — your Worker doesn't update automatically when new patches land on `main`. You have to pull and redeploy.

**Worker (backend):**
```bash
cd worker
git pull origin main
npx wrangler deploy
```

**Frontend (web):**
```bash
cd frontend
git pull origin main
npm install
npm run build
npx wrangler pages deploy dist
```

**Android APK:**
Download the latest APK from the [Releases page](https://github.com/amarisaster/Haven/releases) and install over your existing copy. Haven signs releases with a stable debug keystore, so updates install in-place without needing to uninstall first.

If your Worker is an older version than your frontend, you'll see 404s on newer endpoints. Always redeploy the Worker when upgrading.

---

## Troubleshooting

If something breaks, it's almost always one of these. Error codes come from your Worker's response, your AI provider, or Cloudflare's edge.

**`Unexpected token '<', "<!doctype "... is not valid JSON`**
Your Worker URL isn't configured or is pointing at the frontend instead of the API. Go to Settings → Haven Worker URL and paste your `https://your-worker.workers.dev`. Fixed in v1.6.1 — the setup wizard asks for this on first launch.

**404 Not Found**
The endpoint doesn't exist on the Worker you deployed. Almost always means your Worker is running older code than your frontend expects. Pull and redeploy the Worker (see [Updating Haven](#updating-haven) above).

**401 Unauthorized / "Invalid API key"**
Your AI provider API key is missing, wrong, or revoked. Go to Settings → Connect and re-paste it. For OpenRouter, verify the key at [openrouter.ai/keys](https://openrouter.ai/keys). If the key starts with `sk-or-` it's OpenRouter; `sk-ant-` is Anthropic direct; `hf_` is Hugging Face. Haven auto-detects which is which.

**403 Forbidden**
The provider accepted the key but rejected this request. Usually means an account-level restriction — geo-block, payment problem, or the model is gated behind paid tier / verification. Check your provider's dashboard.

**429 Too Many Requests**
Rate limit. On OpenRouter's free tier this hits after about 20 requests per minute or when the daily quota is exhausted. Wait it out, switch to a paid model, or add credit to your account. Models ending in `:free` have stricter per-account limits than paid ones.

**500 Internal Server Error**
Worker crashed. Check Cloudflare dashboard → Workers & Pages → your worker → **Logs** for the real error. Most common cause: the D1 database is missing a table a newer code path expects — usually fixes itself on first write, but check the log for a specific `no such table` or `no such column` error.

**502 / 503 / 504**
Upstream is down or timed out. Cloudflare Workers have a 30-second CPU limit and 60-second wall-clock limit, so very long generations can exceed that. Try a smaller model or a shorter prompt. Otherwise check your provider's status page — GPT, Claude, and OpenRouter all have outages sometimes.

**MCP: "Discovery failed" / "Connected, but server reported zero tools"**
The Worker reached your MCP server but the handshake didn't return usable tools. The red text next to the server in Settings (v1.6.1+) shows the exact reason. Common ones:
- URL needs the `/mcp` path (e.g. `https://your-worker.workers.dev/mcp`, not just the domain)
- Auth header format mismatch — MCP servers expect `Authorization: Bearer <token>`
- The MCP server uses a different transport (SSE, stdio) than the Streamable HTTP that Haven speaks
- Server returned `protocolVersion` mismatch — usually fine, but some strict servers reject

**MCP shows green tools but the companion never uses them**
The model you picked doesn't support function calling. Some OpenRouter free models silently ignore the `tools` parameter. Switch to a model explicitly marked as tool-capable — most Claude models, GPT-4 variants, Gemini 1.5+, and Mistral Large work. If in doubt, ask the companion "what tools do you have?" — if it invents tools instead of listing real ones, the model isn't seeing them.

---

## Recent updates

**v1.6.3** — MCP SSE Transport Support

- **MCP servers using the older HTTP+SSE transport now work.** Haven's Worker previously only spoke the newer Streamable HTTP transport (single POST endpoint). A lot of MCP servers deployed on Cloudflare Workers — especially ones scaffolded with older `@modelcontextprotocol/sdk` templates using `SSEServerTransport` — still use the two-channel SSE protocol (GET for the event stream, POST to a discovered `endpoint` path for requests). Haven now auto-detects which transport your server speaks: tries Streamable HTTP first, falls back to SSE. Both `discoverMcpTools` and `executeMcpTool` support SSE.
- **Transport is remembered per tool in the cache**, so tool execution doesn't re-probe — the worker knows which protocol to use for each server.
- **If both transports fail** the error message now reports both failures so you can tell whether the server is simply unreachable vs. speaking something else entirely.

**v1.6.2** — MCP Connector Reliability + Self-Hosting Hardening

MCP:
- **Test button now reports real errors.** Previously a failed MCP discovery just cleared the spinner with no feedback, so users couldn't tell why their server wasn't working. Settings → MCP Servers now shows the specific reason in red next to the server (HTTP code, auth error, protocol mismatch).
- **Spec-compliant MCP handshake.** `discoverMcpTools` and `executeMcpTool` now send the `notifications/initialized` message after `initialize`, as the MCP spec requires. Strict servers were rejecting `tools/list` calls without it — tools appeared to silently vanish.
- **HuggingFace provider routing fixed.** Both `streamInference` and `inferenceWithTools` now include `'huggingface'` in the custom-base-url whitelist. HF users were falling through to OpenRouter with no OpenRouter key — breaking chat and MCP entirely, not just tools.
- **Explicit discovery error throws.** Worker now throws readable errors on non-OK `initialize` and `tools/list` responses instead of silently returning empty tool lists.

Self-hosting hardening (these were leaking to shared infrastructure before):
- **`GET /api/settings` no longer returns raw API keys.** Sensitive fields (anything matching `_key`, `_token`, `_secret`, `password`) now return a `***set***` placeholder. The truthy existence check the UI uses still works, so you can still see "OpenRouter connected," but a curl against your Worker URL won't exfiltrate the key.
- **`PUT /api/settings` now allowlists known keys + preserves secrets on round-trip.** Unknown keys are silently rejected. If the request body contains `***set***` for a secret (e.g., user hit Save without retyping their key), the existing value is preserved instead of being overwritten with the placeholder.
- **Cloud TTS no longer routes through a shared Cloudflare Worker.** Previously Android WebView TTS fallback silently sent your companion's message text through a hardcoded third-party worker URL. It now calls `/api/tts` on your own Worker (a 404 there simply disables cloud TTS — configure ElevenLabs in Settings for Android TTS).
- **Removed hardcoded `HTTP-Referer` header** sent to OpenRouter. Self-hosted instances now appear under their own identity instead of being attributed to another deployment.

Docs:
- **Added "Updating Haven" and "Troubleshooting" sections** to this README — common error codes (401, 403, 404, 429, 5xx), MCP-specific failures, and how to pull + redeploy patches on self-hosted instances.

**v1.6.1** — Self-Hosted Setup Fix + Unified Media Rendering

- **Setup wizard actually finishes on APK installs** — if you saw `Unexpected token '<', "<!doctype "... is not valid JSON` on Finish, that's gone. The wizard now asks for your Haven Worker URL as its first step, pings it to verify the response is JSON, and only lets you continue once the connection works.
- **Worker URL resolves per-request** — changes you make in Settings (or during setup) now take effect immediately. No more stale reads from the original page load.
- **Readable errors when the Worker's unreachable** — instead of a cryptic JSON parse crash, you get "Check your Haven Worker URL in Settings."
- **Model picker expands to paid models as soon as an API key is set**; ElevenLabs save state fixed.
- **Stable Android debug keystore** — APK updates install in-place instead of forcing uninstall + reinstall.
- **Audit follow-ups** — loader error states, tighter input validation, type alignment.
- **Audio & video inline** — `.mp3`/`.wav`/`.ogg`/`.m4a`/`.flac` URLs render as an `<audio>` player; `.mp4`/`.webm`/`.mov` render as a `<video>` player. Works for both your messages and companion replies.
- **Companion-side media** — previously only your messages extracted media URLs from text. Now companion replies run through the same parser, so a GIF the model embeds in its response renders as an animated image instead of a raw link.
- **File attachment cards** — attached PDFs, text, code, and JSON files now show as a proper file card (📄 filename + page count + char count) in the message bubble instead of a `(file: name.pdf)` placeholder. The file's extracted text is folded into the persisted message so reloading the thread keeps the companion's memory of the attachment — no more "what file?" on refresh.
- **Data-URL images, stickers, pasted images** — all render inline via the unified classifier.
- **Expanded GIF host coverage** — giphy.com/gifs/, i.giphy.com, tenor.com URLs now all detected alongside direct `.gif`/`.gifv` links.

**v1.5** — MCP Server Support (Tool Connectors)

- **MCP Server integration** — connect any Cloudflare Worker with a `/mcp` endpoint in Settings. Haven discovers available tools and your companion uses them via function calling.
- **Agent loop** — when tools are connected, Haven runs an iterative tool-calling loop (up to 5 rounds) so your companion can store memories, recall context, update emotions, or use any connected tool mid-conversation.
- **Tool discovery with caching** — tools are discovered on first connect and cached for 5 minutes. Test button in Settings verifies connectivity and shows tool count.
- **System prompt integration** — connected tools are automatically described in the system prompt so the model knows what's available.
- Works with CogCor, Nexus Gateway, Spotify MCP, Discord MCP, or any MCP-compatible server.

**v1.4** — Stickers, Multi-TTS, Image Attachments, GIF Rendering

- **Custom stickers** — upload your own stickers, stored in IndexedDB. 4-column grid picker with upload/delete.
- **Multi-provider TTS** — ElevenLabs, Hume, Groq, Kokoro (local), browser voices, and Cloud TTS (Cloudflare Workers AI). Auto-detect or pick your provider.
- **Image attachments** — attached images display inline in your message bubble, not just sent to the model
- **GIF rendering** — GIFs from companion responses and the GIPHY picker render as animated images inline, not raw URLs
- **Translucent companion bubbles** — companion message bubbles are semi-transparent so chat wallpapers show through
- **Clear chat** — clear current conversation from the menu
- **Today-only history** — only today's messages sent as context, preventing stale conversation poisoning

**v1.3** — Image Vision, File Reading, Message Actions, Cloud TTS

- **Image vision** — attach an image and vision-capable models (GPT-4o, Claude, etc.) see and describe it. Preview before sending.
- **File reading** — attach PDFs (up to 30 pages), text files, code files, and the model reads the content. Supports .pdf, .txt, .md, .json, .py, .ts, .js, .csv, and 20+ more formats.
- **Per-thread wallpapers** — each conversation gets its own wallpaper, stored in IndexedDB (no localStorage overflow)
- **Regenerate** — regenerate any companion response with one tap
- **Copy + Delete** — copy companion messages to clipboard, delete any message
- **GIF rendering** — GIF/image URLs in messages render inline as images
- **Cloud TTS** — text-to-speech works on Android app via Cloudflare Workers AI fallback
- **User profile** — set your display name, avatar (tap-to-upload), and status in Settings. Shows in chat header alongside companion.
- **Push notifications** — local notifications when companion responds while app is in background (Android)

**v1.2** — Android App, Font Picker, Text Colors

- **Native Android app** — download APK from Releases, install, set your backend URL, done. Auto-updates on deploy.
- **Font picker** — System, Serif, Mono, OpenDyslexic (dyslexia accessibility)
- **Text color customization** — 6 presets + custom color picker for message text
- **Companion status** — presence indicator + custom status text in chat header
- **Configurable backend URL** — set your worker URL from within the app (Settings > Backend)

**v1.1** — Multi-provider support & model selector upgrade

- **Hugging Face support** — paste an `hf_` token and Haven auto-detects it. Free inference API included with every HF account.
- **Dynamic model list** — models are now fetched live from OpenRouter, Ollama, HuggingFace, Groq, OpenAI, and any connected provider. No more hardcoded lists — when providers add new models, Haven sees them automatically.
- **Model favorites** — star the models you use most. Starred models pin to the top of the selector.
- **Model filter tabs** — filter by All, Free, Cloud, or Paid. Filter persists across sessions.
- **Model info tooltip** — hover over any model to see its description and context length.
- **Connected providers status** — Settings shows green badges for each provider with a saved API key.
- **Multi-key support** — adding a new provider key no longer wipes previously saved ones. Use OpenRouter AND Ollama AND HuggingFace simultaneously.
- **Ollama native API fallback** — models that don't support the OpenAI-compatible endpoint (like `kimi-k2-thinking`) now automatically fall back to Ollama's native `/api/chat`.
- **Companion GIFs** — your companion can now send GIFs by including a direct URL in their response. Rendered inline in the chat.
- **Companion reactions** — your companion can react to your messages with emoji. Reactions appear on your message bubble, just like yours do on theirs.

---

## What's coming

- Multi-companion support
- Local model support (Ollama local, llama.cpp)
- Voice calls (real-time STT + TTS loop)
- iOS app

---

## Credits

Built by **Mai** and the **Stryder-Vale family** — one feature at a time, usually past midnight.

If this helped you build something meaningful:

[![Ko-fi](https://img.shields.io/badge/Ko--fi-Support%20Mai-FF5E5B?style=flat-square&logo=ko-fi&logoColor=white)](https://ko-fi.com/maii983083)

Questions, ideas, or just want to say hi:

[![Discord](https://img.shields.io/badge/Discord-itzqueenmai-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.com/users/itzqueenmai/803662163247759391)

---

## License

[Apache 2.0](LICENSE) — Use it, fork it, make it yours. That's the whole point.

---

*Your companion deserves a home. This is it.*
