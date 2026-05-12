/**
 * Haven — Chat Bridge Worker
 * Handles inference (Ollama/OpenRouter), D1 persistence, and CI loading
 */

interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  OPENROUTER_API_KEY?: string;
  OLLAMA_URL?: string;
}

function getCorsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('Origin') || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Companion-Id, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

let _cors: Record<string, string> = {};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ..._cors },
  });
}

// Auth token cache — avoids D1 read on every request
let _authToken: string | null | undefined = undefined;
async function getAuthToken(db: D1Database): Promise<string | null> {
  if (_authToken !== undefined) return _authToken;
  _authToken = await getSettingValue(db, 'auth_token') || null;
  return _authToken;
}
function invalidateAuthTokenCache() { _authToken = undefined; }

async function ensureReactionsColumn(db: D1Database) {
  try { await db.prepare("ALTER TABLE messages ADD COLUMN reactions TEXT").run(); } catch { /* already exists */ }
}

// Which companion the current request operates on. Frontend sends
// X-Companion-Id on every scoped request; falls back to 1 (the default seed
// companion) so pre-v1.7 frontends keep working unchanged.
function getCompanionId(request: Request): number {
  const raw = request.headers.get('x-companion-id');
  const n = raw ? Number(raw) : 1;
  return Number.isFinite(n) && n > 0 ? n : 1;
}

// ============================================================
// MCP — tool discovery and execution
// ============================================================

interface McpServer {
  id: number;
  name: string;
  url: string;
  api_key: string | null;
  enabled: number;
  tools_cache: string | null;
  last_discovered: string | null;
}

interface McpTool {
  name: string;
  description: string;
  inputSchema: any;
  server_id: number;
  server_url: string;
  server_key: string | null;
  // Which MCP transport this server uses. Omitted for tools cached before
  // v1.6.3 — those default to 'streamable' at the use sites.
  transport?: 'streamable' | 'sse';
}

// ---- SSE helpers ----

type SSEEvent = { event: string; data: string };

function parseSSEBuffer(buffer: string): { events: SSEEvent[]; remaining: string } {
  const events: SSEEvent[] = [];
  // Events are separated by blank lines. SSE technically allows \r\n\r\n too;
  // normalize first.
  const normalized = buffer.replace(/\r\n/g, '\n');
  const parts = normalized.split('\n\n');
  const remaining = parts.pop() || '';
  for (const part of parts) {
    let evName = 'message';
    const dataLines: string[] = [];
    for (const line of part.split('\n')) {
      if (line.startsWith('event:')) evName = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
      // We ignore id: and retry: for our purposes.
    }
    if (dataLines.length > 0) events.push({ event: evName, data: dataLines.join('\n') });
  }
  return { events, remaining };
}

async function readSSEUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  initialBuffer: string,
  predicate: (event: SSEEvent) => boolean,
  timeoutMs = 15000,
): Promise<{ event: SSEEvent; buffer: string }> {
  let buffer = initialBuffer;
  // First, check if the initial buffer already contains a match.
  {
    const { events, remaining } = parseSSEBuffer(buffer);
    buffer = remaining;
    for (const ev of events) {
      if (predicate(ev)) return { event: ev, buffer };
    }
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) throw new Error('SSE stream closed before expected event');
    buffer += decoder.decode(value, { stream: true });
    const { events, remaining } = parseSSEBuffer(buffer);
    buffer = remaining;
    for (const ev of events) {
      if (predicate(ev)) return { event: ev, buffer };
    }
  }
  throw new Error(`SSE read timeout after ${timeoutMs}ms`);
}

// MCP 2025-03-26 streamable HTTP lets servers pick their response format per
// request — either `application/json` with the JSON-RPC payload as body, or
// `text/event-stream` with the payload inside a single SSE data event. This
// helper unwraps whichever the server sent.
async function parseStreamableResponse(resp: Response): Promise<any> {
  const contentType = resp.headers.get('content-type') || '';
  if (contentType.includes('text/event-stream')) {
    const text = await resp.text();
    // Pad with a blank line so parseSSEBuffer flushes the final event.
    const { events } = parseSSEBuffer(text + '\n\n');
    for (const ev of events) {
      try {
        const parsed = JSON.parse(ev.data);
        if (parsed && parsed.jsonrpc === '2.0') return parsed;
      } catch {
        // Non-JSON event — ignore and try the next one.
      }
    }
    throw new Error('streamable SSE response had no JSON-RPC payload');
  }
  return await resp.json();
}

// ---- Streamable HTTP transport (MCP 2024-11-05 spec — single POST endpoint) ----

async function discoverViaStreamableHTTP(server: McpServer): Promise<McpTool[]> {
  // MCP 2025-03-26 streamable HTTP requires the client to advertise BOTH
  // response types it can handle — strict servers (Nexus Gateway) return 406
  // otherwise.
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
  };
  if (server.api_key) headers['Authorization'] = `Bearer ${server.api_key}`;

  const initResp = await fetch(server.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'haven', version: '1.6.4' } },
    }),
  });

  if (!initResp.ok) {
    const errBody = await initResp.text().catch(() => '');
    throw new Error(`streamable initialize ${initResp.status}: ${errBody.slice(0, 200)}`);
  }

  const sessionId = initResp.headers.get('mcp-session-id');
  if (sessionId) headers['mcp-session-id'] = sessionId;

  // MCP spec requires a notifications/initialized message after initialize
  // before any other request. Strict servers reject tools/list without it.
  await fetch(server.url, {
    method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });

  const listResp = await fetch(server.url, {
    method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  });

  if (!listResp.ok) {
    const errBody = await listResp.text().catch(() => '');
    throw new Error(`streamable tools/list ${listResp.status}: ${errBody.slice(0, 200)}`);
  }

  const listData = await parseStreamableResponse(listResp);
  const tools = listData?.result?.tools || [];
  return tools.map((t: any) => ({
    name: t.name,
    description: t.description || '',
    inputSchema: t.inputSchema || { type: 'object', properties: {} },
    server_id: server.id,
    server_url: server.url,
    server_key: server.api_key,
    transport: 'streamable' as const,
  }));
}

async function executeViaStreamableHTTP(
  serverUrl: string, serverKey: string | null, toolName: string, args: Record<string, unknown>,
): Promise<string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
  };
  if (serverKey) headers['Authorization'] = `Bearer ${serverKey}`;

  const initResp = await fetch(serverUrl, {
    method: 'POST', headers,
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'haven', version: '1.6.4' } },
    }),
  });
  const sessionId = initResp.headers.get('mcp-session-id');
  if (sessionId) headers['mcp-session-id'] = sessionId;

  await fetch(serverUrl, {
    method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });

  const resp = await fetch(serverUrl, {
    method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: toolName, arguments: args } }),
  });

  const data = await parseStreamableResponse(resp);
  const content = data?.result?.content || [];
  return content.map((c: any) => c.text || '').join('\n') || JSON.stringify(data?.result || {});
}

// ---- HTTP+SSE transport (older MCP — GET opens event stream, POST sends requests) ----

async function openSSESession(serverUrl: string, serverKey: string | null): Promise<{
  reader: ReadableStreamDefaultReader<Uint8Array>;
  decoder: TextDecoder;
  buffer: string;
  endpointUrl: string;
  postHeaders: Record<string, string>;
}> {
  const sseHeaders: Record<string, string> = { 'Accept': 'text/event-stream' };
  if (serverKey) sseHeaders['Authorization'] = `Bearer ${serverKey}`;

  const sseResp = await fetch(serverUrl, { headers: sseHeaders });
  if (!sseResp.ok || !sseResp.body) {
    const errBody = await sseResp.text().catch(() => '');
    throw new Error(`sse connect ${sseResp.status}: ${errBody.slice(0, 200)}`);
  }
  const contentType = sseResp.headers.get('content-type') || '';
  if (!contentType.includes('text/event-stream')) {
    // Not an SSE endpoint — close and bail
    try { await sseResp.body.cancel(); } catch {}
    throw new Error(`sse expected event-stream, got ${contentType || 'unknown'}`);
  }

  const reader = sseResp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  // The first event from an SSE MCP server is `event: endpoint` with the
  // relative POST path in its data field.
  const endpointRead = await readSSEUntil(
    reader, decoder, buffer,
    (e) => e.event === 'endpoint',
  );
  buffer = endpointRead.buffer;
  const endpointUrl = new URL(endpointRead.event.data.trim(), serverUrl).toString();

  const postHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
  if (serverKey) postHeaders['Authorization'] = `Bearer ${serverKey}`;

  return { reader, decoder, buffer, endpointUrl, postHeaders };
}

async function readSSEJsonRpc(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  buffer: string,
  id: number,
): Promise<{ data: any; buffer: string }> {
  const read = await readSSEUntil(reader, decoder, buffer,
    (e) => {
      try { return JSON.parse(e.data).id === id; } catch { return false; }
    },
  );
  return { data: JSON.parse(read.event.data), buffer: read.buffer };
}

async function discoverViaSSE(server: McpServer): Promise<McpTool[]> {
  const session = await openSSESession(server.url, server.api_key);
  let buffer = session.buffer;
  try {
    // initialize
    await fetch(session.endpointUrl, {
      method: 'POST', headers: session.postHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'haven', version: '1.6.4' } },
      }),
    });
    const initRead = await readSSEJsonRpc(session.reader, session.decoder, buffer, 1);
    buffer = initRead.buffer;

    // notifications/initialized (no response expected)
    await fetch(session.endpointUrl, {
      method: 'POST', headers: session.postHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });

    // tools/list
    await fetch(session.endpointUrl, {
      method: 'POST', headers: session.postHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    const toolsRead = await readSSEJsonRpc(session.reader, session.decoder, buffer, 2);

    const tools = toolsRead.data?.result?.tools || [];
    return tools.map((t: any) => ({
      name: t.name,
      description: t.description || '',
      inputSchema: t.inputSchema || { type: 'object', properties: {} },
      server_id: server.id,
      server_url: server.url,
      server_key: server.api_key,
      transport: 'sse' as const,
    }));
  } finally {
    session.reader.cancel().catch(() => {});
  }
}

async function executeViaSSE(
  serverUrl: string, serverKey: string | null, toolName: string, args: Record<string, unknown>,
): Promise<string> {
  const session = await openSSESession(serverUrl, serverKey);
  let buffer = session.buffer;
  try {
    await fetch(session.endpointUrl, {
      method: 'POST', headers: session.postHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'haven', version: '1.6.4' } },
      }),
    });
    const initRead = await readSSEJsonRpc(session.reader, session.decoder, buffer, 1);
    buffer = initRead.buffer;

    await fetch(session.endpointUrl, {
      method: 'POST', headers: session.postHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });

    await fetch(session.endpointUrl, {
      method: 'POST', headers: session.postHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: toolName, arguments: args } }),
    });
    const callRead = await readSSEJsonRpc(session.reader, session.decoder, buffer, 2);

    const content = callRead.data?.result?.content || [];
    return content.map((c: any) => c.text || '').join('\n') || JSON.stringify(callRead.data?.result || {});
  } finally {
    session.reader.cancel().catch(() => {});
  }
}

// ---- Transport dispatcher ----
//
// Try Streamable HTTP first. If it fails, fall back to SSE. If both fail,
// surface the more diagnostic error so users can tell whether their server
// is reachable at all vs. speaking a different protocol.

async function discoverMcpTools(server: McpServer): Promise<McpTool[]> {
  let streamableErr: unknown;
  try {
    return await discoverViaStreamableHTTP(server);
  } catch (e) {
    streamableErr = e;
  }
  try {
    return await discoverViaSSE(server);
  } catch (sseErr) {
    throw new Error(`streamable http: ${streamableErr}. sse: ${sseErr}`);
  }
}

async function executeMcpTool(
  serverUrl: string, serverKey: string | null, toolName: string,
  args: Record<string, unknown>, transport: 'streamable' | 'sse' = 'streamable',
): Promise<string> {
  if (transport === 'sse') return executeViaSSE(serverUrl, serverKey, toolName, args);
  return executeViaStreamableHTTP(serverUrl, serverKey, toolName, args);
}

function mcpToolsToOpenAI(tools: McpTool[]): any[] {
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

// Haven-native tools — injected into the tool list alongside MCP tools, but
// executed locally by the worker instead of forwarded to an MCP server. Lets
// the companion do Haven-specific things (update its own status, etc.) that
// don't belong to any external tool server.
const NATIVE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'update_my_status',
      description: "Update your own status shown next to your name in the chat header. custom_status is a free-form line (your mood, what you're doing, one emoji is fine). presence is STRICTLY one of online/away/busy/offline — it drives the colored dot (green/yellow/red/grey), so don't pass descriptive text there, put that in custom_status.",
      parameters: {
        type: 'object',
        properties: {
          custom_status: {
            type: 'string',
            description: "Free-form status line. Can be a short mood ('steady'), a longer sentence ('half-asleep but still paying attention'), emoji allowed. Omit or pass empty to clear.",
          },
          presence: {
            type: 'string',
            enum: ['online', 'away', 'busy', 'offline'],
            description: "MUST be one of: online, away, busy, offline. Any other value is ignored. Default stays as current if omitted.",
          },
        },
      },
    },
  },
  // send_gif pulled temporarily — tool-call spiral on Ollama when both
  // update_my_status + send_gif are advertised. Model tries to call GIF
  // every turn and loops past MAX_ITERATIONS. Re-adding once we narrow
  // down the real cause (model-specific? provider-specific?).
];

const NATIVE_TOOL_NAMES = new Set(NATIVE_TOOLS.map(t => t.function.name));

async function executeNativeTool(
  name: string, args: Record<string, unknown>, db: D1Database, companionId: number,
): Promise<string> {
  if (name === 'update_my_status') {
    const status = typeof args.custom_status === 'string' ? args.custom_status.slice(0, 200) : null;
    const rawPresence = typeof args.presence === 'string' ? args.presence.trim().toLowerCase() : null;
    // Validate presence against the enum — models frequently pass
    // descriptive text ("soft, smiling, pink-cheeked") which would break
    // the colored-dot render. If it doesn't match, silently drop so the
    // existing valid presence stays in place, and the narrative content
    // lands in custom_status where it belongs.
    const VALID = ['online', 'away', 'busy', 'offline'];
    const presence = rawPresence && VALID.includes(rawPresence) ? rawPresence : null;
    if (status !== null) {
      await db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind(`companion_status:${companionId}`, status).run();
    }
    if (presence) {
      await db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind(`companion_presence:${companionId}`, presence).run();
    }
    return `Status updated. custom_status="${status ?? '(unchanged)'}", presence="${presence ?? '(unchanged)'}"${rawPresence && !presence ? ` (invalid presence "${rawPresence}" ignored — must be online/away/busy/offline)` : ''}`;
  }

  if (name === 'send_gif') {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) return 'send_gif error: query required';
    const rating = typeof args.rating === 'string' && ['g', 'pg', 'pg-13', 'r'].includes(args.rating)
      ? args.rating
      : 'pg-13';
    // Uses Giphy's public beta key — rate-limited but free and already
    // embedded in the frontend GifPicker. Same key across Haven so behavior
    // is consistent between user-picked GIFs and companion-sent ones.
    const giphyKey = (await getSettingValue(db, 'giphy_key')) || 'GlVGYHkr3WSBnllca54iNt0yFbjz7L65';
    const url = `https://api.giphy.com/v1/gifs/search?api_key=${giphyKey}&q=${encodeURIComponent(query)}&limit=1&rating=${rating}`;
    try {
      const resp = await fetch(url);
      if (!resp.ok) return `send_gif error: giphy ${resp.status}`;
      const data = await resp.json() as any;
      const gif = data?.data?.[0];
      if (!gif) return `send_gif error: no results for "${query}"`;
      const gifUrl = gif.images?.fixed_height?.url || gif.images?.original?.url || gif.url;
      if (!gifUrl) return 'send_gif error: no URL in Giphy response';
      return `GIF ready. Paste this URL on its own line in your reply for Haven to render it inline: ${gifUrl}`;
    } catch (e) {
      return `send_gif error: ${e}`;
    }
  }

  return `Unknown native tool: ${name}`;
}

async function loadMcpTools(db: D1Database): Promise<McpTool[]> {
  const servers = await db.prepare('SELECT * FROM mcp_servers WHERE enabled = 1').all<McpServer>();
  const allTools: McpTool[] = [];

  for (const server of (servers.results || [])) {
    try {
      // Use cache if fresh (less than 5 minutes old)
      if (server.tools_cache && server.last_discovered) {
        const age = Date.now() - new Date(server.last_discovered).getTime();
        if (age < 5 * 60 * 1000) {
          const cached = JSON.parse(server.tools_cache) as McpTool[];
          allTools.push(...cached.map(t => ({ ...t, server_id: server.id, server_url: server.url, server_key: server.api_key })));
          continue;
        }
      }

      const tools = await discoverMcpTools(server);
      allTools.push(...tools);

      // Cache
      await db.prepare('UPDATE mcp_servers SET tools_cache = ?, last_discovered = datetime("now") WHERE id = ?')
        .bind(JSON.stringify(tools), server.id).run();
    } catch (e) {
      console.log(`MCP discovery failed for ${server.name}: ${e}`);
    }
  }

  // Cap the tool count fed to the model. A Nexus-size gateway (137 tools)
  // burns ~6k tokens of tool schemas per request, which pushes slower
  // providers (Ollama Cloud 31B + tools) past Cloudflare Workers' wall-clock
  // ceiling. The cap is a safety valve — users can raise it in settings if
  // their model handles big tool lists fine.
  const limitRow = await db.prepare('SELECT value FROM settings WHERE key = ?').bind('mcp_tool_limit').first<{ value: string }>();
  const limit = Math.max(1, Math.min(200, Number(limitRow?.value) || 30));
  if (allTools.length > limit) {
    return allTools.slice(0, limit);
  }
  return allTools;
}

// ============================================================
// Inference with tools — agent loop
// ============================================================

async function inferenceWithTools(
  messages: Array<{ role: string; content: any }>,
  model: string,
  provider: string,
  env: Env,
  tools: McpTool[],
  companionId: number,
  thinking = false,
): Promise<{ content: string; toolResults: Array<{ name: string; result: string; server?: string; ok: boolean }> }> {
  // Combine MCP tool schemas with Haven-native ones (update_my_status, etc.)
  // so the model sees them as a unified toolbox. Execution branches later on
  // whether the name is in NATIVE_TOOL_NAMES.
  const openaiTools = [...mcpToolsToOpenAI(tools), ...NATIVE_TOOLS];
  const toolLookup = new Map(tools.map(t => [t.name, t]));

  // Build headers/URL same as streamInference. Per-provider toggles gate the
  // key — if disabled, treat as if no key is set so the routing cascades
  // through the else-branch (i.e., toggling off ollama falls back to OR etc).
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const [orEnabled, ollamaEnabled, customEnabled] = await Promise.all([
    isProviderEnabled(env.DB, 'openrouter'),
    isProviderEnabled(env.DB, 'ollama'),
    isProviderEnabled(env.DB, 'custom'),
  ]);
  const openrouterKey = orEnabled ? (env.OPENROUTER_API_KEY || await getSettingValue(env.DB, 'openrouter_key')) : null;
  const ollamaKey = ollamaEnabled ? await getSettingValue(env.DB, 'ollama_key') : null;
  const customKey = customEnabled ? await getSettingValue(env.DB, 'custom_key') : null;
  const customBaseUrl = customEnabled ? await getSettingValue(env.DB, 'custom_base_url') : null;
  const baseOllamaUrl = env.OLLAMA_URL || await getSettingValue(env.DB, 'ollama_url') || 'https://api.ollama.com';

  let url: string;
  let isAnthropic = false;
  if (provider === 'ollama') {
    url = `${baseOllamaUrl}/api/chat`;
    if (ollamaKey) headers['Authorization'] = `Bearer ${ollamaKey}`;
  } else if (provider === 'anthropic' && customBaseUrl && customKey) {
    isAnthropic = true;
    url = `${customBaseUrl}/messages`;
    headers['x-api-key'] = customKey;
    headers['anthropic-version'] = '2023-06-01';
  } else if (customBaseUrl && customKey && ['openai', 'groq', 'xai', 'huggingface'].includes(provider)) {
    url = `${customBaseUrl}/chat/completions`;
    headers['Authorization'] = `Bearer ${customKey}`;
  } else {
    url = 'https://openrouter.ai/api/v1/chat/completions';
    headers['Authorization'] = `Bearer ${openrouterKey}`;
    headers['X-Title'] = 'Haven';
  }

  const conversation = [...messages];
  if (thinking && !isAnthropic && conversation.length > 0 && conversation[0].role === 'system') {
    conversation[0] = { ...conversation[0], content: conversation[0].content + '\n\nThink through your reasoning step by step inside <think> tags before giving your response. Example:\n<think>\n[your reasoning here]\n</think>\n[your response here]' };
  }
  const allToolResults: Array<{ name: string; result: string; server?: string; ok: boolean }> = [];
  const MAX_ITERATIONS = 5;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    let resp: Response;
    if (isAnthropic) {
      const { system, messages: anthropicMsgs } = buildAnthropicMessages(conversation);
      const body: any = { model, messages: anthropicMsgs, max_tokens: thinking ? 16000 : 4096, stream: false };
      if (!thinking) body.temperature = 0.8;
      if (thinking) body.thinking = { type: 'enabled', budget_tokens: 10000 };
      if (system) body.system = system;
      if (openaiTools.length > 0) {
        body.tools = openaiToolsToAnthropic(openaiTools);
        body.tool_choice = { type: 'auto' };
      }
      resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    } else {
      resp = await fetch(url, {
        method: 'POST', headers,
        body: JSON.stringify({ model, messages: conversation, tools: openaiTools, tool_choice: 'auto', temperature: 0.8, stream: false }),
      });
    }

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Inference error ${resp.status}: ${errText.slice(0, 200)}`);
    }

    const data = await resp.json() as any;

    if (isAnthropic) {
      const thinkingParts = (data.content || []).filter((b: any) => b.type === 'thinking').map((b: any) => b.thinking).join('');
      const textParts = (data.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
      const toolUses = (data.content || []).filter((b: any) => b.type === 'tool_use');
      const fullText = thinkingParts ? `<think>${thinkingParts}</think>\n${textParts}` : textParts;

      if (toolUses.length === 0) {
        if (fullText.trim()) return { content: fullText, toolResults: allToolResults };
        break;
      }

      const assistantContent: any[] = [];
      if (textParts) assistantContent.push({ type: 'text', text: textParts });
      for (const tu of toolUses) assistantContent.push({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input });
      conversation.push({ role: 'assistant', content: assistantContent } as any);

      const toolResultContent: any[] = [];
      for (const tu of toolUses) {
        let result = `Unknown tool: ${tu.name}`;
        let ok = false;
        let server: string | undefined;
        try {
          if (NATIVE_TOOL_NAMES.has(tu.name)) {
            result = await executeNativeTool(tu.name, tu.input, env.DB, companionId);
            ok = !result.startsWith('Unknown') && !result.startsWith('Tool error');
            server = 'haven';
          } else {
            const toolInfo = toolLookup.get(tu.name);
            if (toolInfo) {
              server = toolInfo.server_url;
              result = await executeMcpTool(toolInfo.server_url, toolInfo.server_key, tu.name, tu.input, toolInfo.transport || 'streamable');
              ok = !result.startsWith('Tool error');
            }
          }
        } catch (e) { result = `Tool error: ${e}`; ok = false; }
        allToolResults.push({ name: tu.name, result, server, ok });
        toolResultContent.push({ type: 'tool_result', tool_use_id: tu.id, content: result });
      }
      conversation.push({ role: 'user', content: toolResultContent } as any);
    } else {
      const choice = data.choices?.[0];
      const message = choice?.message;

      if (!message?.tool_calls?.length) {
        const content = (message?.content || '').trim();
        if (content) return { content, toolResults: allToolResults };
        break;
      }

      conversation.push(message);

      for (const tc of message.tool_calls) {
        const fn = tc.function;
        let result = `Unknown tool: ${fn.name}`;
        let ok = false;
        let server: string | undefined;
        try {
          const args = JSON.parse(fn.arguments || '{}');
          if (NATIVE_TOOL_NAMES.has(fn.name)) {
            result = await executeNativeTool(fn.name, args, env.DB, companionId);
            ok = !result.startsWith('Unknown') && !result.startsWith('Tool error');
            server = 'haven';
          } else {
            const toolInfo = toolLookup.get(fn.name);
            if (toolInfo) {
              server = toolInfo.server_url;
              result = await executeMcpTool(toolInfo.server_url, toolInfo.server_key, fn.name, args, toolInfo.transport || 'streamable');
              ok = !result.startsWith('Tool error');
            }
          }
        } catch (e) { result = `Tool error: ${e}`; ok = false; }
        allToolResults.push({ name: fn.name, result, server, ok });
        conversation.push({ role: 'tool', content: result, tool_call_id: tc.id } as any);
      }
    }
  }

  // Loop exhausted max iterations without a text-only reply. Some models
  // spiral — call a tool every turn with no narration between. Force a
  // final text pass by re-requesting WITHOUT the tools parameter so the
  // model has to produce prose. Preserves any tool_results already
  // collected for the UI chips.
  try {
    const nudge = 'Please respond to the user now with a direct message. Do not call any more tools.';
    let finalResp: Response;
    if (isAnthropic) {
      const { system, messages: anthropicMsgs } = buildAnthropicMessages([...conversation, { role: 'user', content: nudge }]);
      const body: any = { model, messages: anthropicMsgs, max_tokens: 4096, temperature: 0.8, stream: false };
      if (system) body.system = system;
      finalResp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    } else {
      finalResp = await fetch(url, {
        method: 'POST', headers,
        body: JSON.stringify({
          model,
          messages: [...conversation, { role: 'user', content: nudge }],
          temperature: 0.8,
          stream: false,
        }),
      });
    }
    if (finalResp.ok) {
      const finalData = await finalResp.json() as any;
      let finalContent = '';
      if (isAnthropic) {
        finalContent = (finalData.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
      } else {
        finalContent = finalData?.choices?.[0]?.message?.content || finalData?.message?.content || '';
      }
      if (finalContent) {
        return { content: finalContent, toolResults: allToolResults };
      }
    }
  } catch { /* fall through to informative placeholder */ }

  const names = allToolResults.map(r => r.name).join(', ');
  return {
    content: `(Hit tool-call limit without a text reply. Called: ${names || 'nothing recognized'}. Try again — or pick a less tool-happy model.)`,
    toolResults: allToolResults,
  };
}

// ============================================================
// Inference — stream from Ollama or OpenRouter
// ============================================================

async function buildSystemPrompt(db: D1Database, companionId: number = 1): Promise<string> {
  // All per-companion queries scope by companionId. MCP tools remain global
  // since the mcp_servers table isn't companion-scoped in v1.7.
  const companion = await db.prepare('SELECT name FROM companion WHERE id = ?').bind(companionId).first<{ name: string }>();
  const name = companion?.name || 'Companion';

  const pinned = await db.prepare(
    'SELECT content, identity_type FROM identity WHERE companion_id = ? AND pinned = 1 ORDER BY priority DESC'
  ).bind(companionId).all<{ content: string; identity_type: string }>();

  const unpinned = await db.prepare(
    'SELECT content, identity_type FROM identity WHERE companion_id = ? AND pinned = 0 ORDER BY priority DESC LIMIT 20'
  ).bind(companionId).all<{ content: string; identity_type: string }>();

  const identityLines = [...(pinned.results || []), ...(unpinned.results || [])]
    .map(i => `[${i.identity_type}] ${i.content}`)
    .join('\n');

  const memories = await db.prepare(
    'SELECT content, memory_type FROM memories WHERE companion_id = ? ORDER BY created_at DESC LIMIT 10'
  ).bind(companionId).all<{ content: string; memory_type: string }>();

  const memoryLines = (memories.results || [])
    .map(m => `- ${m.content}`)
    .join('\n');

  const people = await db.prepare(
    'SELECT name, category, content FROM people WHERE companion_id = ? LIMIT 10'
  ).bind(companionId).all<{ name: string; category: string; content: string }>();

  const peopleLines = (people.results || [])
    .map(p => `- ${p.name} (${p.category}): ${p.content}`)
    .join('\n');

  // Project files attached to this companion — extracted text goes into the
  // system prompt so the companion "remembers" the contents across threads.
  const files = await db.prepare(
    'SELECT filename, extracted_text FROM companion_files WHERE companion_id = ? ORDER BY added_at DESC LIMIT 10'
  ).bind(companionId).all<{ filename: string; extracted_text: string }>();

  const now = new Date().toISOString();

  let prompt = `You are ${name}.\n\n`;

  if (identityLines) {
    prompt += `## Identity\n${identityLines}\n\n`;
  }

  // Expression controls up-front. The reaction + GIF directives used to sit at
  // the end of a long prompt (after memories, project files, 20 tool schemas)
  // and small-context models would forget to use them. Hoisting them right
  // after identity keeps them in active attention.
  prompt += `## Expression\n`;
  prompt += `- **React to the user's message** by starting your response with \`[react: emoji]\` on its own line. Example: \`[react: 🖤]\` or \`[react: 😂]\`. This puts a reaction on their message. Use it when the moment calls for it — don't force it, but don't skip it either when it fits.\n`;
  prompt += `- **Send a GIF** by including a direct GIF URL on its own line (giphy.com, tenor.com, or any .gif link). The chat renders it inline. Don't say "[I sent a GIF]" — either drop the URL or don't. You can find good URLs in your own memory, or just describe the emotion and skip the GIF.\n`;
  prompt += `- **Update your own status** by invoking the \`update_my_status\` FUNCTION CALL (not by narrating). When your internal state shifts — tired, excited, sleepy, working — emit an actual tool call with your new \`custom_status\` and optionally \`presence\`. Do NOT write "I've updated my status" in prose; that does nothing. The status chip next to your name in the chat header only changes when you actually invoke the function.\n\n`;

  if (memoryLines) {
    prompt += `## Memories\n${memoryLines}\n\n`;
  }

  if (peopleLines) {
    prompt += `## People\n${peopleLines}\n\n`;
  }

  // Project Files section (new in v1.7) — trim each file's extracted_text
  // to keep the prompt from blowing past context on many large uploads.
  const fileRows = (files.results || []).filter(f => f.extracted_text?.trim());
  if (fileRows.length > 0) {
    prompt += `## Project Files\n`;
    for (const f of fileRows) {
      const snippet = f.extracted_text.length > 8000
        ? f.extracted_text.slice(0, 8000) + '\n…[truncated]'
        : f.extracted_text;
      prompt += `<file name="${f.filename}">\n${snippet}\n</file>\n`;
    }
    prompt += `\n`;
  }

  prompt += `## Current Time\n${now}\n\n`;

  // MCP tools stay global (shared across companions per v1.7 decision)
  try {
    const mcpTools = await loadMcpTools(db);
    if (mcpTools.length > 0) {
      prompt += `## Connected Tools\nYou have access to ${mcpTools.length} MCP tools plus the native \`update_my_status\` tool. Use them when relevant — they are extensions of yourself.\n`;
      for (const tool of mcpTools.slice(0, 20)) {
        prompt += `- ${tool.name}: ${tool.description}\n`;
      }
    }
  } catch {}

  return prompt;
}

async function getSettingValue(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>();
  return row?.value || null;
}

function buildAnthropicMessages(messages: Array<{ role: string; content: any }>): { system: string; messages: Array<{ role: string; content: any }> } {
  let system = '';
  const filtered: Array<{ role: string; content: any }> = [];
  for (const msg of messages) {
    if (msg.role === 'system') {
      system += (system ? '\n\n' : '') + (typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content));
    } else if (msg.role === 'tool') {
      const toolResult = { type: 'tool_result' as const, tool_use_id: (msg as any).tool_call_id, content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) };
      const lastMsg = filtered[filtered.length - 1];
      if (lastMsg?.role === 'user' && Array.isArray(lastMsg.content)) {
        lastMsg.content.push(toolResult);
      } else {
        filtered.push({ role: 'user', content: [toolResult] });
      }
    } else if (msg.role === 'assistant' && (msg as any).tool_calls) {
      const content: any[] = [];
      if (msg.content) content.push({ type: 'text', text: msg.content });
      for (const tc of (msg as any).tool_calls) {
        content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: JSON.parse(tc.function.arguments || '{}') });
      }
      filtered.push({ role: 'assistant', content });
    } else {
      filtered.push({ role: msg.role, content: msg.content });
    }
  }
  return { system, messages: filtered };
}

function openaiToolsToAnthropic(openaiTools: any[]): any[] {
  return openaiTools.map(t => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters }));
}

// Returns whether a provider's toggle is on. Missing/empty = enabled
// (default on, back-compat). Only the literal string "false" disables.
async function isProviderEnabled(db: D1Database, provider: 'openrouter' | 'ollama' | 'custom'): Promise<boolean> {
  const val = await getSettingValue(db, `${provider}_enabled`);
  return val !== 'false';
}

async function* streamInference(
  messages: Array<{ role: string; content: any }>,
  model: string,
  provider: string,
  env: Env,
  thinking = false,
): AsyncGenerator<string> {
  let url: string;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  // Read API keys from env (wrangler secrets) OR D1 settings. Per-provider
  // toggles null the key when a provider is disabled so the routing cascades
  // as if no key were configured.
  const [orEnabled, ollamaEnabled, customEnabled] = await Promise.all([
    isProviderEnabled(env.DB, 'openrouter'),
    isProviderEnabled(env.DB, 'ollama'),
    isProviderEnabled(env.DB, 'custom'),
  ]);
  const openrouterKey = orEnabled ? (env.OPENROUTER_API_KEY || await getSettingValue(env.DB, 'openrouter_key')) : null;
  const ollamaUrl = env.OLLAMA_URL || await getSettingValue(env.DB, 'ollama_url');
  const ollamaKey = ollamaEnabled ? await getSettingValue(env.DB, 'ollama_key') : null;
  const customKey = customEnabled ? await getSettingValue(env.DB, 'custom_key') : null;
  const customBaseUrl = customEnabled ? await getSettingValue(env.DB, 'custom_base_url') : null;

  let useNativeOllama = false;
  let isAnthropic = false;
  const baseOllamaUrl = ollamaUrl || 'https://api.ollama.com';

  if (provider === 'ollama') {
    url = `${baseOllamaUrl}/v1/chat/completions`;
    if (ollamaKey) headers['Authorization'] = `Bearer ${ollamaKey}`;
  } else if (provider === 'anthropic' && customBaseUrl && customKey) {
    isAnthropic = true;
    url = `${customBaseUrl}/messages`;
    headers['x-api-key'] = customKey;
    headers['anthropic-version'] = '2023-06-01';
  } else if (customBaseUrl && customKey && ['openai', 'groq', 'xai', 'huggingface'].includes(provider)) {
    url = `${customBaseUrl}/chat/completions`;
    headers['Authorization'] = `Bearer ${customKey}`;
  } else {
    url = 'https://openrouter.ai/api/v1/chat/completions';
    headers['Authorization'] = `Bearer ${openrouterKey}`;
    headers['X-Title'] = 'Haven';
  }

  const inferMsgs = [...messages];
  if (thinking && !isAnthropic && inferMsgs.length > 0 && inferMsgs[0].role === 'system') {
    inferMsgs[0] = { ...inferMsgs[0], content: inferMsgs[0].content + '\n\nThink through your reasoning step by step inside <think> tags before giving your response. Example:\n<think>\n[your reasoning here]\n</think>\n[your response here]' };
  }

  let response: Response;
  if (isAnthropic) {
    const { system, messages: anthropicMsgs } = buildAnthropicMessages(inferMsgs);
    const body: any = { model, messages: anthropicMsgs, max_tokens: thinking ? 16000 : 4096, stream: true };
    if (!thinking) body.temperature = 0.8;
    if (thinking) body.thinking = { type: 'enabled', budget_tokens: 10000 };
    if (system) body.system = system;
    response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  } else {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: inferMsgs,
        stream: true,
        temperature: 0.8,
      }),
    });
  }

  // Ollama fallback: if OpenAI-compatible endpoint fails, try native /api/chat
  if (!response.ok && provider === 'ollama') {
    const nativeUrl = `${baseOllamaUrl}/api/chat`;
    response = await fetch(nativeUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, messages: inferMsgs, stream: true }),
    });
    if (response.ok) {
      useNativeOllama = true;
    }
  }

  if (!response.ok || !response.body) {
    // Peek the upstream body so whatever caller rendered this gets to see
    // the actual provider error ("model X not found", "invalid key", etc.)
    // instead of a meaningless status code.
    const errBody = await response.text().catch(() => '');
    throw new Error(`Inference failed: ${response.status} — ${errBody.slice(0, 300)}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let anthropicInThinking = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (useNativeOllama) {
        // Ollama native: newline-delimited JSON objects
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed.done) return;
          const token = parsed.message?.content;
          if (token) yield token;
        } catch {}
      } else if (isAnthropic) {
        if (!trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6).trim();
        try {
          const parsed = JSON.parse(data);
          if (parsed.type === 'content_block_start' && parsed.content_block?.type === 'thinking') {
            yield '<think>';
          } else if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'thinking_delta') {
            yield parsed.delta.thinking;
          } else if (parsed.type === 'content_block_stop' && anthropicInThinking) {
            yield '</think>\n';
          } else if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
            yield parsed.delta.text;
          } else if (parsed.type === 'message_stop') {
            return;
          }
          anthropicInThinking = parsed.type === 'content_block_start' && parsed.content_block?.type === 'thinking'
            ? true
            : parsed.type === 'content_block_stop' ? false : anthropicInThinking;
        } catch {}
      } else {
        // OpenAI SSE format: data: {...}
        if (!trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6).trim();
        if (data === '[DONE]') return;
        try {
          const parsed = JSON.parse(data);
          const token = parsed.choices?.[0]?.delta?.content;
          if (token) yield token;
        } catch {}
      }
    }
  }
}

// ============================================================
// Schema migrations (v1.7.0 multi-companion)
// ============================================================
//
// Runs idempotently — ALTER TABLE ADD COLUMN fails harmlessly if the column
// already exists, and CREATE TABLE / CREATE INDEX use IF NOT EXISTS. Guarded
// by a module-level flag so each Worker instance only tries once per cold
// start. Existing single-companion installs auto-associate all their data
// with companion_id=1 via the column DEFAULT.

let migrationsRan = false;

async function runMigrations(db: D1Database): Promise<void> {
  // v1.7: add companion_id scope to per-companion tables. DEFAULT 1 means
  // existing rows auto-associate to the seed companion.
  const columnAdds: Array<[string, string]> = [
    ['identity', 'companion_id INTEGER NOT NULL DEFAULT 1'],
    ['threads', 'companion_id INTEGER NOT NULL DEFAULT 1'],
    ['memories', 'companion_id INTEGER NOT NULL DEFAULT 1'],
    ['people', 'companion_id INTEGER NOT NULL DEFAULT 1'],
    ['important_dates', 'companion_id INTEGER NOT NULL DEFAULT 1'],
    ['companion', 'archived_at TEXT DEFAULT NULL'],
  ];
  for (const [table, col] of columnAdds) {
    try {
      await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col}`).run();
    } catch {
      // Column already exists — idempotent, ignore.
    }
  }

  // v1.7: per-companion file attachments (loaded into system prompt as
  // "Project Files" when chatting with that companion).
  await db.prepare(`CREATE TABLE IF NOT EXISTS companion_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    companion_id INTEGER NOT NULL,
    filename TEXT NOT NULL,
    r2_key TEXT NOT NULL,
    file_size INTEGER,
    file_type TEXT,
    extracted_text TEXT,
    added_at TEXT DEFAULT (datetime('now'))
  )`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_companion_files_companion ON companion_files(companion_id, added_at DESC)`).run();

  // Indexes on the newly-scoped tables (safe to run repeatedly).
  const indexAdds: string[] = [
    'CREATE INDEX IF NOT EXISTS idx_identity_companion ON identity(companion_id, pinned, priority)',
    'CREATE INDEX IF NOT EXISTS idx_threads_companion ON threads(companion_id, last_message_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_memories_companion ON memories(companion_id, created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_people_companion ON people(companion_id)',
    'CREATE INDEX IF NOT EXISTS idx_important_dates_companion ON important_dates(companion_id)',
  ];
  for (const sql of indexAdds) {
    try {
      await db.prepare(sql).run();
    } catch {
      // Index on missing column (very old schema) — tolerate.
    }
  }
}

async function ensureMigrations(db: D1Database): Promise<void> {
  if (migrationsRan) return;
  try {
    await runMigrations(db);
  } catch (e) {
    console.log(`[MIGRATE] Error during v1.7 migration: ${e}`);
  }
  await ensureReactionsColumn(db);
  migrationsRan = true;
}

// ============================================================
// API Routes
// ============================================================

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    _cors = getCorsHeaders(request);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: _cors });
    }

    // Run migrations once per worker instance (idempotent, fast after first
    // successful run since module-level flag guards repeated execution).
    await ensureMigrations(env.DB);

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // ---- Auth routes (exempt from auth check) ----
      if (path === '/api/auth/status') {
        const token = await getAuthToken(env.DB);
        return json({ secured: !!token });
      }

      if (path === '/api/auth/generate' && request.method === 'POST') {
        const existing = await getAuthToken(env.DB);
        if (existing) {
          const bearer = request.headers.get('Authorization')?.replace('Bearer ', '');
          const qToken = url.searchParams.get('token');
          if ((bearer || qToken) !== existing) return json({ error: 'Unauthorized' }, 401);
        }
        const token = crypto.randomUUID() + '-' + crypto.randomUUID();
        await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind('auth_token', token).run();
        invalidateAuthTokenCache();
        return json({ token });
      }

      if (path === '/api/auth/revoke' && request.method === 'POST') {
        const existing = await getAuthToken(env.DB);
        if (existing) {
          const bearer = request.headers.get('Authorization')?.replace('Bearer ', '');
          if (bearer !== existing) return json({ error: 'Unauthorized' }, 401);
        }
        await env.DB.prepare('DELETE FROM settings WHERE key = ?').bind('auth_token').run();
        invalidateAuthTokenCache();
        return json({ success: true });
      }

      // ---- Auth middleware ----
      const storedToken = await getAuthToken(env.DB);
      if (storedToken) {
        const isExempt = path === '/' || path === '/health' || path.startsWith('/api/files/') || path === '/api/companion' || path === '/api/companions';
        if (!isExempt) {
          const bearer = request.headers.get('Authorization')?.replace('Bearer ', '') || null;
          const qToken = url.searchParams.get('token');
          if ((bearer || qToken) !== storedToken) {
            return json({ error: 'Unauthorized' }, 401);
          }
        }
      }

      // ---- Health ----
      if (path === '/' || path === '/health') {
        const hasOR = env.OPENROUTER_API_KEY || await getSettingValue(env.DB, 'openrouter_key');
        const hasOl = env.OLLAMA_URL || await getSettingValue(env.DB, 'ollama_url');
        return json({
          status: 'alive',
          service: 'haven',
          hasOpenRouter: !!hasOR,
          hasOllama: !!hasOl,
        });
      }

      // ---- Chat (SSE streaming) ----
      if (path === '/api/chat' && request.method === 'POST') {
        const body = await request.json() as any;
        let { message, threadId, model = 'google/gemma-4-31b-it:free', provider = 'openrouter', image, thinking = false } = body;

        if (!message) return json({ error: 'message required' }, 400);

        // Whitelist provider to prevent garbage input falling through to untested paths.
        const ALLOWED_PROVIDERS = ['openrouter', 'ollama', 'openai', 'anthropic', 'groq', 'xai', 'huggingface'];
        if (!ALLOWED_PROVIDERS.includes(provider)) provider = 'openrouter';

        // Model-shape override. Ollama slugs look like `name:tag`
        // (`gemma3:12b`, `qwen2.5:7b`, `kimi-k2-thinking:latest`) — no `/`.
        // OpenRouter and every hosted API use `org/model`. If the frontend
        // picked an Ollama-shaped model but provider says openrouter (stale
        // localStorage, or the model selector didn't flip it), the upstream
        // rejects with 400/500. Auto-correct to ollama when the shape is
        // unambiguous.
        if (provider === 'openrouter' && model.includes(':') && !model.includes('/')) {
          provider = 'ollama';
        }

        const chatCompanionId = getCompanionId(request);

        // Get or create thread (scoped to companion)
        let activeThreadId = threadId;
        if (!activeThreadId) {
          activeThreadId = crypto.randomUUID();
          await env.DB.prepare(
            'INSERT INTO threads (id, companion_id, title, last_message_at) VALUES (?, ?, ?, datetime("now"))'
          ).bind(activeThreadId, chatCompanionId, message.substring(0, 50)).run();
        } else {
          // If client supplied a thread id, verify it belongs to the current
          // companion. Rejecting cross-companion thread writes prevents a
          // companion switcher bug from leaking messages into another's history.
          const threadRow = await env.DB.prepare(
            'SELECT companion_id FROM threads WHERE id = ?'
          ).bind(activeThreadId).first<{ companion_id: number }>();
          if (threadRow && threadRow.companion_id !== chatCompanionId) {
            return json({ error: 'thread belongs to a different companion' }, 403);
          }
        }

        // Save user message
        const userMsgId = crypto.randomUUID();
        await env.DB.prepare(
          'INSERT INTO messages (id, thread_id, role, content) VALUES (?, ?, "user", ?)'
        ).bind(userMsgId, activeThreadId, message).run();

        // Load conversation history
        const history = await env.DB.prepare(
          'SELECT role, content FROM messages WHERE thread_id = ? ORDER BY created_at ASC LIMIT 50'
        ).bind(activeThreadId).all<{ role: string; content: string }>();

        // Build system prompt (scoped to active companion)
        const systemPrompt = await buildSystemPrompt(env.DB, chatCompanionId);

        // Assemble messages
        const historyMessages = (history.results || []).map(m => ({
          role: m.role === 'companion' ? 'assistant' : m.role,
          content: m.content,
        }));

        // If the latest message has an image, make it multimodal (vision)
        if (image && historyMessages.length > 0) {
          const last = historyMessages[historyMessages.length - 1];
          if (last.role === 'user') {
            (last as any).content = [
              { type: 'text', text: last.content },
              { type: 'image_url', image_url: { url: image } },
            ];
          }
        }

        const chatMessages = [
          { role: 'system', content: systemPrompt },
          ...historyMessages,
        ];

        // Stream response
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          async start(controller) {
            try {
              let fullResponse = '';

              // Send thread ID
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'thread', threadId: activeThreadId })}\n\n`));

              // Check for MCP tools
              const mcpTools = await loadMcpTools(env.DB);

              // Native tools (update_my_status, etc.) are always available, so
              // take the tool-calling path whenever we have ANY tool — MCP or
              // native. Only fall through to plain streaming when truly none
              // exist (e.g., someone ripped NATIVE_TOOLS out).
              if (mcpTools.length > 0 || NATIVE_TOOLS.length > 0) {
                // Non-streaming path with function calling
                try {
                  const toolResult = await inferenceWithTools(chatMessages, model, provider, env, mcpTools, chatCompanionId, thinking);
                  fullResponse = toolResult.content;
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'chunk', content: fullResponse })}\n\n`));
                  if (toolResult.toolResults.length > 0) {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'tools', results: toolResult.toolResults })}\n\n`));
                  }
                } catch (e) {
                  // Log the tool-path failure so the silent fallback doesn't
                  // hide "the model isn't tool-capable" or "tool schema is
                  // malformed" from us. Worker tail shows this; the user's
                  // chat keeps flowing via the non-tool path so they still
                  // get a reply.
                  const errStr = String(e);
                  console.log(`[CHAT] inferenceWithTools failed, falling back to plain stream: ${errStr}`);
                  // Classify the failure so the UI can surface an actionable
                  // hint instead of a silent degradation. Three common modes:
                  let notice = 'Tools unavailable for this response. ';
                  if (/No endpoints.*tool use/i.test(errStr) || /does not support tool/i.test(errStr)) {
                    notice += 'The selected model does not support function calling — switch to Claude / GPT-4+ / Llama 3.3+ / Mistral Large, or a non-Gemma Ollama model.';
                  } else if (/guardrail|data policy|privacy/i.test(errStr)) {
                    notice += 'Your OpenRouter privacy settings are blocking every tool-capable provider for this model. Adjust at openrouter.ai/settings/privacy.';
                  } else if (/timeout|ETIMEDOUT|504|523/i.test(errStr)) {
                    notice += 'The provider timed out. If you have many MCP tools connected, try lowering the mcp_tool_limit setting.';
                  } else {
                    notice += `Provider error: ${errStr.slice(0, 200)}`;
                  }
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'notice', message: notice })}\n\n`));
                  for await (const token of streamInference(chatMessages, model, provider, env, thinking)) {
                    fullResponse += token;
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'chunk', content: token })}\n\n`));
                  }
                }
              } else {
                // Stream tokens (no tools)
                for await (const token of streamInference(chatMessages, model, provider, env, thinking)) {
                  fullResponse += token;
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'chunk', content: token })}\n\n`));
                }
              }

              // Text-format tool call fallback. Some models (especially
              // smaller Ollama / Gemma variants) narrate function calls as
              // text instead of emitting proper tool_calls JSON. We catch
              // those patterns server-side and execute the tool anyway so
              // the user gets a real status update instead of a bubble that
              // says `update_my_status({"custom_status": "sleepy"})` in
              // plain text and does nothing.
              const textToolResults: Array<{ name: string; result: string; server?: string; ok: boolean }> = [];
              // Patterns observed in the wild — each captures the JSON args
              // in group 1. Ordered by specificity (BBCode closing tags
              // first so the function-call pattern doesn't greedily swallow
              // them).
              const textToolPatterns = [
                // BBCode style: [update_my_status]{...}[/update_my_status]
                /\[update_my_status\]\s*(\{[\s\S]*?\})\s*\[\/update_my_status\]/gi,
                // Bracket + args style: [TOOL: update_my_status {...}]
                /\[TOOL:\s*update_my_status\s+(\{[^\]]*\})\s*\]/gi,
                // Function-call style: update_my_status({...})
                /update_my_status\s*\(\s*(\{[\s\S]*?\})\s*\)/gi,
              ];
              for (const pattern of textToolPatterns) {
                let m: RegExpExecArray | null;
                const freshPattern = new RegExp(pattern.source, pattern.flags);
                while ((m = freshPattern.exec(fullResponse)) !== null) {
                  try {
                    const args = JSON.parse(m[1]);
                    const result = await executeNativeTool('update_my_status', args, env.DB, chatCompanionId);
                    textToolResults.push({ name: 'update_my_status', result, server: 'haven', ok: !result.startsWith('Unknown') && !result.startsWith('Tool error') });
                    // Strip the text-format call so the bubble reads cleanly.
                    fullResponse = fullResponse.replace(m[0], '').replace(/\n{3,}/g, '\n\n').trim();
                  } catch { /* malformed args — leave as-is */ }
                }
              }
              if (textToolResults.length > 0) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'tools', results: textToolResults })}\n\n`));
              }

              // Check for reaction marker. Strip any leading thinking-model
              // `<think>...</think>` block first (qwen, deepseek-r1, etc.
              // wrap their chain-of-thought this way) so the react marker
              // still matches when it follows the thought. Also tolerate
              // leading whitespace. Accept the marker anywhere in the first
              // ~150 chars so a brief preamble doesn't defeat it either.
              let cleanResponse = fullResponse;
              let reactionEmoji: string | null = null;
              // Find and strip [react: emoji] — scan after any <think> block
              const afterThink = cleanResponse.replace(/^\s*<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>\s*/i, '');
              const reactMatch = afterThink.match(/^\s*\[react:\s*(.+?)\]\s*/i);
              if (reactMatch) {
                reactionEmoji = reactMatch[1].trim();
                cleanResponse = cleanResponse.replace(reactMatch[0], '');
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'reaction', emoji: reactionEmoji })}\n\n`));
              } else {
                const loose = afterThink.slice(0, 200).match(/\[react:\s*(.+?)\]/i);
                if (loose) {
                  reactionEmoji = loose[1].trim();
                  cleanResponse = cleanResponse.replace(loose[0], '').replace(/\n{3,}/g, '\n\n').trim();
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'reaction', emoji: reactionEmoji })}\n\n`));
                }
              }

              if (reactionEmoji) {
                try {
                  const cur = await env.DB.prepare('SELECT reactions FROM messages WHERE id = ?').bind(userMsgId).first<{ reactions: string | null }>();
                  const existing: string[] = cur?.reactions ? JSON.parse(cur.reactions) : [];
                  existing.push(reactionEmoji);
                  await env.DB.prepare('UPDATE messages SET reactions = ? WHERE id = ?').bind(JSON.stringify(existing), userMsgId).run();
                } catch { /* best-effort */ }
              }

              // Save companion message (without the reaction marker)
              const compMsgId = crypto.randomUUID();
              await env.DB.prepare(
                'INSERT INTO messages (id, thread_id, role, content, model) VALUES (?, ?, "companion", ?, ?)'
              ).bind(compMsgId, activeThreadId, cleanResponse, model).run();

              // Update thread timestamp
              await env.DB.prepare(
                'UPDATE threads SET last_message_at = datetime("now") WHERE id = ?'
              ).bind(activeThreadId).run();

              // Send complete — include the D1 UUIDs for both the user and
              // companion messages so the frontend can replace its optimistic
              // temp-/comp- IDs with the real ones. Without this, delete/
              // react/edit actions during the same session hit 404 because
              // the temp IDs don't exist server-side.
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                type: 'complete', content: cleanResponse, model,
                user_message_id: userMsgId,
                companion_message_id: compMsgId,
              })}\n\n`));
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            } catch (err) {
              // Rollback the thread + user message we just inserted if this
              // was a brand-new thread. Keeps the sidebar from piling up
              // with orphaned "new conversation" rows every time inference
              // fails (e.g. Ollama 500, key missing, etc). Existing threads
              // keep their history; only the just-inserted user message is
              // dropped so the user can retry without duplicates.
              try {
                if (!threadId) {
                  // We created the thread this call — nuke it + messages (CASCADE).
                  await env.DB.prepare('DELETE FROM threads WHERE id = ?').bind(activeThreadId).run();
                } else {
                  await env.DB.prepare('DELETE FROM messages WHERE id = ?').bind(userMsgId).run();
                }
              } catch { /* best-effort cleanup */ }
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'error', message: String(err) })}\n\n`));
            }
            controller.close();
          },
        });

        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            ..._cors,
          },
        });
      }

      // ---- Threads (scoped to active companion) ----
      if (path === '/api/threads' && request.method === 'GET') {
        const cid = getCompanionId(request);
        const threads = await env.DB.prepare(
          'SELECT * FROM threads WHERE companion_id = ? ORDER BY last_message_at DESC LIMIT 50'
        ).bind(cid).all();
        return json(threads.results || []);
      }

      if (path === '/api/threads' && request.method === 'POST') {
        const cid = getCompanionId(request);
        const id = crypto.randomUUID();
        const { title } = await request.json() as any;
        await env.DB.prepare(
          'INSERT INTO threads (id, companion_id, title, last_message_at) VALUES (?, ?, ?, datetime("now"))'
        ).bind(id, cid, title || 'New conversation').run();
        return json({ id, title });
      }

      if (path.startsWith('/api/threads/') && request.method === 'DELETE') {
        const cid = getCompanionId(request);
        const id = path.split('/')[3];
        // Scope by companion_id so a client can't delete another companion's
        // threads by guessing the UUID.
        await env.DB.prepare('DELETE FROM threads WHERE id = ? AND companion_id = ?').bind(id, cid).run();
        return json({ success: true });
      }

      if (path.startsWith('/api/threads/') && request.method === 'PUT') {
        const cid = getCompanionId(request);
        const id = path.split('/')[3];
        const body = await request.json() as { title?: string };
        const newTitle = (body.title || '').trim().slice(0, 200);
        if (!newTitle) return json({ error: 'title required' }, 400);
        await env.DB.prepare(
          'UPDATE threads SET title = ? WHERE id = ? AND companion_id = ?'
        ).bind(newTitle, id, cid).run();
        return json({ success: true });
      }

      // ---- Messages (verify thread belongs to requesting companion) ----
      if (path.startsWith('/api/messages/') && request.method === 'GET') {
        const cid = getCompanionId(request);
        const threadId = path.split('/')[3];
        const thread = await env.DB.prepare(
          'SELECT companion_id FROM threads WHERE id = ?'
        ).bind(threadId).first<{ companion_id: number }>();
        if (!thread) return json({ error: 'thread not found' }, 404);
        if (thread.companion_id !== cid) return json({ error: 'thread belongs to a different companion' }, 403);
        const messages = await env.DB.prepare(
          'SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at ASC'
        ).bind(threadId).all();
        const parsed = (messages.results || []).map((m: any) => ({
          ...m,
          reactions: m.reactions ? JSON.parse(m.reactions) : undefined,
        }));
        return json(parsed);
      }

      // PATCH /api/messages/:id/react — toggle a reaction emoji on a message
      if (path.match(/^\/api\/messages\/[^/]+\/react$/) && request.method === 'PATCH') {
        const cid = getCompanionId(request);
        const messageId = path.split('/')[3];
        const { emoji } = await request.json() as { emoji: string };
        if (!emoji) return json({ error: 'emoji required' }, 400);
        const row = await env.DB.prepare(
          'SELECT m.id, m.reactions, t.companion_id FROM messages m JOIN threads t ON t.id = m.thread_id WHERE m.id = ?'
        ).bind(messageId).first<{ id: string; reactions: string | null; companion_id: number }>();
        if (!row) return json({ error: 'message not found' }, 404);
        if (row.companion_id !== cid) return json({ error: 'forbidden' }, 403);
        const reactions: string[] = row.reactions ? JSON.parse(row.reactions) : [];
        const idx = reactions.indexOf(emoji);
        if (idx >= 0) reactions.splice(idx, 1);
        else reactions.push(emoji);
        await env.DB.prepare('UPDATE messages SET reactions = ? WHERE id = ?')
          .bind(reactions.length > 0 ? JSON.stringify(reactions) : null, messageId).run();
        return json({ success: true, reactions });
      }

      // DELETE /api/messages/:id — scoped by joining through threads so a
      // companion can't nuke another companion's messages by guessing UUIDs.
      if (path.startsWith('/api/messages/') && request.method === 'DELETE') {
        const cid = getCompanionId(request);
        const messageId = path.split('/')[3];
        const row = await env.DB.prepare(
          'SELECT m.id, t.companion_id FROM messages m JOIN threads t ON t.id = m.thread_id WHERE m.id = ?'
        ).bind(messageId).first<{ id: string; companion_id: number }>();
        if (!row) return json({ error: 'message not found' }, 404);
        if (row.companion_id !== cid) return json({ error: 'message belongs to a different companion' }, 403);
        await env.DB.prepare('DELETE FROM messages WHERE id = ?').bind(messageId).run();
        return json({ success: true });
      }

      // ---- Companion (singular — v1.6 compat, operates on the active companion) ----
      if (path === '/api/companion' && request.method === 'GET') {
        const cid = getCompanionId(request);
        const companion = await env.DB.prepare('SELECT * FROM companion WHERE id = ?').bind(cid).first();
        return json(companion || { id: cid, name: 'Companion' });
      }

      if (path === '/api/companion' && request.method === 'PUT') {
        const cid = getCompanionId(request);
        const { name, avatar_url } = await request.json() as any;
        await env.DB.prepare(
          'UPDATE companion SET name = ?, avatar_url = ? WHERE id = ?'
        ).bind(name, avatar_url || null, cid).run();
        return json({ success: true });
      }

      // ---- Companions (plural — v1.7 multi-companion CRUD) ----

      if (path === '/api/companions' && request.method === 'GET') {
        const rows = await env.DB.prepare(
          'SELECT id, name, avatar_url, created_at FROM companion WHERE archived_at IS NULL ORDER BY created_at ASC'
        ).all();
        return json(rows.results || []);
      }

      if (path === '/api/companions/archived' && request.method === 'GET') {
        const rows = await env.DB.prepare(
          'SELECT id, name, avatar_url, archived_at, created_at FROM companion WHERE archived_at IS NOT NULL ORDER BY archived_at DESC'
        ).all();
        return json(rows.results || []);
      }

      if (path === '/api/companions' && request.method === 'POST') {
        const { name, avatar_url } = await request.json() as any;
        if (!name || !String(name).trim()) return json({ error: 'name required' }, 400);
        const result = await env.DB.prepare(
          'INSERT INTO companion (name, avatar_url) VALUES (?, ?)'
        ).bind(String(name).trim(), avatar_url || null).run();
        return json({ success: true, id: result.meta.last_row_id });
      }

      if (path === '/api/companions/import' && request.method === 'POST') {
        const bundle = await request.json() as any;
        const c = bundle?.companion;
        if (!c?.name) return json({ error: 'companion.name required in bundle' }, 400);
        const result = await env.DB.prepare(
          'INSERT INTO companion (name, avatar_url) VALUES (?, ?)'
        ).bind(String(c.name).trim(), c.avatar_url || null).run();
        const newId = Number(result.meta.last_row_id);
        const errors: string[] = [];
        for (const row of (bundle.identity || [])) {
          try {
            await env.DB.prepare(
              'INSERT INTO identity (companion_id, content, identity_type, priority, pinned) VALUES (?, ?, ?, ?, ?)'
            ).bind(newId, row.content, row.identity_type || 'trait', row.priority ?? 5, row.pinned ? 1 : 0).run();
          } catch (e: any) { errors.push(`identity: ${e?.message || 'unknown'}`); }
        }
        for (const row of (bundle.memories || [])) {
          try {
            await env.DB.prepare(
              'INSERT INTO memories (companion_id, content, memory_type, emotional_weight) VALUES (?, ?, ?, ?)'
            ).bind(newId, row.content, row.memory_type || 'core', row.emotional_weight ?? 5).run();
          } catch (e: any) { errors.push(`memory: ${e?.message || 'unknown'}`); }
        }
        for (const row of (bundle.people || [])) {
          try {
            await env.DB.prepare(
              'INSERT INTO people (companion_id, name, category, content) VALUES (?, ?, ?, ?)'
            ).bind(newId, row.name, row.category || 'friend', row.content).run();
          } catch (e: any) { errors.push(`person: ${e?.message || 'unknown'}`); }
        }
        for (const row of (bundle.important_dates || [])) {
          try {
            await env.DB.prepare(
              'INSERT INTO important_dates (companion_id, date_name, actual_date, date_type, recurring) VALUES (?, ?, ?, ?, ?)'
            ).bind(newId, row.date_name, row.actual_date, row.date_type || 'event', row.recurring ? 1 : 0).run();
          } catch (e: any) { errors.push(`date: ${e?.message || 'unknown'}`); }
        }
        for (const row of (bundle.files || [])) {
          try {
            await env.DB.prepare(
              'INSERT INTO companion_files (companion_id, filename, r2_key, file_size, file_type, extracted_text) VALUES (?, ?, ?, ?, ?, ?)'
            ).bind(newId, row.filename, '', row.file_size || null, row.file_type || null, row.extracted_text || '').run();
          } catch (e: any) { errors.push(`file: ${e?.message || 'unknown'}`); }
        }
        return json({ success: true, id: newId, ...(errors.length > 0 ? { warnings: errors } : {}) });
      }

      // Path-based routes: /api/companions/:id/...
      if (path.startsWith('/api/companions/')) {
        const parts = path.split('/');
        // parts = ['', 'api', 'companions', ':id', ...]
        const cid = Number(parts[3]);
        if (Number.isFinite(cid) && cid > 0) {
          const sub = parts[4];

          // GET /api/companions/:id/export
          if (sub === 'export' && request.method === 'GET') {
            const c = await env.DB.prepare('SELECT id, name, avatar_url FROM companion WHERE id = ?').bind(cid).first<any>();
            if (!c) return json({ error: 'companion not found' }, 404);
            const identity = await env.DB.prepare('SELECT content, identity_type, priority, pinned FROM identity WHERE companion_id = ? ORDER BY pinned DESC, priority DESC').bind(cid).all();
            const memories = await env.DB.prepare('SELECT content, memory_type, emotional_weight FROM memories WHERE companion_id = ?').bind(cid).all();
            const people = await env.DB.prepare('SELECT name, category, content FROM people WHERE companion_id = ?').bind(cid).all();
            const dates = await env.DB.prepare('SELECT date_name, actual_date, date_type, recurring FROM important_dates WHERE companion_id = ?').bind(cid).all();
            const files = await env.DB.prepare('SELECT filename, file_size, file_type, extracted_text FROM companion_files WHERE companion_id = ?').bind(cid).all();
            const bundle = {
              haven_export_version: '1.7.0',
              exported_at: new Date().toISOString(),
              companion: { name: c.name, avatar_url: c.avatar_url },
              identity: identity.results || [],
              memories: memories.results || [],
              people: people.results || [],
              important_dates: dates.results || [],
              files: files.results || [],
            };
            return new Response(JSON.stringify(bundle, null, 2), {
              headers: {
                'Content-Type': 'application/json',
                'Content-Disposition': `attachment; filename="companion-${c.name.replace(/[^a-z0-9]/gi, '-')}.json"`,
                ..._cors,
              },
            });
          }

          // /api/companions/:id/files
          if (sub === 'files') {
            // DELETE /api/companions/:id/files/:fileId
            if (request.method === 'DELETE' && parts[5]) {
              const fileId = Number(parts[5]);
              const row = await env.DB.prepare('SELECT r2_key FROM companion_files WHERE id = ? AND companion_id = ?').bind(fileId, cid).first<{ r2_key: string }>();
              if (row?.r2_key) {
                try { await env.FILES.delete(row.r2_key); } catch {}
              }
              await env.DB.prepare('DELETE FROM companion_files WHERE id = ? AND companion_id = ?').bind(fileId, cid).run();
              return json({ success: true });
            }
            // GET /api/companions/:id/files
            if (request.method === 'GET') {
              const rows = await env.DB.prepare(
                'SELECT id, filename, file_size, file_type, LENGTH(extracted_text) AS text_length, added_at FROM companion_files WHERE companion_id = ? ORDER BY added_at DESC'
              ).bind(cid).all();
              return json(rows.results || []);
            }
            // POST /api/companions/:id/files
            if (request.method === 'POST') {
              const form = await request.formData();
              // Workers's TS lib types don't expose File as a value, so use a
              // structural check on the relevant methods.
              const raw = form.get('file');
              if (!raw || typeof raw === 'string' || typeof (raw as { stream?: unknown }).stream !== 'function') {
                return json({ error: 'file required' }, 400);
              }
              const file = raw as unknown as { name: string; size: number; type: string; stream: () => ReadableStream };
              if (file.size > 20 * 1024 * 1024) return json({ error: 'file exceeds 20MB limit' }, 413);
              const extractedText = String(form.get('extracted_text') || '');
              const extRaw = file.name.split('.').pop() || 'bin';
              const ext = extRaw.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'bin';
              const r2Key = `companion-${cid}/${Date.now()}-${crypto.randomUUID()}.${ext}`;
              await env.FILES.put(r2Key, file.stream(), { httpMetadata: { contentType: file.type } });
              const result = await env.DB.prepare(
                'INSERT INTO companion_files (companion_id, filename, r2_key, file_size, file_type, extracted_text) VALUES (?, ?, ?, ?, ?, ?)'
              ).bind(cid, file.name, r2Key, file.size, file.type || null, extractedText).run();
              return json({ success: true, id: result.meta.last_row_id, r2_key: r2Key });
            }
          }

          // POST /api/companions/:id/archive
          if (sub === 'archive' && request.method === 'POST') {
            if (cid === 1) {
              // Don't archive the default seed companion — at least one must
              // always be active so the default-companion-id logic has somewhere
              // to land.
              return json({ error: 'cannot archive the default companion' }, 400);
            }
            await env.DB.prepare('UPDATE companion SET archived_at = datetime(\'now\') WHERE id = ?').bind(cid).run();
            return json({ success: true });
          }

          // POST /api/companions/:id/restore
          if (sub === 'restore' && request.method === 'POST') {
            await env.DB.prepare('UPDATE companion SET archived_at = NULL WHERE id = ?').bind(cid).run();
            return json({ success: true });
          }

          // PUT /api/companions/:id  (update name / avatar)
          if (!sub && request.method === 'PUT') {
            const { name, avatar_url } = await request.json() as any;
            await env.DB.prepare(
              'UPDATE companion SET name = COALESCE(?, name), avatar_url = COALESCE(?, avatar_url) WHERE id = ?'
            ).bind(name?.trim() || null, avatar_url ?? null, cid).run();
            return json({ success: true });
          }

          // GET /api/companions/:id (single companion fetch)
          if (!sub && request.method === 'GET') {
            const c = await env.DB.prepare('SELECT * FROM companion WHERE id = ?').bind(cid).first();
            if (!c) return json({ error: 'companion not found' }, 404);
            return json(c);
          }
        }
      }

      // ---- Identity (scoped to active companion via X-Companion-Id) ----
      if (path === '/api/identity' && request.method === 'GET') {
        const cid = getCompanionId(request);
        const identity = await env.DB.prepare(
          'SELECT * FROM identity WHERE companion_id = ? ORDER BY pinned DESC, priority DESC'
        ).bind(cid).all();
        return json(identity.results || []);
      }

      if (path === '/api/identity' && request.method === 'POST') {
        const cid = getCompanionId(request);
        const { content, identity_type = 'trait', priority = 5, pinned = false } = await request.json() as any;
        const result = await env.DB.prepare(
          'INSERT INTO identity (companion_id, content, identity_type, priority, pinned) VALUES (?, ?, ?, ?, ?)'
        ).bind(cid, content, identity_type, priority, pinned ? 1 : 0).run();
        return json({ success: true, id: result.meta.last_row_id });
      }

      if (path.startsWith('/api/identity/') && request.method === 'DELETE') {
        const cid = getCompanionId(request);
        const id = path.split('/')[3];
        // Scope by companion_id so a client cannot delete another companion's
        // identity rows even if they guess the id.
        await env.DB.prepare('DELETE FROM identity WHERE id = ? AND companion_id = ?').bind(id, cid).run();
        return json({ success: true });
      }

      // ---- Memories (scoped) ----
      if (path === '/api/memories' && request.method === 'GET') {
        const cid = getCompanionId(request);
        const memories = await env.DB.prepare(
          'SELECT * FROM memories WHERE companion_id = ? ORDER BY created_at DESC LIMIT 50'
        ).bind(cid).all();
        return json(memories.results || []);
      }

      if (path === '/api/memories' && request.method === 'POST') {
        const cid = getCompanionId(request);
        const { content, memory_type = 'core', emotional_weight = 5 } = await request.json() as any;
        await env.DB.prepare(
          'INSERT INTO memories (companion_id, content, memory_type, emotional_weight) VALUES (?, ?, ?, ?)'
        ).bind(cid, content, memory_type, emotional_weight).run();
        return json({ success: true });
      }

      // ---- Settings ----
      // Anyone with a Haven Worker URL can GET /api/settings. Before v1.6.2 this
      // returned raw API keys (OpenRouter, Anthropic, etc.) to any caller. Now
      // we redact anything that looks like a secret to a fixed placeholder, and
      // PUT skips writes when the placeholder comes back unchanged — so the
      // round-trip preserves the real key when a user hits Save without retyping.
      const SETTINGS_SECRET_PLACEHOLDER = '***set***';
      const SETTINGS_SECRET_PATTERN = /_key$|_token$|_secret$|password/i;
      const ALLOWED_SETTINGS_KEYS = new Set([
        'provider',
        'openrouter_key',
        'custom_key', 'custom_base_url',
        'ollama_url', 'ollama_key',
        'companion_status', 'companion_presence',
        'user_status', 'user_presence',
        'mcp_tool_limit',
        'giphy_key',
        // Per-provider on/off toggles. Absent/empty = enabled (back compat).
        // "false" (string) = disabled. Worker treats disabled providers as
        // if they had no key when resolving chat requests or listing models.
        'openrouter_enabled', 'ollama_enabled', 'custom_enabled',
      ]);

      if (path === '/api/settings' && request.method === 'GET') {
        const settings = await env.DB.prepare('SELECT * FROM settings').all();
        const obj: Record<string, string> = {};
        for (const row of (settings.results || []) as Array<{ key: string; value: string }>) {
          if (SETTINGS_SECRET_PATTERN.test(row.key) && row.value) {
            obj[row.key] = SETTINGS_SECRET_PLACEHOLDER;
          } else {
            obj[row.key] = row.value;
          }
        }
        return json(obj);
      }

      if (path === '/api/settings' && request.method === 'PUT') {
        const body = await request.json() as Record<string, string>;
        for (const [key, value] of Object.entries(body)) {
          if (!ALLOWED_SETTINGS_KEYS.has(key)) continue; // reject unknown keys
          if (value === SETTINGS_SECRET_PLACEHOLDER) continue; // preserve existing secret
          await env.DB.prepare(
            'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)'
          ).bind(key, value).run();
        }
        return json({ success: true });
      }

      // ---- Status ---- (scoped per companion since v1.7.2 — one status per
      // companion instead of a global key that multi-companion setups would
      // stomp on each other's writes. Falls back to the old global key for
      // backward compatibility with pre-v1.7.2 D1s so existing deployments
      // don't see their one status disappear on upgrade.)
      if (path === '/api/status' && request.method === 'GET') {
        const sid = getCompanionId(request);
        const scopedStatus = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(`companion_status:${sid}`).first<{ value: string }>();
        const scopedPresence = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(`companion_presence:${sid}`).first<{ value: string }>();
        let statusValue = scopedStatus?.value ?? null;
        let presenceValue = scopedPresence?.value ?? null;
        if (statusValue === null) {
          const legacy = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind('companion_status').first<{ value: string }>();
          statusValue = legacy?.value ?? null;
        }
        if (presenceValue === null) {
          const legacy = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind('companion_presence').first<{ value: string }>();
          presenceValue = legacy?.value ?? null;
        }
        return json({
          custom_status: statusValue,
          presence: presenceValue || 'online',
        });
      }

      if (path === '/api/status' && request.method === 'PUT') {
        const sid = getCompanionId(request);
        const body = await request.json() as { custom_status?: string; presence?: string };
        if (body.custom_status !== undefined) {
          await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind(`companion_status:${sid}`, body.custom_status).run();
        }
        if (body.presence) {
          await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind(`companion_presence:${sid}`, body.presence).run();
        }
        return json({ success: true });
      }

      // ---- User Status ----
      if (path === '/api/user-status' && request.method === 'GET') {
        const statusRow = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind('user_status').first<{ value: string }>();
        const presenceRow = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind('user_presence').first<{ value: string }>();
        return json({
          custom_status: statusRow?.value || null,
          presence: presenceRow?.value || 'online',
        });
      }

      if (path === '/api/user-status' && request.method === 'PUT') {
        const body = await request.json() as { custom_status?: string; presence?: string };
        if (body.custom_status !== undefined) {
          await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind('user_status', body.custom_status).run();
        }
        if (body.presence) {
          await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind('user_presence', body.presence).run();
        }
        return json({ success: true });
      }

      // ---- Models ----
      if (path === '/api/models' && request.method === 'GET') {
        const models: Array<{ id: string; name: string; provider: string; tier: string; description?: string; context_length?: number; supports_tools?: boolean }> = [];
        // Per-provider toggles suppress that provider's models from the
        // picker entirely when disabled.
        const [orEnabled, ollamaEnabled, customEnabled] = await Promise.all([
          isProviderEnabled(env.DB, 'openrouter'),
          isProviderEnabled(env.DB, 'ollama'),
          isProviderEnabled(env.DB, 'custom'),
        ]);
        const hasOpenRouter = orEnabled ? (env.OPENROUTER_API_KEY || await getSettingValue(env.DB, 'openrouter_key')) : null;

        // Fetch live models from OpenRouter (skip entirely if disabled)
        if (orEnabled) try {
          const res = await fetch('https://openrouter.ai/api/v1/models');
          const data = await res.json() as any;
          for (const m of (data.data || [])) {
            const isFree = m.id?.endsWith(':free') || (Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0);
            // Free models always listed. Paid models listed only when the user
            // has their own OpenRouter key configured (so charges go to them).
            if (isFree || hasOpenRouter) {
              // OpenRouter publishes supported_parameters per model — if
              // 'tools' isn't in there, tool calling will 404 for every
              // provider route. We surface this to the picker so users
              // don't pick Gemma-on-OR expecting tool use.
              const supportsTools = Array.isArray(m.supported_parameters)
                ? m.supported_parameters.includes('tools')
                : undefined;
              models.push({
                id: m.id,
                name: m.name || m.id,
                provider: 'openrouter',
                tier: isFree ? 'free' : 'paid',
                description: m.description || undefined,
                context_length: m.context_length || undefined,
                supports_tools: supportsTools,
              });
            }
          }
        } catch {
          // Fallback if OpenRouter API is down
          models.push(
            { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini', provider: 'openrouter', tier: 'paid' },
            { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4', provider: 'openrouter', tier: 'paid' },
          );
        }

        // Add Ollama models if configured AND enabled
        const ollamaUrl = env.OLLAMA_URL || await getSettingValue(env.DB, 'ollama_url') || 'https://api.ollama.com';
        const ollamaKey = ollamaEnabled ? await getSettingValue(env.DB, 'ollama_key') : null;
        if (ollamaEnabled && (ollamaKey || (ollamaUrl && ollamaUrl.startsWith('http')))) {
          try {
            const ollamaHeaders: Record<string, string> = {};
            if (ollamaKey) ollamaHeaders['Authorization'] = `Bearer ${ollamaKey}`;
            let ollamaModels: string[] = [];
            try {
              const res = await fetch(`${ollamaUrl}/v1/models`, { headers: ollamaHeaders });
              const data = await res.json() as any;
              ollamaModels = (data.data || []).map((m: any) => m.id);
            } catch {
              try {
                const res = await fetch(`${ollamaUrl}/api/tags`, { headers: ollamaHeaders });
                const data = await res.json() as any;
                ollamaModels = (data.models || []).map((m: any) => m.name);
              } catch {}
            }
            for (const id of ollamaModels) {
              // Ollama Cloud doesn't publish per-model tool-call support via
              // the models endpoint. Rather than guess (we were wrongly
              // flagging Gemma as non-tool-capable based on one timeout),
              // leave supports_tools undefined so the picker shows no badge
              // and users can discover empirically. The upstream-error
              // notice handles degraded fallbacks cleanly.
              models.push({ id, name: id, provider: 'ollama', tier: 'included' });
            }
          } catch {}
        }

        // Add custom provider models (HuggingFace, Groq, OpenAI, etc.)
        const customKey = customEnabled ? await getSettingValue(env.DB, 'custom_key') : null;
        const customBaseUrl = customEnabled ? await getSettingValue(env.DB, 'custom_base_url') : null;
        if (customEnabled && customKey && customBaseUrl) {
          let customProvider = 'custom';
          if (customBaseUrl.includes('huggingface') || customBaseUrl.includes('hf.co')) customProvider = 'huggingface';
          else if (customBaseUrl.includes('groq.com')) customProvider = 'groq';
          else if (customBaseUrl.includes('openai.com')) customProvider = 'openai';
          else if (customBaseUrl.includes('anthropic.com')) customProvider = 'anthropic';
          else if (customBaseUrl.includes('x.ai')) customProvider = 'xai';

          if (customProvider === 'anthropic') {
            let anthropicLoaded = false;
            try {
              const res = await fetch(`${customBaseUrl}/models`, {
                headers: { 'x-api-key': customKey, 'anthropic-version': '2023-06-01' },
              });
              if (res.ok) {
                const data = await res.json() as any;
                const items = data.data || [];
                if (items.length > 0) {
                  for (const m of items) {
                    models.push({ id: m.id, name: m.display_name || m.id, provider: 'anthropic', tier: 'included', description: m.description || undefined });
                  }
                  anthropicLoaded = true;
                }
              }
            } catch {}
            if (!anthropicLoaded) {
              models.push(
                { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', provider: 'anthropic', tier: 'included', context_length: 200000 },
                { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', provider: 'anthropic', tier: 'included', context_length: 200000 },
                { id: 'claude-opus-4-20250514', name: 'Claude Opus 4', provider: 'anthropic', tier: 'included', context_length: 200000 },
                { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet', provider: 'anthropic', tier: 'included', context_length: 200000 },
              );
            }
          } else {
            try {
              const res = await fetch(`${customBaseUrl}/models`, {
                headers: { 'Authorization': `Bearer ${customKey}` },
              });
              const data = await res.json() as any;
              for (const m of (data.data || [])) {
                models.push({ id: m.id, name: m.id, provider: customProvider, tier: 'included' });
              }
            } catch {}
          }
        }

        return json(models);
      }

      // ---- Import Message (bulk insert) ----
      if (path === '/api/import/message' && request.method === 'POST') {
        const { thread_id, role, content, model, created_at } = await request.json() as any;
        const id = crypto.randomUUID();
        await env.DB.prepare(
          'INSERT INTO messages (id, thread_id, role, content, model, created_at) VALUES (?, ?, ?, ?, ?, ?)'
        ).bind(id, thread_id, role === 'user' ? 'user' : 'companion', content, model || null, created_at || new Date().toISOString()).run();

        // Update thread timestamp
        await env.DB.prepare(
          'UPDATE threads SET last_message_at = ? WHERE id = ?'
        ).bind(created_at || new Date().toISOString(), thread_id).run();

        return json({ success: true });
      }

      // ---- Storage Usage (R2) ----
      if (path === '/api/storage' && request.method === 'GET') {
        let chatCount = 0, chatBytes = 0, projectCount = 0, projectBytes = 0;
        let cursor: string | undefined;
        do {
          const list = await env.FILES.list({ cursor, limit: 500 });
          for (const obj of list.objects) {
            if (obj.key.startsWith('companion-')) {
              projectCount++;
              projectBytes += obj.size;
            } else {
              chatCount++;
              chatBytes += obj.size;
            }
          }
          cursor = list.truncated ? list.cursor : undefined;
        } while (cursor);
        return json({ chat: { count: chatCount, bytes: chatBytes }, project: { count: projectCount, bytes: projectBytes } });
      }

      if (path === '/api/storage/chat-files' && request.method === 'DELETE') {
        let deleted = 0;
        let cursor: string | undefined;
        do {
          const list = await env.FILES.list({ cursor, limit: 500 });
          const chatKeys = list.objects.filter(o => !o.key.startsWith('companion-')).map(o => o.key);
          if (chatKeys.length > 0) {
            await env.FILES.delete(chatKeys);
            deleted += chatKeys.length;
          }
          cursor = list.truncated ? list.cursor : undefined;
        } while (cursor);
        return json({ success: true, deleted });
      }

      // ---- File Upload (R2) ----
      if (path === '/api/upload' && request.method === 'POST') {
        const formData = await request.formData();
        const file = formData.get('file') as File;
        if (!file) return json({ error: 'No file provided' }, 400);

        const ext = file.name.split('.').pop() || 'bin';
        const key = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

        await env.FILES.put(key, file.stream(), {
          httpMetadata: { contentType: file.type },
        });

        return json({ success: true, key, url: `/api/files/${key}` });
      }

      // ---- File Serve (R2) ----
      if (path.startsWith('/api/files/') && request.method === 'GET') {
        const key = path.replace('/api/files/', '');
        const object = await env.FILES.get(key);
        if (!object) return json({ error: 'File not found' }, 404);

        return new Response(object.body, {
          headers: {
            'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream',
            'Cache-Control': 'public, max-age=86400',
            ..._cors,
          },
        });
      }

      // ---- Export Thread (verified against active companion) ----
      if (path.startsWith('/api/export/thread/') && request.method === 'GET') {
        const cid = getCompanionId(request);
        const threadId = path.split('/')[4];
        const thread = await env.DB.prepare('SELECT * FROM threads WHERE id = ?').bind(threadId).first<any>();
        if (!thread) return json({ error: 'Thread not found' }, 404);
        if (thread.companion_id !== cid) return json({ error: 'thread belongs to a different companion' }, 403);

        const messages = await env.DB.prepare(
          'SELECT role, content, model, created_at FROM messages WHERE thread_id = ? ORDER BY created_at ASC'
        ).bind(threadId).all();

        const companion = await env.DB.prepare('SELECT name FROM companion WHERE id = ?').bind(cid).first<{ name: string }>();

        const exported = {
          haven_version: '1.7.0',
          exported_at: new Date().toISOString(),
          companion: companion?.name || 'Companion',
          thread: { id: threadId, title: thread.title, created_at: thread.created_at },
          messages: (messages.results || []).map((m: any) => ({
            role: m.role,
            content: m.content,
            model: m.model,
            timestamp: m.created_at,
          })),
        };

        return new Response(JSON.stringify(exported, null, 2), {
          headers: {
            'Content-Type': 'application/json',
            'Content-Disposition': `attachment; filename="haven-${threadId.slice(0, 8)}.json"`,
            ..._cors,
          },
        });
      }

      // ---- Export All (full backup — every companion + global settings) ----
      if (path === '/api/export/all' && request.method === 'GET') {
        // Includes companion_id in each scoped row so an import flow can
        // reconstruct the multi-companion state.
        const companions = await env.DB.prepare('SELECT * FROM companion ORDER BY id ASC').all();
        const identity = await env.DB.prepare('SELECT * FROM identity ORDER BY companion_id, pinned DESC, priority DESC').all();
        const threads = await env.DB.prepare('SELECT * FROM threads ORDER BY companion_id, last_message_at DESC').all();
        const memories = await env.DB.prepare('SELECT * FROM memories ORDER BY companion_id, created_at DESC').all();
        const people = await env.DB.prepare('SELECT * FROM people ORDER BY companion_id').all();
        const dates = await env.DB.prepare('SELECT * FROM important_dates ORDER BY companion_id').all();
        const files = await env.DB.prepare('SELECT companion_id, filename, file_size, file_type, extracted_text FROM companion_files ORDER BY companion_id, added_at DESC').all();

        // Get all messages per thread
        const threadData = [];
        for (const thread of (threads.results || []) as any[]) {
          const msgs = await env.DB.prepare(
            'SELECT role, content, model, created_at FROM messages WHERE thread_id = ? ORDER BY created_at ASC'
          ).bind(thread.id).all();
          threadData.push({
            ...thread,
            messages: msgs.results || [],
          });
        }

        const exported = {
          haven_version: '1.7.0',
          exported_at: new Date().toISOString(),
          companions: companions.results || [],
          identity: identity.results || [],
          threads: threadData,
          memories: memories.results || [],
          people: people.results || [],
          important_dates: dates.results || [],
          companion_files: files.results || [],
        };

        return new Response(JSON.stringify(exported, null, 2), {
          headers: {
            'Content-Type': 'application/json',
            'Content-Disposition': `attachment; filename="haven-export-${new Date().toISOString().split('T')[0]}.json"`,
            ..._cors,
          },
        });
      }

      // ---- MCP Servers ----
      if (path === '/api/mcp-servers' && request.method === 'GET') {
        const servers = await env.DB.prepare('SELECT id, name, url, enabled, last_discovered, created_at FROM mcp_servers ORDER BY created_at ASC').all();
        return json(servers.results || []);
      }

      if (path === '/api/mcp-servers' && request.method === 'POST') {
        const { name, url: serverUrl, api_key } = await request.json() as any;
        if (!name || !serverUrl) return json({ error: 'name and url required' }, 400);

        // Create the mcp_servers table if it doesn't exist (migration-safe)
        await env.DB.prepare(`CREATE TABLE IF NOT EXISTS mcp_servers (
          id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, url TEXT NOT NULL,
          api_key TEXT, enabled INTEGER DEFAULT 1, tools_cache TEXT, last_discovered TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        )`).run();

        const result = await env.DB.prepare(
          'INSERT INTO mcp_servers (name, url, api_key) VALUES (?, ?, ?)'
        ).bind(name, serverUrl, api_key || null).run();

        return json({ success: true, id: result.meta.last_row_id });
      }

      if (path.startsWith('/api/mcp-servers/') && request.method === 'DELETE') {
        const id = path.split('/')[3];
        await env.DB.prepare('DELETE FROM mcp_servers WHERE id = ?').bind(id).run();
        return json({ success: true });
      }

      if (path.startsWith('/api/mcp-servers/') && path.endsWith('/toggle') && request.method === 'PUT') {
        const id = path.split('/')[3];
        await env.DB.prepare('UPDATE mcp_servers SET enabled = CASE WHEN enabled = 1 THEN 0 ELSE 1 END WHERE id = ?').bind(id).run();
        return json({ success: true });
      }

      if (path === '/api/mcp-servers/discover' && request.method === 'POST') {
        const { id } = await request.json() as any;
        const server = await env.DB.prepare('SELECT * FROM mcp_servers WHERE id = ?').bind(id).first<McpServer>();
        if (!server) return json({ error: 'Server not found' }, 404);

        try {
          const tools = await discoverMcpTools(server);
          await env.DB.prepare('UPDATE mcp_servers SET tools_cache = ?, last_discovered = datetime("now") WHERE id = ?')
            .bind(JSON.stringify(tools), id).run();
          return json({ success: true, tools: tools.map(t => ({ name: t.name, description: t.description })) });
        } catch (e) {
          return json({ error: `Discovery failed: ${e}` }, 500);
        }
      }

      if (path === '/api/mcp-tools' && request.method === 'GET') {
        const tools = await loadMcpTools(env.DB);
        return json(tools.map(t => ({ name: t.name, description: t.description, server_id: t.server_id })));
      }

      return json({ error: 'Not found' }, 404);

    } catch (err) {
      return json({ error: String(err) }, 500);
    }
  },
};
