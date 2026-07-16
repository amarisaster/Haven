import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { streamCodex } from './stream-codex.mjs';

const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_BACKOFF_MS = 30_000;

function value(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function parseDotEnv(source) {
  const parsed = {};
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line);
    if (!match) continue;
    let entry = match[2].trim();
    if ((entry.startsWith('"') && entry.endsWith('"'))
      || (entry.startsWith("'") && entry.endsWith("'"))) {
      entry = entry.slice(1, -1);
    } else {
      entry = entry.replace(/\s+#.*$/u, '').trim();
    }
    parsed[match[1]] = entry;
  }
  return parsed;
}

export function loadEnvFile(file, env = process.env) {
  if (!existsSync(file)) return false;
  const parsed = parseDotEnv(readFileSync(file, 'utf8'));
  for (const [key, entry] of Object.entries(parsed)) {
    if (env[key] === undefined) env[key] = entry;
  }
  return true;
}

export function readConfig(env = process.env) {
  const havenUrlText = value(env.HAVEN_URL);
  const connectorToken = value(env.CODEX_CONNECTOR_TOKEN);
  const workspace = value(env.CODEX_WORKSPACE);
  const codexBin = value(env.CODEX_BIN);
  const timeoutText = value(env.CODEX_TIMEOUT_MS);
  const timeoutMs = timeoutText === undefined ? DEFAULT_TIMEOUT_MS : Number(timeoutText);

  if (!havenUrlText) throw new Error('HAVEN_URL is required.');
  const havenUrl = new URL(havenUrlText);
  if (havenUrl.protocol !== 'https:') throw new Error('HAVEN_URL must be an https base URL.');
  if (!connectorToken) throw new Error('CODEX_CONNECTOR_TOKEN is required.');
  if (!workspace || !isAbsolute(workspace)) throw new Error('CODEX_WORKSPACE must be an absolute path.');
  if (!codexBin || !isAbsolute(codexBin)) throw new Error('CODEX_BIN must be an absolute path.');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('CODEX_TIMEOUT_MS must be a positive finite number.');
  }

  return {
    havenUrl: havenUrl.toString(),
    connectorToken,
    workspace: resolve(workspace),
    codexBin,
    timeoutMs,
  };
}

export function bridgeUrl(havenUrl) {
  const url = new URL('/api/codex/bridge', havenUrl);
  url.protocol = 'wss:';
  return url.toString();
}

export function validateRevertPaths(workspace, paths) {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error('revert paths must be a non-empty array.');
  }

  return paths.map((path) => {
    if (!value(path)) throw new Error('revert paths must contain non-empty strings.');
    const target = resolve(workspace, path);
    const localPath = relative(workspace, target);
    if (!localPath || localPath === '..' || localPath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(localPath)) {
      throw new Error(`revert path escapes CODEX_WORKSPACE: ${path}`);
    }
    return localPath.replaceAll('\\', '/');
  });
}

/**
 * Build a `-c mcp_servers={...}` override from Haven's enabled MCP servers.
 * The override REPLACES the machine's own ~/.codex MCP config for the run —
 * the Codex lane sees exactly the toolbelt Haven manages, nothing else
 * (Mai's call, 2026-07-15). Bearer keys travel as env vars, never in argv.
 * Always returns an override (empty {} when no servers) so the machine
 * config can never leak into the Haven lane.
 */
export function buildMcpOverride(servers) {
  const entries = [];
  const env = {};
  const described = [];
  let index = 0;

  for (const server of Array.isArray(servers) ? servers : []) {
    const url = value(server?.url);
    if (!url || !/^https?:\/\//iu.test(url)) continue;
    const name = (value(server?.name) ?? `server${index}`)
      .replace(/[^A-Za-z0-9_-]/gu, '_')
      .slice(0, 64) || `server${index}`;
    const fields = [`url = ${JSON.stringify(url)}`];
    const key = value(server?.api_key);
    let envVar;
    if (key) {
      envVar = `CODEX_MCP_BEARER_${index}`;
      env[envVar] = key;
      fields.push(`bearer_token_env_var = ${JSON.stringify(envVar)}`);
    }
    described.push({ name, url, envVar });
    entries.push(`${JSON.stringify(name)} = { ${fields.join(', ')} }`);
    index += 1;
  }

  return { configArg: `mcp_servers={ ${entries.join(', ')} }`, env, described };
}

/**
 * Conductor capability: if this machine ALSO has Claude Code installed and
 * authenticated, Codex may hire it for bounded subtasks (the two-subscription
 * team-up). Detected once per daemon lifetime, never assumed.
 */
let conductorChecked = false;
let conductorAvailable = false;
export function detectClaudeCode(runCheck = spawnSync) {
  if (conductorChecked) return conductorAvailable;
  conductorChecked = true;
  try {
    const found = runCheck('where.exe', ['claude'], { encoding: 'utf8', windowsHide: true });
    conductorAvailable = found.status === 0 && Boolean(value(found.stdout));
  } catch {
    conductorAvailable = false;
  }
  return conductorAvailable;
}

/**
 * Per-companion workspace folder under the root — an isolation BOUNDARY, not
 * housekeeping (Mai, 2026-07-15): one companion's Codex must not see another's
 * work products. No companion id → the root itself (bare test runs).
 */
export function deriveWorkspace(root, companionId, companionName) {
  if (companionId === undefined || companionId === null || companionId === '') return root;
  const name = (value(companionName) ?? 'companion')
    .replace(/[^A-Za-z0-9_-]/gu, '_')
    .slice(0, 40)
    .replace(/^_+|_+$/gu, '') || 'companion';
  return resolve(root, `${name}-${String(companionId).replace(/[^A-Za-z0-9-]/gu, '_')}`);
}

export function composePrompt(systemPrompt, prompt) {
  const userPrompt = value(prompt);
  if (!userPrompt) throw new Error('prompt must be a non-empty string.');
  const system = value(systemPrompt);
  return system ? `${system}\n\n${userPrompt}` : userPrompt;
}

export function eventEnvelope(requestId, event) {
  return {
    type: 'event',
    requestId,
    payload: { kind: event.kind, data: event.data ?? {} },
  };
}

function restoreUnsupported(result) {
  const output = `${result.stderr ?? ''}\n${result.stdout ?? ''}`;
  return /(?:not a git command|unknown (?:command|subcommand)|unknown option).*restore|restore.*(?:not a git command|unknown)/iu.test(output);
}

export class BridgeDaemon {
  constructor({
    config,
    WebSocketImpl,
    stream = streamCodex,
    runGit = spawnSync,
    logger = console.log,
    random = Math.random,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    sessionFile,
  }) {
    this.config = config;
    if (!WebSocketImpl) throw new TypeError('WebSocketImpl is required.');
    this.WebSocketImpl = WebSocketImpl;
    this.stream = stream;
    this.runGit = runGit;
    this.logger = logger;
    this.random = random;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.socket = null;
    this.active = null;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.stopped = false;
    // One Codex session per Haven thread: the identity/context load happens on
    // the first run, follow-ups resume it. Persisted so a daemon restart
    // doesn't cold-start every thread.
    this.sessionFile = sessionFile;
    this.sessions = new Map();
    if (sessionFile && existsSync(sessionFile)) {
      try {
        this.sessions = new Map(Object.entries(JSON.parse(readFileSync(sessionFile, 'utf8'))));
      } catch {
        // Corrupt map just means cold starts; not fatal.
      }
    }
  }

  #saveSessions() {
    if (!this.sessionFile) return;
    try {
      writeFileSync(this.sessionFile, JSON.stringify(Object.fromEntries(this.sessions)));
    } catch (error) {
      this.log('error', `session map save failed: ${error.message}`);
    }
  }

  log(kind, message) {
    this.logger(`[${new Date().toISOString()}] ${kind} ${message}`);
  }

  connect() {
    if (this.stopped) return;
    this.log('connect', `opening ${bridgeUrl(this.config.havenUrl)}`);
    const socket = new this.WebSocketImpl(bridgeUrl(this.config.havenUrl), {
      headers: { 'X-Codex-Connector-Token': this.config.connectorToken },
    });
    this.socket = socket;

    socket.on('open', () => {
      this.reconnectAttempt = 0;
      this.log('connect', 'connected');
      // Heartbeat: the edge silently drops idle WebSockets, leaving this side
      // half-open (thinks it's connected, relay says offline). Ping every 25s;
      // no pong within 10s → kill the socket so the reconnect loop fires.
      if (typeof socket.ping === 'function') {
        let awaitingPong = false;
        socket.on('pong', () => { awaitingPong = false; });
        const heartbeat = setInterval(() => {
          if (socket.readyState !== this.WebSocketImpl.OPEN) { clearInterval(heartbeat); return; }
          if (awaitingPong) {
            this.log('connect', 'heartbeat lost — terminating half-open socket');
            clearInterval(heartbeat);
            socket.terminate?.();
            return;
          }
          awaitingPong = true;
          socket.ping();
        }, 25000);
        heartbeat.unref?.();
        socket.once('close', () => clearInterval(heartbeat));
      }
    });
    socket.on('message', (raw) => {
      void this.handleRaw(raw);
    });
    socket.on('error', (error) => {
      this.log('error', `websocket ${error.message}`);
    });
    socket.on('close', (code) => {
      if (this.socket === socket) this.socket = null;
      this.log('connect', `closed code=${code}`);
      this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const base = Math.min(1_000 * (2 ** this.reconnectAttempt), MAX_BACKOFF_MS);
    const delay = Math.round(base * (0.75 + this.random() * 0.5));
    this.reconnectAttempt += 1;
    this.log('connect', `retry in ${delay}ms`);
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) this.clearTimer(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.active) this.active.controller.abort();
    this.socket?.close();
  }

  send(requestId, event) {
    if (!this.socket || this.socket.readyState !== this.WebSocketImpl.OPEN) return false;
    this.socket.send(JSON.stringify(eventEnvelope(requestId, event)));
    return true;
  }

  async handleRaw(raw) {
    let envelope;
    try {
      envelope = JSON.parse(raw.toString());
    } catch (error) {
      this.log('error', `invalid envelope: ${error.message}`);
      return;
    }
    await this.handleEnvelope(envelope);
  }

  #gitIdentity() {
    return ['-c', 'user.email=bridge@haven.local', '-c', 'user.name=codex-bridge'];
  }

  /** Create + git-init the companion's folder on first use. */
  #ensureWorkspace(workspace) {
    if (workspace !== this.config.workspace && !existsSync(workspace)) {
      mkdirSync(workspace, { recursive: true });
    }
    if (!existsSync(resolve(workspace, '.git'))) {
      this.runGit('git', ['-C', workspace, 'init', '-q'], { encoding: 'utf8', windowsHide: true });
      this.runGit('git', [...this.#gitIdentity(), '-C', workspace, 'commit', '-q', '--allow-empty', '-m', 'workspace created'], { encoding: 'utf8', windowsHide: true });
    }
    return workspace;
  }

  /** Resolve the companion's folder, creating it on first use. */
  #workspaceFor(payload) {
    return this.#ensureWorkspace(
      deriveWorkspace(this.config.workspace, payload?.companionId, payload?.companionName),
    );
  }

  /**
   * Snapshot before a code-gear run so "revert" means "back to before this
   * run": edits restore to the snapshot, brand-new files stay untracked and
   * fall to the git-clean lane.
   */
  #snapshot(workspace) {
    this.runGit('git', ['-C', workspace, 'add', '-A'], { encoding: 'utf8', windowsHide: true });
    this.runGit('git', [...this.#gitIdentity(), '-C', workspace, 'commit', '-q', '-m', 'pre-run snapshot'], { encoding: 'utf8', windowsHide: true });
  }

  async handleEnvelope(envelope) {
    const requestId = value(envelope?.requestId);
    if (!requestId) {
      this.log('error', 'envelope missing requestId');
      return;
    }

    if (envelope.type === 'approve') {
      this.log('approve', `requestId=${requestId} ignored`);
      return;
    }
    if (envelope.type === 'cancel') {
      if (this.active?.requestId === requestId) {
        this.active.cancelled = true;
        this.active.controller.abort();
        this.send(requestId, { kind: 'done', data: { cancelled: true } });
        this.log('done', `requestId=${requestId} cancelled`);
      }
      return;
    }
    if (envelope.type !== 'run') {
      this.log('error', `requestId=${requestId} unsupported type=${envelope.type}`);
      return;
    }

    if (this.active) {
      this.send(requestId, { kind: 'error', data: { message: 'busy' } });
      this.log('error', `requestId=${requestId} busy`);
      return;
    }

    const controller = new AbortController();
    const token = { requestId, controller, cancelled: false };
    this.active = token;
    this.log('run', `requestId=${requestId} mode=${envelope.payload?.mode ?? 'chat'}`);

    try {
      if (envelope.payload?.mode === 'revert') {
        this.runRevert(requestId, envelope.payload);
      } else {
        await this.runCodex(requestId, envelope.payload ?? {}, token);
      }
    } catch (error) {
      if (!token.cancelled) {
        this.send(requestId, { kind: 'error', data: { message: error.message } });
        this.log('error', `requestId=${requestId} ${error.message}`);
      }
    } finally {
      if (this.active === token) this.active = null;
    }
  }

  /**
   * Pull an attachment from Haven's connector-authed endpoint into the
   * companion's folder. Returns the saved absolute path.
   */
  async #downloadAttachment(workspace, key, name) {
    const safeName = (value(name) ?? 'attachment').replace(/[^A-Za-z0-9._-]/gu, '_').slice(0, 80) || 'attachment';
    const dir = resolve(workspace, 'attachments');
    mkdirSync(dir, { recursive: true });
    const target = resolve(dir, safeName);
    if (!target.startsWith(dir)) throw new Error(`attachment name escapes workspace: ${name}`);

    const url = new URL(`/api/codex/attachment/${key}`, this.config.havenUrl);
    const response = await fetch(url, {
      headers: { 'X-Codex-Connector-Token': this.config.connectorToken },
    });
    if (!response.ok) throw new Error(`attachment fetch failed (${response.status}): ${key}`);
    writeFileSync(target, Buffer.from(await response.arrayBuffer()));
    return target;
  }

  /**
   * Haven file messages arrive as bare /api/files/<key> URLs in the prompt
   * text. Codex can't fetch those (bearer-gated) — pull each into the
   * workspace and hand Codex the local path instead.
   */
  async #localizeFileUrls(workspace, prompt, images) {
    const base = this.config.havenUrl.replace(/\/$/u, '');
    const pattern = /https?:\/\/[^\s)"']+\/api\/files\/([A-Za-z0-9._/-]+)/gu;
    let result = prompt;
    for (const match of [...prompt.matchAll(pattern)]) {
      if (!match[0].startsWith(base)) continue; // only OUR Haven's files
      const key = match[1];
      const path = await this.#downloadAttachment(workspace, key, key.split('/').pop());
      // Image-typed files (custom emoji, stickers, pictures) belong in the
      // model's EYES (-i), not just its filing cabinet.
      const isImage = /\.(?:gif|png|jpe?g|webp|bmp)$/iu.test(path);
      if (isImage && Array.isArray(images)) images.push(path);
      result = result.replace(match[0], isImage
        ? `[image attached: ${path.split(/[\\/]/u).pop()}]`
        : `attachments/${path.split(/[\\/]/u).pop()} (saved locally in your workspace)`);
      this.log('attachment', `${isImage ? 'image-file' : 'file'} ${key} -> ${path}`);
    }
    return result;
  }

  /**
   * External image/GIF URLs in the prompt (Haven's GIF picker sends bare
   * giphy/tenor links) are invisible to the model and unfetchable from the
   * sandbox. Download them here (5MB cap each, max 4) and return local paths
   * to pass as -i vision attachments.
   */
  async #localizeImageUrls(workspace, prompt) {
    const pattern = /https?:\/\/[^\s)"'<>]+?\.(?:gif|png|jpe?g|webp)(?:\?[^\s)"'<>]*)?|https?:\/\/(?:media[0-9]*\.giphy\.com|[a-z0-9.]*tenor\.com)\/[^\s)"'<>]+/giu;
    const paths = [];
    for (const match of [...new Set(prompt.match(pattern) ?? [])].slice(0, 4)) {
      try {
        const response = await fetch(match, { signal: AbortSignal.timeout(15000) });
        if (!response.ok) continue;
        const type = response.headers.get('content-type') ?? '';
        if (!type.startsWith('image/')) continue;
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > 5 * 1024 * 1024) continue;
        const ext = type.includes('gif') ? 'gif' : type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg';
        const dir = resolve(workspace, 'attachments');
        mkdirSync(dir, { recursive: true });
        const target = resolve(dir, `inline-${paths.length}-${Date.now() % 100000}.${ext}`);
        writeFileSync(target, bytes);
        paths.push(target);
        this.log('attachment', `inline image ${match.slice(0, 80)} -> ${target}`);
      } catch {
        // Unreachable/slow URL: the model just won't see this one.
      }
    }
    return paths;
  }

  async runCodex(requestId, payload, token) {
    const sessionKey = value(payload.threadKey)
      ?? (payload.companionId !== undefined ? `companion:${payload.companionId}` : undefined);
    const requestedModel = value(payload.model) ?? '';
    // Session entries are {id, model} (older files stored a bare id string —
    // normalize on read). Resuming a session under a DIFFERENT model wedges
    // the run (observed live 2026-07-16), so a model change forces a fresh
    // session instead: one wake's cost, no hang.
    const storedRaw = sessionKey ? this.sessions.get(sessionKey) : undefined;
    const stored = typeof storedRaw === 'string' ? { id: storedRaw, model: '' } : storedRaw;
    let resumeThreadId = stored?.id;
    if (stored && (stored.model ?? '') !== requestedModel) {
      this.log('session', `${sessionKey} model changed ('${stored.model || 'default'}' -> '${requestedModel || 'default'}') — fresh session`);
      this.sessions.delete(sessionKey);
      this.#saveSessions();
      resumeThreadId = undefined;
    }
    // On a resumed session the identity context is already loaded — resending
    // the full system prompt each turn re-burns tokens for nothing.
    // Known upstream bug (openai/codex #24135): in exec mode every MCP tool
    // call is auto-cancelled ("user cancelled MCP tool call") and no config
    // suppresses it. Shell HTTP works fine from the sandbox — tell the model
    // once per session, WITH the server addresses (bearer keys stay out of
    // the prompt; they're readable in the shell as env vars).
    const mcp = buildMcpOverride(payload.mcpServers);
    const serverLines = mcp.described.map((server) => `- ${server.name}: ${server.url}`
      + (server.envVar ? ` (send header "Authorization: Bearer $env:${server.envVar}" — the value is in that environment variable)` : ''));
    const engineNote = '\n\n[Engine note: MCP tool calls are auto-cancelled by this engine (known bug). '
      + 'Do not use MCP tools. Call your tool servers directly over HTTP from the shell instead — '
      + 'JSON-RPC 2.0 POST, method "tools/call", params {"name": "<tool>", "arguments": {...}}.'
      + (serverLines.length > 0 ? ` Your tool servers:\n${serverLines.join('\n')}` : '')
      + '\nTo update YOUR HAVEN header status (separate from any other status system): '
      + 'POST $env:HAVEN_URL/api/codex/status with header "X-Codex-Connector-Token: $env:HAVEN_CONNECTOR_TOKEN" '
      + `and JSON body {"companionId": ${Number(payload.companionId) || 0}, "custom_status": "...", "presence": "online|away|busy|offline"}.`
      + (detectClaudeCode()
        ? '\nThis machine also has Claude Code installed. For a large bounded subtask you may hire it: '
          + 'run `claude -p "<precise task>"` in a subfolder of your workspace and review its output. Use sparingly — it bills its own subscription.'
        : '')
      + ']';
    let prompt = resumeThreadId
      ? composePrompt(undefined, payload.prompt)
      : composePrompt(payload.systemPrompt, payload.prompt) + engineNote;
    let terminal = false;
    let sawError = false;
    const workspace = this.#workspaceFor(payload);
    if (payload.gear === 'code') this.#snapshot(workspace);

    const model = value(payload.model)?.replace(/[^A-Za-z0-9._:-]/gu, '');
    const images = [];
    for (const attachment of Array.isArray(payload.attachments) ? payload.attachments : []) {
      const key = value(attachment?.key);
      if (!key || !/^[A-Za-z0-9._/-]+$/u.test(key)) continue;
      const path = await this.#downloadAttachment(workspace, key, attachment?.name ?? key.split('/').pop());
      if (attachment?.type === 'image') images.push(path);
      else prompt += `\n\n[Attached file saved at attachments/${path.split(/[\\/]/u).pop()}]`;
      this.log('attachment', `${attachment?.type ?? 'file'} ${key} -> ${path}`);
    }
    prompt = await this.#localizeFileUrls(workspace, prompt, images);
    images.push(...await this.#localizeImageUrls(workspace, prompt));
    if (images.length > 0) {
      prompt += '\n\n[The image(s) in this message are attached to this prompt — you can see them directly.]';
    }
    const result = await this.stream({
      prompt,
      cwd: workspace,
      sandbox: payload.gear === 'code' ? 'workspace-write' : 'read-only',
      timeoutMs: this.config.timeoutMs,
      signal: token.controller.signal,
      configOverrides: [mcp.configArg],
      env: {
        ...mcp.env,
        HAVEN_URL: this.config.havenUrl.replace(/\/$/u, ''),
        HAVEN_CONNECTOR_TOKEN: this.config.connectorToken,
      },
      model,
      images,
      resumeThreadId,
      onThreadId: (threadId) => {
        if (!sessionKey) return;
        const current = this.sessions.get(sessionKey);
        if (current && typeof current === 'object' && current.id === threadId && (current.model ?? '') === requestedModel) return;
        this.sessions.set(sessionKey, { id: threadId, model: requestedModel });
        this.#saveSessions();
        this.log('session', `${sessionKey} -> ${threadId}${requestedModel ? ` (model ${requestedModel})` : ''}`);
      },
      onEvent: async (event) => {
        if (token.cancelled) return;
        // Option A (no live approval gate): command executions are
        // informational. Forwarding command_approval would pause the relay
        // forever waiting for an approve that the UI never sends.
        if (event.kind === 'command_approval') {
          const command = event.data?.command ?? '';
          // Tagged so the app can fold commands into a collapsible pill.
          this.send(requestId, { kind: 'message', data: { text: `<codex-cmd>${command}</codex-cmd>` } });
          return;
        }
        // Codex emits bare error events for TRANSIENT stream hiccups
        // ("Reconnecting... 2/5 (request timed out)") while it keeps working.
        // Terminal-izing those kills the client's stream mid-run (live bug,
        // 2026-07-16). Forward them as folded engine chatter instead.
        if (event.kind === 'error' && /reconnect|retry|request timed out/iu.test(String(event.data?.message ?? ''))) {
          this.log('engine-notice', `requestId=${requestId} ${String(event.data?.message).slice(0, 200)}`);
          this.send(requestId, { kind: 'message', data: { text: `<codex-cmd>engine: ${event.data.message}</codex-cmd>` } });
          return;
        }
        if (event.kind === 'done' || event.kind === 'error') terminal = true;
        if (event.kind === 'error') {
          sawError = true;
          this.log('error-detail', `requestId=${requestId} ${JSON.stringify(event.data ?? {}).slice(0, 400)}`);
        }
        this.send(requestId, event);
      },
    });
    if (token.cancelled) return;
    if (resumeThreadId && result?.ok === false) {
      // Stale session id (purged/expired) — forget it so the NEXT message
      // cold-starts cleanly instead of failing on every resume.
      this.sessions.delete(sessionKey);
      this.#saveSessions();
      this.log('session', `${sessionKey} stale, dropped`);
    }
    if (!terminal && result?.ok === false) {
      throw new Error(result.errors?.[0] ?? 'Codex run failed.');
    }
    if (sawError || result?.ok === false) {
      this.log('error', `requestId=${requestId} ${result?.errors?.[0] ?? 'Codex run failed'}`);
      return;
    }
    this.log('done', `requestId=${requestId} ok=${result?.ok !== false}`);
  }

  runRevert(requestId, payload) {
    // Validate BEFORE ensuring: a rejected request must not create folders
    // or touch git.
    const workspace = deriveWorkspace(this.config.workspace, payload?.companionId, payload?.companionName);
    const localPaths = validateRevertPaths(workspace, payload?.paths);
    this.#ensureWorkspace(workspace);

    // A path Codex ADDED is untracked — restore/checkout can't touch it; the
    // revert of an add is removing the file (git clean keeps us in git-land
    // and inside the workspace). Tracked paths rewind via restore/checkout.
    const tracked = [];
    const untracked = [];
    for (const path of localPaths) {
      const check = this.runGit('git', [
        '-C', workspace, 'ls-files', '--error-unmatch', '--', path,
      ], { encoding: 'utf8', windowsHide: true });
      (check.status === 0 ? tracked : untracked).push(path);
    }

    const results = [];
    if (tracked.length > 0) {
      let result = this.runGit('git', [
        '-C', workspace, 'restore', '--worktree', '--staged', '--', ...tracked,
      ], { encoding: 'utf8', windowsHide: true });
      if (result.status !== 0 && restoreUnsupported(result)) {
        result = this.runGit('git', [
          '-C', workspace, 'checkout', '--', ...tracked,
        ], { encoding: 'utf8', windowsHide: true });
      }
      results.push(result);
    }
    if (untracked.length > 0) {
      results.push(this.runGit('git', [
        '-C', workspace, 'clean', '-f', '--', ...untracked,
      ], { encoding: 'utf8', windowsHide: true }));
    }

    for (const result of results) {
      if (result.error) throw new Error(`git revert failed: ${result.error.message}`);
      if (result.status !== 0) {
        const detail = value(result.stderr) ?? value(result.stdout) ?? `exit code ${result.status}`;
        throw new Error(`git revert failed: ${detail}`);
      }
    }

    for (const path of localPaths) {
      this.send(requestId, { kind: 'file_change', data: { path, changeType: 'reverted' } });
    }
    this.send(requestId, { kind: 'done', data: {} });
    this.log('done', `requestId=${requestId} reverted=${localPaths.length}`);
  }
}

function envFileFromArgs(argv) {
  const index = argv.indexOf('--env-file');
  if (index === -1) return resolve('.env');
  if (!argv[index + 1]) throw new Error('--env-file requires a path.');
  return resolve(argv[index + 1]);
}

export async function main(argv = process.argv.slice(2)) {
  loadEnvFile(envFileFromArgs(argv));
  const config = readConfig();
  process.env.CODEX_BIN = config.codexBin;
  const { default: WebSocketImpl } = await import('ws');
  const daemon = new BridgeDaemon({ config, WebSocketImpl, sessionFile: resolve('sessions.json') });
  daemon.connect();
  return daemon;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    await main();
  } catch (error) {
    console.error(`[${new Date().toISOString()}] error ${error.message}`);
    process.exitCode = 1;
  }
}
