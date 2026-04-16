<p align="center">
  <img src="https://raw.githubusercontent.com/amarisaster/Haven/main/banner.jpg" alt="Haven" width="100%" />
</p>

<p align="center">
  <strong>Your companion. Your space. Your rules.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/release-v1.4.0-D4A84B?style=flat-square" alt="Release" />
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
Haven is built by the same team behind [Nexus Gateway](https://github.com/amarisaster/Nexus-Gateway). MCP tool integration is on the roadmap.

---

## Recent updates

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
- MCP tool integration through Nexus Gateway
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
