/**
 * Haven — Chat Bridge Worker
 * Handles inference (Ollama/OpenRouter), D1 persistence, and CI loading
 */

export { CodexRelay } from './codex-relay';

interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  CODEX_RELAY: DurableObjectNamespace;
  OPENROUTER_API_KEY?: string;
  OLLAMA_URL?: string;
}

function getCorsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('Origin');
  const allowedOrigin = origin && (origin.endsWith('.pages.dev') || origin.endsWith('.workers.dev') || origin.startsWith('http://localhost') || origin.startsWith('capacitor://')) ? origin : '*';
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
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

async function getAuthToken(db: D1Database): Promise<string | null> {
  return await getSettingValue(db, 'auth_token') || null;
}

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

// Web search — gated behind the per-message web-search toggle, so it is NOT
// in NATIVE_TOOLS (which are always advertised). It is only added to the tool
// list when the request sets web_search:true (see inferenceWithTools). Its
// name still lives in NATIVE_TOOL_NAMES so the execution dispatch routes a
// call to executeNativeTool rather than hunting for a (nonexistent) MCP server.
const WEB_SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'web_search',
    description: 'Search the public web for current, real-world information — recent events, facts you are unsure of, anything that benefits from up-to-date sources. Returns the top results as title / URL / snippet. Call it when the user asks about something you do not reliably know, then answer from the results and cite the URLs.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query in plain words, as you would type into a search engine.',
        },
      },
      required: ['query'],
    },
  },
};

const NATIVE_TOOL_NAMES = new Set([...NATIVE_TOOLS, WEB_SEARCH_TOOL].map(t => t.function.name));

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

  if (name === 'web_search') {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) return 'web_search error: query required';
    return await searchDuckDuckGo(query);
  }

  return `Unknown native tool: ${name}`;
}

// Strip HTML tags + decode the handful of entities DuckDuckGo emits.
function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

// Free, keyless web search via DuckDuckGo's HTML endpoint. No API key, so any
// Haven user gets it with zero setup when they flip the toggle. Parses the
// result anchors + snippets out of the returned HTML. DuckDuckGo occasionally
// rate-limits datacenter IPs (Cloudflare's); on an empty/blocked response we
// return a plain message the model can relay rather than throwing.
async function searchDuckDuckGo(query: string): Promise<string> {
  try {
    const resp = await fetch('https://html.duckduckgo.com/html/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        // A browser-ish UA reduces the chance of being served a challenge page.
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      },
      body: `q=${encodeURIComponent(query)}`,
    });
    if (!resp.ok) return `web_search: DuckDuckGo returned ${resp.status}. Try rephrasing or answer from what you know.`;
    const html = await resp.text();

    const results: Array<{ title: string; url: string; snippet: string }> = [];
    // Result links: <a ... class="result__a" href="//duckduckgo.com/l/?uddg=<encoded-url>...">Title</a>
    const linkRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    // Snippets: <a ... class="result__snippet" ...>Snippet</a>
    const snippetRe = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
    const snippets: string[] = [];
    let sm: RegExpExecArray | null;
    while ((sm = snippetRe.exec(html)) !== null) snippets.push(stripHtml(sm[1]));

    let lm: RegExpExecArray | null;
    let idx = 0;
    while ((lm = linkRe.exec(html)) !== null && results.length < 5) {
      let url = lm[1];
      const uddg = url.match(/[?&]uddg=([^&]+)/);
      if (uddg) url = decodeURIComponent(uddg[1]);
      else if (url.startsWith('//')) url = `https:${url}`;
      const title = stripHtml(lm[2]);
      const snippet = (snippets[idx] || '').slice(0, 300);
      idx++;
      if (title) results.push({ title, url, snippet });
    }

    if (results.length === 0) {
      return `web_search: no results parsed for "${query}" (DuckDuckGo may have rate-limited this request). Answer from what you know and say you couldn't search.`;
    }

    const out = results
      .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`)
      .join('\n\n');
    return `Web search results for "${query}":\n\n${out}`;
  } catch (e) {
    return `web_search error: ${e}. Answer from what you know and note that the search failed.`;
  }
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
  temperature?: number,
  cache = false,
  cacheTtl?: string,
  webSearch = false,
): Promise<{ content: string; toolResults: Array<{ name: string; arguments?: any; result: string; server?: string; ok: boolean }>; usage: UsageSink }> {
  // Combine MCP tool schemas with Haven-native ones (update_my_status, etc.)
  // so the model sees them as a unified toolbox. Execution branches later on
  // whether the name is in NATIVE_TOOL_NAMES. web_search is only advertised
  // when the user flipped the per-message web-search toggle.
  const openaiTools = [...mcpToolsToOpenAI(tools), ...NATIVE_TOOLS, ...(webSearch ? [WEB_SEARCH_TOOL] : [])];
  const toolLookup = new Map(tools.map(t => [t.name, t]));

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const resolved = await resolveProviderConfig(provider, env.DB, env);
  let url: string;
  let isAnthropic = resolved.format === 'anthropic';
  if (resolved.format === 'ollama') {
    // Native /api/chat: both local Ollama and Ollama Cloud serve it (the
    // OpenAI-compatible /v1 endpoint 405s on Ollama Cloud). It supports tools
    // and returns data.message.tool_calls (args as an object). The parsing
    // below normalizes that against the OpenAI shape (data.choices[0]).
    url = `${resolved.url}/api/chat`;
    if (resolved.key) headers['Authorization'] = `Bearer ${resolved.key}`;
  } else if (isAnthropic) {
    url = `${resolved.url}/messages`;
    headers['x-api-key'] = resolved.key || '';
    headers['anthropic-version'] = '2023-06-01';
  } else {
    url = `${resolved.url}/chat/completions`;
    headers['Authorization'] = `Bearer ${resolved.key}`;
    if (provider === 'openrouter') headers['X-Title'] = 'Haven';
  }

  const conversation = [...messages];
  if (thinking && !isAnthropic && conversation.length > 0 && conversation[0].role === 'system') {
    conversation[0] = { ...conversation[0], content: conversation[0].content + '\n\nThink through your reasoning step by step inside <think> tags before giving your response. Example:\n<think>\n[your reasoning here]\n</think>\n[your response here]' };
  }
  const allToolResults: Array<{ name: string; arguments?: any; result: string; server?: string; ok: boolean }> = [];
  const usage: UsageSink = {};
  // Token usage accumulates across tool-loop iterations + the final nudge pass.
  const addUsage = (data: any) => {
    const u = data?.usage;
    if (u) {
      usage.input = (usage.input || 0) + (u.input_tokens ?? u.prompt_tokens ?? 0);
      usage.output = (usage.output || 0) + (u.output_tokens ?? u.completion_tokens ?? 0);
      usage.exact = true;
    } else if (data?.prompt_eval_count || data?.eval_count) {
      usage.input = (usage.input || 0) + (data.prompt_eval_count || 0);
      usage.output = (usage.output || 0) + (data.eval_count || 0);
      usage.exact = true;
    }
  };
  const MAX_ITERATIONS = 5;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    let resp: Response;
    if (isAnthropic) {
      const { system, messages: anthropicMsgs } = buildAnthropicMessages(conversation);
      const usesBudgetThinking = thinking && /claude-sonnet-4-5|claude-opus-4-[56]/.test(model);
      const noTemperature = /claude-opus-4-[789]/.test(model);
      const body: any = { model, messages: anthropicMsgs, max_tokens: thinking ? 16000 : 4096, stream: false };
      if (!noTemperature) body.temperature = temperature ?? 0.8;
      if (thinking) {
        if (usesBudgetThinking) body.thinking = { type: 'enabled', budget_tokens: 10000 };
        else body.thinking = { type: 'adaptive' };
      }
      if (system) body.system = cache
        ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral', ...(cacheTtl && { ttl: cacheTtl }) } }]
        : system;
      if (openaiTools.length > 0) {
        body.tools = openaiToolsToAnthropic(openaiTools);
        body.tool_choice = { type: 'auto' };
      }
      resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    } else {
      resp = await fetch(url, {
        method: 'POST', headers,
        body: JSON.stringify({ model, messages: resolved.format === 'ollama' ? normalizeMessagesForOllama(conversation) : conversation, tools: openaiTools, tool_choice: 'auto', temperature: temperature ?? 0.8, stream: false }),
      });
    }

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Inference error ${resp.status}: ${errText.slice(0, 200)}`);
    }

    const data = await resp.json() as any;
    addUsage(data);

    if (isAnthropic) {
      const thinkingParts = (data.content || []).filter((b: any) => b.type === 'thinking').map((b: any) => b.thinking).join('');
      const textParts = (data.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
      const toolUses = (data.content || []).filter((b: any) => b.type === 'tool_use');
      const fullText = thinkingParts ? `<think>${thinkingParts}</think>\n${textParts}` : textParts;

      if (toolUses.length === 0) {
        if (fullText.trim()) return { content: fullText, toolResults: allToolResults, usage };
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
        allToolResults.push({ name: tu.name, arguments: tu.input, result, server, ok });
        toolResultContent.push({ type: 'tool_result', tool_use_id: tu.id, content: result });
      }
      conversation.push({ role: 'user', content: toolResultContent } as any);
    } else {
      // Normalize OpenAI (choices[0].message) and native Ollama (message) shapes.
      const message = data.choices?.[0]?.message ?? data.message;

      if (!message?.tool_calls?.length) {
        const content = (message?.content || '').trim();
        if (content) return { content, toolResults: allToolResults, usage };
        break;
      }

      conversation.push(message);

      for (const tc of message.tool_calls) {
        const fn = tc.function;
        let result = `Unknown tool: ${fn.name}`;
        let ok = false;
        let server: string | undefined;
        let args: any = {};
        try {
          args = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments || '{}') : (fn.arguments ?? {});
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
        allToolResults.push({ name: fn.name, arguments: args, result, server, ok });
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
          messages: resolved.format === 'ollama' ? normalizeMessagesForOllama([...conversation, { role: 'user', content: nudge }]) : [...conversation, { role: 'user', content: nudge }],
          temperature: 0.8,
          stream: false,
        }),
      });
    }
    if (finalResp.ok) {
      const finalData = await finalResp.json() as any;
      addUsage(finalData);
      let finalContent = '';
      if (isAnthropic) {
        finalContent = (finalData.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
      } else {
        finalContent = finalData?.choices?.[0]?.message?.content || finalData?.message?.content || '';
      }
      if (finalContent) {
        return { content: finalContent, toolResults: allToolResults, usage };
      }
    }
  } catch { /* fall through to informative placeholder */ }

  const names = allToolResults.map(r => r.name).join(', ');
  return {
    content: `(Hit tool-call limit without a text reply. Called: ${names || 'nothing recognized'}. Try again — or pick a less tool-happy model.)`,
    toolResults: allToolResults,
    usage,
  };
}

// ============================================================
// Proactive memory — background extraction + consolidation
// ============================================================
//
// Opt-in (settings key proactive_memory_enabled). After every N assistant
// turns we pull durable facts out of the recent conversation and save them;
// once enough accumulate we fold them into a single long-term summary. All of
// this runs via ctx.waitUntil AFTER the reply has streamed, so it never adds
// latency, and every step is best-effort (failures are swallowed and logged).

// Model output 'type' → the memories.memory_type CHECK enum. SQLite can't ALTER
// a CHECK constraint, so anything off-list collapses to 'core'.
const MEMORY_TYPE_MAP: Record<string, string> = {
  core: 'core', pattern: 'pattern', moment: 'moment', preference: 'preference',
  fact: 'core', event: 'moment', habit: 'pattern', like: 'preference', dislike: 'preference',
};

// Small non-streaming, no-tools completion. Mirrors the provider plumbing in
// inferenceWithTools but skips the 5-iteration tool loop — the memory passes
// only need plain text/JSON back.
async function simpleCompletion(
  env: Env, provider: string, model: string, system: string, user: string,
  usageSink?: UsageSink,
): Promise<string> {
  const resolved = await resolveProviderConfig(provider, env.DB, env);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const isAnthropic = resolved.format === 'anthropic';
  let url: string;
  if (resolved.format === 'ollama') {
    url = `${resolved.url}/api/chat`;
    if (resolved.key) headers['Authorization'] = `Bearer ${resolved.key}`;
  } else if (isAnthropic) {
    url = `${resolved.url}/messages`;
    headers['x-api-key'] = resolved.key || '';
    headers['anthropic-version'] = '2023-06-01';
  } else {
    url = `${resolved.url}/chat/completions`;
    headers['Authorization'] = `Bearer ${resolved.key}`;
    if (provider === 'openrouter') headers['X-Title'] = 'Haven';
  }

  let resp: Response;
  if (isAnthropic) {
    resp = await fetch(url, {
      method: 'POST', headers,
      body: JSON.stringify({
        model, max_tokens: 1024, temperature: 0.3, stream: false,
        system, messages: [{ role: 'user', content: user }],
      }),
    });
  } else if (resolved.format === 'ollama') {
    resp = await fetch(url, {
      method: 'POST', headers,
      body: JSON.stringify({
        model, stream: false, options: { temperature: 0.3 },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
    });
  } else {
    resp = await fetch(url, {
      method: 'POST', headers,
      body: JSON.stringify({
        model, temperature: 0.3, stream: false,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
    });
  }
  if (!resp.ok) throw new Error(`simpleCompletion ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json() as any;
  if (usageSink) {
    const u = data?.usage;
    if (u) {
      usageSink.input = u.input_tokens ?? u.prompt_tokens ?? 0;
      usageSink.output = u.output_tokens ?? u.completion_tokens ?? 0;
      usageSink.exact = true;
    } else if (data?.prompt_eval_count || data?.eval_count) {
      usageSink.input = data.prompt_eval_count || 0;
      usageSink.output = data.eval_count || 0;
      usageSink.exact = true;
    }
  }
  if (isAnthropic) {
    return (data.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
  }
  // OpenAI-compatible (choices[0].message) and Ollama native (message.content).
  return data?.choices?.[0]?.message?.content || data?.message?.content || '';
}

// Extract durable facts from the last few turns and save them as source='extracted'.
async function runExtraction(
  env: Env, db: D1Database, companionId: number, threadId: string,
  memModel: string, memProvider: string,
): Promise<void> {
  const rows = await db.prepare(
    'SELECT role, content FROM messages WHERE thread_id = ? ORDER BY created_at DESC LIMIT 12'
  ).bind(threadId).all<{ role: string; content: string }>();
  const msgs = (rows.results || []).reverse();
  if (msgs.length < 2) return;
  const transcript = msgs
    .map(m => `${m.role === 'companion' ? 'Assistant' : 'User'}: ${m.content}`)
    .join('\n');

  const system =
    'You are a memory keeper. Read the conversation and pull out only what is worth ' +
    'remembering about the user months from now — lasting traits, tastes, relationships, ' +
    'beliefs, biographical details, recurring habits, and long-term goals. Ignore passing ' +
    'moods, the current task, one-off questions, and anything pasted in like code or logs. ' +
    'Respond with ONLY a JSON array — no prose. Each item: ' +
    '{"content": one short self-contained sentence, ' +
    '"type": one of "core"|"pattern"|"moment"|"preference", ' +
    '"weight": integer 1-10 for how significant it is}. ' +
    'Do not invent anything. If nothing is worth keeping, return [].';
  const user = `Conversation:\n${transcript}\n\nReturn the JSON array now.`;

  let raw: string;
  const exUsage: UsageSink = {};
  try {
    raw = await simpleCompletion(env, memProvider, memModel, system, user, exUsage);
  } catch (e) {
    console.log(`[MEMORY] extraction inference failed: ${e}`);
    return;
  }
  try {
    await logUsage(db, companionId, memModel, memProvider, exUsage, 'memory', `${system}\n${user}`, raw);
  } catch { /* best-effort */ }

  let parsed: any[];
  try {
    const cleaned = raw.replace(/```json\s*|\s*```/g, '').trim();
    const start = cleaned.indexOf('[');
    const end = cleaned.lastIndexOf(']');
    if (start === -1 || end === -1 || end <= start) return;
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    console.log('[MEMORY] extraction JSON parse failed');
    return;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return;

  const existing = await db.prepare('SELECT LOWER(content) AS c FROM memories WHERE companion_id = ?')
    .bind(companionId).all<{ c: string }>();
  const seen = new Set((existing.results || []).map(r => r.c));

  for (const item of parsed) {
    const content = typeof item?.content === 'string' ? item.content.trim() : '';
    if (!content || content.length < 4) continue;
    const key = content.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const mtype = MEMORY_TYPE_MAP[String(item?.type).toLowerCase()] || 'core';
    let weight = Number(item?.weight);
    if (!Number.isFinite(weight)) weight = 5;
    weight = Math.max(0, Math.min(10, Math.round(weight)));
    try {
      await db.prepare(
        `INSERT INTO memories (companion_id, content, memory_type, emotional_weight, source)
         VALUES (?, ?, ?, ?, 'extracted')`
      ).bind(companionId, content, mtype, weight).run();
    } catch (e) {
      console.log(`[MEMORY] insert skipped: ${e}`);
    }
  }
}

// Fold accumulated memories into one compact long-term summary when they pile up.
async function maybeConsolidate(
  env: Env, db: D1Database, companionId: number, memModel: string, memProvider: string,
): Promise<void> {
  const threshold = await getNumberSetting(db, 'memory_consolidate_at', 40);
  const cnt = await db.prepare(
    "SELECT COUNT(*) AS n FROM memories WHERE companion_id = ? AND source IN ('extracted','manual')"
  ).bind(companionId).first<{ n: number }>();
  if ((cnt?.n ?? 0) <= threshold) return;
  await runConsolidation(env, db, companionId, memModel, memProvider);
}

async function runConsolidation(
  env: Env, db: D1Database, companionId: number, memModel: string, memProvider: string,
): Promise<void> {
  const state = await db.prepare('SELECT consolidated_body FROM memory_state WHERE companion_id = ?')
    .bind(companionId).first<{ consolidated_body: string | null }>();
  const prior = state?.consolidated_body || '';

  // Only fold the auto-extracted rows. Hand-written ('manual') rows stay as-is.
  const rows = await db.prepare(
    "SELECT id, content FROM memories WHERE companion_id = ? AND source = 'extracted' ORDER BY created_at ASC"
  ).bind(companionId).all<{ id: number; content: string }>();
  const list = rows.results || [];
  if (list.length === 0) return;

  const system =
    'You maintain a companion\'s long-term memory. Merge the new entries into the existing ' +
    'memory so it stays accurate and compact. Group related facts, drop duplicates and ' +
    'redundancy, keep only durable things, and drop momentary states or finished tasks. ' +
    'On contradiction the newer entry wins — rewrite, do not keep both. Near the limit, ' +
    'summarize older detail rather than cut recent facts. Stay under ~400 words. ' +
    'Output ONLY the rewritten memory text — no headings, no commentary.';
  const user =
    `EXISTING MEMORY:\n${prior || '(none yet — first pass)'}\n\n` +
    `NEW ENTRIES:\n${list.map(r => `- ${r.content}`).join('\n')}\n\n` +
    'Produce the updated long-term memory now.';

  let body: string;
  const coUsage: UsageSink = {};
  try {
    body = (await simpleCompletion(env, memProvider, memModel, system, user, coUsage)).trim();
  } catch (e) {
    console.log(`[MEMORY] consolidation inference failed: ${e}`);
    return;
  }
  try {
    await logUsage(db, companionId, memModel, memProvider, coUsage, 'memory', `${system}\n${user}`, body);
  } catch { /* best-effort */ }
  if (!body) return;

  await db.prepare(
    `INSERT INTO memory_state (companion_id, consolidated_body, last_consolidated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(companion_id) DO UPDATE SET
       consolidated_body = excluded.consolidated_body,
       last_consolidated_at = excluded.last_consolidated_at`
  ).bind(companionId, body).run();

  // Delete exactly the rows we folded in (by id), so anything extracted
  // concurrently after our SELECT survives to the next pass.
  const ids = list.map(r => r.id);
  if (ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',');
    await db.prepare(
      `DELETE FROM memories WHERE companion_id = ? AND source = 'extracted' AND id IN (${placeholders})`
    ).bind(companionId, ...ids).run();
  }
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

  // Consolidated long-term memory ("dreaming" output) — survives past the
  // recent-10 window so durable facts don't fall off as new memories arrive.
  const memState = await db.prepare(
    'SELECT consolidated_body FROM memory_state WHERE companion_id = ?'
  ).bind(companionId).first<{ consolidated_body: string | null }>();
  const longTermMemory = memState?.consolidated_body?.trim() || '';

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

  const tz = await getSettingValue(db, 'timezone') || 'UTC';
  const now = new Date();
  const dayOfWeek = now.toLocaleDateString('en-US', { weekday: 'long', timeZone: tz });
  const dateStr = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: tz });
  const timeStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz });
  const hour24 = parseInt(now.toLocaleTimeString('en-US', { hour: 'numeric', hour12: false, timeZone: tz }), 10);
  const timeOfDay = hour24 >= 5 && hour24 < 12 ? 'morning' : hour24 >= 12 && hour24 < 17 ? 'afternoon' : hour24 >= 17 && hour24 < 21 ? 'evening' : 'night';

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

  if (longTermMemory) {
    prompt += `## Long-term Memory\n${longTermMemory}\n\n`;
  }

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
      const snippet = f.extracted_text.length > 32000
        ? f.extracted_text.slice(0, 32000) + '\n…[truncated]'
        : f.extracted_text;
      prompt += `<file name="${f.filename}">\n${snippet}\n</file>\n`;
    }
    prompt += `\n`;
  }

  try {
    const emojiRows = await db.prepare('SELECT name FROM custom_media WHERE type = ? ORDER BY added_at DESC').bind('emoji').all<{ name: string }>();
    const emojiNames = (emojiRows.results || []).map(e => `:${e.name}:`);
    if (emojiNames.length > 0) {
      prompt += `## Custom Emoji\nYou can use these custom emoji in your messages: ${emojiNames.join(' ')}. Write the :name: and it will render as the image.\n\n`;
    }
  } catch {}

  prompt += `## Now\n${dayOfWeek}, ${dateStr} • ${timeStr} (${tz}) • ${timeOfDay}\n\n`;

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

async function buildTemporalContext(
  db: D1Database,
  companionId: number,
  threadId?: string | null,
  excludeMessageId?: string,
): Promise<string> {
  if (!threadId) return '';

  const thread = await db.prepare(
    'SELECT companion_id FROM threads WHERE id = ?'
  ).bind(threadId).first<{ companion_id: number }>();
  if (!thread || thread.companion_id !== companionId) return '';

  const previous = excludeMessageId
    ? await db.prepare(
        'SELECT created_at FROM messages WHERE thread_id = ? AND role = "user" AND id != ? ORDER BY created_at DESC LIMIT 1'
      ).bind(threadId, excludeMessageId).first<{ created_at: string }>()
    : await db.prepare(
        'SELECT created_at FROM messages WHERE thread_id = ? AND role = "user" ORDER BY created_at DESC LIMIT 1'
      ).bind(threadId).first<{ created_at: string }>();

  if (!previous?.created_at) return '';
  const gapMins = Math.floor((Date.now() - new Date(previous.created_at).getTime()) / 60000);
  if (gapMins < 2) return '';
  if (gapMins < 60) return `\n## Temporal\nUser returned after ${gapMins} minutes of silence.\n`;
  if (gapMins < 1440) return `\n## Temporal\nUser returned after ${(gapMins / 60).toFixed(1)} hours of silence.\n`;
  return `\n## Temporal\nUser returned after ${(gapMins / 1440).toFixed(1)} days away.\n`;
}

async function getSettingValue(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>();
  return row?.value || null;
}

async function getNumberSetting(db: D1Database, key: string, dflt: number): Promise<number> {
  const v = await getSettingValue(db, key);
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

// Rough token estimate (~4 chars/token) used ONLY when the provider reported no
// usage. Labeled exact=0 in usage_log so the UI can mark it as an estimate.
function estimateTokens(text: string): number {
  return Math.ceil((text || '').length / 4);
}

// Per-million-token USD price defaults. Approximate, drift over time — which is
// why the price table is user-editable (settings key usage_prices, merged over
// these). Keys are matched as case-insensitive substrings of the model id, so
// "claude-opus-4" covers every opus-4.x snapshot. Local models default to free.
type Price = { in: number; out: number };
const DEFAULT_PRICES: Record<string, Price> = {
  'claude-opus-4': { in: 15, out: 75 },
  'claude-sonnet-4': { in: 3, out: 15 },
  'claude-haiku': { in: 0.8, out: 4 },
  'gpt-4o-mini': { in: 0.15, out: 0.6 },
  'gpt-4o': { in: 2.5, out: 10 },
  'gpt-4.1-mini': { in: 0.4, out: 1.6 },
  'gpt-4.1': { in: 2, out: 8 },
  'o1': { in: 15, out: 60 },
};

function priceFor(model: string, merged: Record<string, Price>): Price {
  if (!model) return { in: 0, out: 0 };
  if (merged[model]) return merged[model];
  const lower = model.toLowerCase();
  for (const [k, v] of Object.entries(merged)) {
    if (lower.includes(k.toLowerCase())) return v;
  }
  return { in: 0, out: 0 };
}

// Persist one inference call's token usage. When usage.exact is false we fall
// back to a char-based estimate from the supplied prompt/reply text.
async function logUsage(
  db: D1Database,
  companionId: number,
  model: string,
  provider: string,
  usage: UsageSink,
  source: string,
  estInputText = '',
  estOutputText = '',
): Promise<void> {
  const exact = usage.exact === true;
  const input = exact ? (usage.input || 0) : estimateTokens(estInputText);
  const output = exact ? (usage.output || 0) : estimateTokens(estOutputText);
  if (input === 0 && output === 0) return;
  await db.prepare(
    'INSERT INTO usage_log (companion_id, model, provider, input_tokens, output_tokens, exact, source) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(companionId, model, provider, input, output, exact ? 1 : 0, source).run();
}

const PROVIDER_ENDPOINTS: Record<string, { url: string; keyField: string; format: 'openai' | 'anthropic' | 'ollama' }> = {
  openai: { url: 'https://api.openai.com/v1', keyField: 'openai_key', format: 'openai' },
  anthropic: { url: 'https://api.anthropic.com/v1', keyField: 'anthropic_key', format: 'anthropic' },
  groq: { url: 'https://api.groq.com/openai/v1', keyField: 'groq_key', format: 'openai' },
  xai: { url: 'https://api.x.ai/v1', keyField: 'xai_key', format: 'openai' },
  huggingface: { url: 'https://router.huggingface.co/v1', keyField: 'huggingface_key', format: 'openai' },
  moonshot: { url: 'https://api.moonshot.cn/v1', keyField: 'moonshot_key', format: 'openai' },
};

async function resolveProviderConfig(provider: string, db: D1Database, env: Env): Promise<{ url: string; key: string | null; format: 'openai' | 'anthropic' | 'ollama' }> {
  if (provider === 'ollama') {
    const baseUrl = env.OLLAMA_URL || await getSettingValue(db, 'ollama_url') || 'https://api.ollama.com';
    const key = await getSettingValue(db, 'ollama_key');
    return { url: baseUrl, key, format: 'ollama' };
  }
  if (provider === 'openrouter') {
    const key = env.OPENROUTER_API_KEY || await getSettingValue(db, 'openrouter_key');
    return { url: 'https://openrouter.ai/api/v1', key, format: 'openai' };
  }
  const endpoint = PROVIDER_ENDPOINTS[provider];
  if (endpoint) {
    const key = await getSettingValue(db, endpoint.keyField);
    return { url: endpoint.url, key, format: endpoint.format };
  }
  const orKey = env.OPENROUTER_API_KEY || await getSettingValue(db, 'openrouter_key');
  return { url: 'https://openrouter.ai/api/v1', key: orKey, format: 'openai' };
}

function stringifyOllamaContentPart(part: any): string {
  if (typeof part === 'string') return part;
  if (part == null) return '';
  if (typeof part !== 'object') return String(part);
  if (typeof part.text === 'string') return part.text;
  if (typeof part.content === 'string') return part.content;
  if (part.type === 'image_url') return '[image attached]';
  if (part.type === 'tool_result') {
    return typeof part.content === 'string' ? part.content : JSON.stringify(part.content ?? '');
  }
  if (part.type === 'tool_use') return `[tool_use: ${part.name || 'tool'}]`;
  try {
    return JSON.stringify(part);
  } catch {
    return String(part);
  }
}

function normalizeMessagesForOllama<T extends { role: string; content: any }>(messages: T[]): T[] {
  return messages.map((msg) => {
    let content = msg.content;
    if (Array.isArray(content)) {
      content = content.map(stringifyOllamaContentPart).filter(Boolean).join('\n');
    } else if (content == null) {
      content = '';
    } else if (typeof content !== 'string') {
      content = stringifyOllamaContentPart(content);
    }
    return { ...msg, content };
  });
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
async function isProviderEnabled(db: D1Database, provider: 'openrouter' | 'ollama' | 'custom' | 'codex'): Promise<boolean> {
  const val = await getSettingValue(db, `${provider}_enabled`);
  if (provider === 'codex') return val === 'true';
  return val !== 'false';
}

// Filled in-place by streamInference from provider usage events so the caller
// can log token spend after the stream closes. exact=true when the provider
// reported usage; left undefined when it didn't (caller falls back to estimate).
type UsageSink = { input?: number; output?: number; exact?: boolean };

async function* streamInference(
  messages: Array<{ role: string; content: any }>,
  model: string,
  provider: string,
  env: Env,
  thinking = false,
  temperature?: number,
  cache = false,
  cacheTtl?: string,
  usageSink?: UsageSink,
): AsyncGenerator<string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const resolved = await resolveProviderConfig(provider, env.DB, env);
  let url: string;
  let useNativeOllama = false;
  let isAnthropic = resolved.format === 'anthropic';

  if (resolved.format === 'ollama') {
    url = `${resolved.url}/v1/chat/completions`;
    if (resolved.key) headers['Authorization'] = `Bearer ${resolved.key}`;
  } else if (isAnthropic) {
    url = `${resolved.url}/messages`;
    headers['x-api-key'] = resolved.key || '';
    headers['anthropic-version'] = '2023-06-01';
  } else {
    url = `${resolved.url}/chat/completions`;
    headers['Authorization'] = `Bearer ${resolved.key}`;
    if (provider === 'openrouter') headers['X-Title'] = 'Haven';
  }

  const inferMsgs = [...messages];
  if (thinking && !isAnthropic && inferMsgs.length > 0 && inferMsgs[0].role === 'system') {
    inferMsgs[0] = { ...inferMsgs[0], content: inferMsgs[0].content + '\n\nThink through your reasoning step by step inside <think> tags before giving your response. Example:\n<think>\n[your reasoning here]\n</think>\n[your response here]' };
  }

  const requestMsgs = resolved.format === 'ollama' ? normalizeMessagesForOllama(inferMsgs) : inferMsgs;

  let response: Response;
  if (isAnthropic) {
    const { system, messages: anthropicMsgs } = buildAnthropicMessages(inferMsgs);
    const usesBudgetThinking = thinking && /claude-sonnet-4-5|claude-opus-4-[56]/.test(model);
    const noTemperature = /claude-opus-4-[789]/.test(model);
    const body: any = { model, messages: anthropicMsgs, max_tokens: thinking ? 16000 : 4096, stream: true };
    if (!noTemperature) body.temperature = temperature ?? 0.8;
    if (thinking) {
      if (usesBudgetThinking) body.thinking = { type: 'enabled', budget_tokens: 10000 };
      else body.thinking = { type: 'adaptive' };
    }
    if (system) body.system = cache
      ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral', ...(cacheTtl && { ttl: cacheTtl }) } }]
      : system;
    response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  } else {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: requestMsgs,
        stream: true,
        temperature: temperature ?? 0.8,
        stream_options: { include_usage: true },
      }),
    });
  }

  // Ollama fallback: if OpenAI-compatible endpoint fails, try native /api/chat
  if (!response.ok && provider === 'ollama') {
    const nativeUrl = `${resolved.url}/api/chat`;
    response = await fetch(nativeUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, messages: requestMsgs, stream: true }),
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
          if (parsed.done) {
            if (usageSink && (parsed.prompt_eval_count || parsed.eval_count)) {
              usageSink.input = parsed.prompt_eval_count || 0;
              usageSink.output = parsed.eval_count || 0;
              usageSink.exact = true;
            }
            return;
          }
          const token = parsed.message?.content;
          if (token) yield token;
        } catch {}
      } else if (isAnthropic) {
        if (!trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6).trim();
        try {
          const parsed = JSON.parse(data);
          if (parsed.type === 'message_start' && usageSink && parsed.message?.usage) {
            usageSink.input = parsed.message.usage.input_tokens || 0;
            usageSink.output = parsed.message.usage.output_tokens || 0;
            usageSink.exact = true;
          } else if (parsed.type === 'message_delta' && usageSink && parsed.usage?.output_tokens != null) {
            usageSink.output = parsed.usage.output_tokens;
            usageSink.exact = true;
          }
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
          if (usageSink && parsed.usage) {
            usageSink.input = parsed.usage.prompt_tokens || 0;
            usageSink.output = parsed.usage.completion_tokens || 0;
            usageSink.exact = true;
          }
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
    // Proactive memory: tag auto-saved rows ('extracted'/'consolidated') vs
    // user-entered ('manual') so consolidation never deletes hand-written memories.
    ['memories', "source TEXT DEFAULT 'manual'"],
    ['memories', 'is_correction INTEGER DEFAULT 0'],
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

  // Proactive memory: rolling extraction counter + consolidated long-term blob.
  await db.prepare(`CREATE TABLE IF NOT EXISTS memory_state (
    companion_id INTEGER PRIMARY KEY,
    msgs_since_extract INTEGER DEFAULT 0,
    consolidated_body TEXT,
    last_consolidated_at TEXT
  )`).run();

  // v1.13: per-deployment token usage log. One row per inference call.
  // `source` distinguishes 'chat' from background memory passes ('memory').
  // `exact` is 1 when the provider reported usage, 0 for the tiktoken estimate.
  await db.prepare(`CREATE TABLE IF NOT EXISTS usage_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    companion_id INTEGER NOT NULL DEFAULT 1,
    model TEXT,
    provider TEXT,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    exact INTEGER DEFAULT 0,
    source TEXT DEFAULT 'chat',
    created_at TEXT DEFAULT (datetime('now'))
  )`).run();

  // Indexes on the newly-scoped tables (safe to run repeatedly).
  const indexAdds: string[] = [
    'CREATE INDEX IF NOT EXISTS idx_identity_companion ON identity(companion_id, pinned, priority)',
    'CREATE INDEX IF NOT EXISTS idx_threads_companion ON threads(companion_id, last_message_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_memories_companion ON memories(companion_id, created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_memories_source ON memories(companion_id, source)',
    'CREATE INDEX IF NOT EXISTS idx_people_companion ON people(companion_id)',
    'CREATE INDEX IF NOT EXISTS idx_important_dates_companion ON important_dates(companion_id)',
    'CREATE INDEX IF NOT EXISTS idx_usage_log_companion ON usage_log(companion_id, created_at DESC)',
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
  try { await ensureReactionsColumn(db); } catch {}
  try {
    await db.prepare(`CREATE TABLE IF NOT EXISTS custom_media (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('emoji', 'sticker')),
      r2_key TEXT NOT NULL,
      content_type TEXT,
      added_at TEXT DEFAULT (datetime('now'))
    )`).run();
  } catch {}
  try {
    await db.prepare(`CREATE TABLE IF NOT EXISTS rate_limits (
      ip TEXT NOT NULL, endpoint TEXT NOT NULL, count INTEGER DEFAULT 1,
      window_start TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (ip, endpoint)
    )`).run();
  } catch {}
  try {
    await db.prepare(`CREATE TABLE IF NOT EXISTS user_preferences (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    )`).run();
  } catch {}
  migrationsRan = true;
}

const RATE_LIMITS: Record<string, { max: number; windowSec: number }> = {
  '/api/chat': { max: 30, windowSec: 60 },
  '/api/upload': { max: 10, windowSec: 60 },
  '/api/auth/generate': { max: 5, windowSec: 60 },
};

async function checkRateLimit(db: D1Database, ip: string, endpoint: string): Promise<boolean> {
  const config = RATE_LIMITS[endpoint];
  if (!config) return true;
  const row = await db.prepare(
    'SELECT count, window_start FROM rate_limits WHERE ip = ? AND endpoint = ?'
  ).bind(ip, endpoint).first<{ count: number; window_start: string }>();
  const now = Date.now();
  if (row) {
    const windowAge = now - new Date(row.window_start + 'Z').getTime();
    if (windowAge > config.windowSec * 1000) {
      await db.prepare(
        'UPDATE rate_limits SET count = 1, window_start = datetime(\'now\') WHERE ip = ? AND endpoint = ?'
      ).bind(ip, endpoint).run();
      return true;
    }
    if (row.count >= config.max) return false;
    await db.prepare(
      'UPDATE rate_limits SET count = count + 1 WHERE ip = ? AND endpoint = ?'
    ).bind(ip, endpoint).run();
    return true;
  }
  await db.prepare(
    'INSERT OR REPLACE INTO rate_limits (ip, endpoint, count, window_start) VALUES (?, ?, 1, datetime(\'now\'))'
  ).bind(ip, endpoint).run();
  return true;
}

// ============================================================
// API Routes
// ============================================================

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    _cors = getCorsHeaders(request);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: _cors });
    }

    // Run migrations once per worker instance (idempotent, fast after first
    // successful run since module-level flag guards repeated execution).
    await ensureMigrations(env.DB);

    const url = new URL(request.url);
    const path = url.pathname;

    // ---- Rate limiting ----
    if (RATE_LIMITS[path]) {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const allowed = await checkRateLimit(env.DB, ip, path);
      if (!allowed) {
        return new Response(JSON.stringify({ error: 'Too many requests. Please wait a moment.' }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '60', ..._cors },
        });
      }
    }

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
        return json({ token });
      }

      if (path === '/api/auth/revoke' && request.method === 'POST') {
        const existing = await getAuthToken(env.DB);
        if (existing) {
          const bearer = request.headers.get('Authorization')?.replace('Bearer ', '');
          if (bearer !== existing) return json({ error: 'Unauthorized' }, 401);
        }
        await env.DB.prepare('DELETE FROM settings WHERE key = ?').bind('auth_token').run();
        return json({ success: true });
      }

      // ---- Codex relay sockets + attachments (self-authenticating, feature-flagged) ----
      const codexAttachmentPrefix = '/api/codex/attachment/';
      if (path.startsWith(codexAttachmentPrefix) && request.method === 'GET') {
        if ((await getSettingValue(env.DB, 'codex_channel_enabled')) !== 'true') {
          return new Response('Not found', { status: 404 });
        }

        const storedToken = await getSettingValue(env.DB, 'codex_connector_token');
        const suppliedToken = request.headers.get('X-Codex-Connector-Token')?.trim()
          || url.searchParams.get('token');
        if (!storedToken || suppliedToken !== storedToken) {
          return json({ error: 'Unauthorized' }, 401);
        }

        const key = path.slice(codexAttachmentPrefix.length);
        const object = await env.FILES.get(key);
        if (!object) return new Response('Not found', { status: 404 });

        return new Response(object.body, {
          headers: {
            'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream',
          },
        });
      }

      // Status door for the Codex lane: the engine's MCP interface is broken
      // upstream (auto-cancelled approvals), so companions on that lane update
      // the header chip via this connector-authed endpoint from the shell.
      if (path === '/api/codex/status' && request.method === 'POST') {
        if ((await getSettingValue(env.DB, 'codex_channel_enabled')) !== 'true') {
          return new Response('Not found', { status: 404 });
        }
        const storedToken = await getSettingValue(env.DB, 'codex_connector_token');
        const suppliedToken = request.headers.get('X-Codex-Connector-Token')?.trim()
          || url.searchParams.get('token');
        if (!storedToken || suppliedToken !== storedToken) {
          return json({ error: 'Unauthorized' }, 401);
        }
        const body = await request.json().catch(() => ({})) as { companionId?: number; custom_status?: string; presence?: string };
        const cid = Number(body.companionId);
        if (!Number.isInteger(cid) || cid <= 0) return json({ error: 'companionId required' }, 400);
        const status = typeof body.custom_status === 'string' ? body.custom_status.slice(0, 200) : null;
        const rawPresence = typeof body.presence === 'string' ? body.presence.trim().toLowerCase() : null;
        const VALID_PRESENCE = ['online', 'away', 'busy', 'offline'];
        const presence = rawPresence && VALID_PRESENCE.includes(rawPresence) ? rawPresence : null;
        if (status !== null) {
          await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind(`companion_status:${cid}`, status).run();
        }
        if (presence) {
          await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind(`companion_presence:${cid}`, presence).run();
        }
        return json({ success: true, custom_status: status ?? '(unchanged)', presence: presence ?? '(unchanged)' });
      }

      if (path === '/api/codex/ws' || path === '/api/codex/bridge') {
        if ((await getSettingValue(env.DB, 'codex_channel_enabled')) !== 'true') {
          return new Response('Not found', { status: 404 });
        }

        const role = path === '/api/codex/ws' ? 'client' : 'bridge';
        if (role === 'client') {
          const storedToken = await getAuthToken(env.DB);
          const suppliedToken = url.searchParams.get('token');
          if (storedToken && suppliedToken !== storedToken) {
            return json({ error: 'Unauthorized' }, 401);
          }
        } else {
          const storedToken = await getSettingValue(env.DB, 'codex_connector_token');
          const suppliedToken = request.headers.get('X-Codex-Connector-Token')?.trim()
            || url.searchParams.get('token');
          if (!storedToken || suppliedToken !== storedToken) {
            return json({ error: 'Unauthorized' }, 401);
          }
        }

        if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
          return new Response('Expected a WebSocket upgrade', {
            status: 426,
            headers: { Upgrade: 'websocket' },
          });
        }

        const id = env.CODEX_RELAY.idFromName('relay');
        const stub = env.CODEX_RELAY.get(id);
        const headers = new Headers(request.headers);
        headers.set('X-Codex-Relay-Role', role);

        return stub.fetch(new Request('https://codex-relay.internal/socket', {
          method: 'GET',
          headers,
        }));
      }

      // ---- Auth middleware ----
      const storedToken = await getAuthToken(env.DB);
      if (storedToken) {
        // Exempt only the bootstrap READS (the app loads the companion grid and
        // detects setup state before a token is entered). Writes to these paths
        // (PUT /api/companion, POST /api/companions) must still require the token —
        // matching on path alone let them bypass auth (audit 2026-07-04).
        const isExempt =
          path === '/' ||
          path === '/health' ||
          ((path === '/api/companion' || path === '/api/companions') && request.method === 'GET');
        if (!isExempt) {
          const bearer = request.headers.get('Authorization')?.replace('Bearer ', '') || null;
          const qToken = url.searchParams.get('token');
          if ((bearer || qToken) !== storedToken) {
            return json({ error: 'Unauthorized' }, 401);
          }
        }
      }

      // ---- Codex bridge pairing (authenticated by normal Haven middleware) ----
      if (path === '/api/codex/pair/generate' && request.method === 'POST') {
        const bytes = new Uint8Array(32);
        crypto.getRandomValues(bytes);
        const token = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

        await env.DB.batch([
          env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
            .bind('codex_connector_token', token),
          env.DB.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
            .bind('codex_channel_enabled', 'true'),
          env.DB.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
            .bind('codex_enabled', 'true'),
        ]);
        return json({ token });
      }

      if (path === '/api/codex/pair/status' && request.method === 'GET') {
        const [connectorToken, channelEnabled, providerEnabled] = await Promise.all([
          getSettingValue(env.DB, 'codex_connector_token'),
          getSettingValue(env.DB, 'codex_channel_enabled'),
          getSettingValue(env.DB, 'codex_enabled'),
        ]);
        return json({
          configured: !!connectorToken,
          channelEnabled: channelEnabled === 'true',
          providerEnabled: providerEnabled === 'true',
        });
      }

      if (path === '/api/codex/pair/revoke' && request.method === 'POST') {
        await env.DB.prepare('DELETE FROM settings WHERE key = ?').bind('codex_connector_token').run();
        return json({ success: true });
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

      // ---- Codex run context + chat persistence (authenticated/scoped) ----
      if (path === '/api/codex/run-context' && request.method === 'GET') {
        const [codexEnabled, channelEnabled] = await Promise.all([
          isProviderEnabled(env.DB, 'codex'),
          getSettingValue(env.DB, 'codex_channel_enabled'),
        ]);
        if (!codexEnabled || channelEnabled !== 'true') return new Response('Not found', { status: 404 });

        const companionId = getCompanionId(request);
        const threadId = url.searchParams.get('threadId');
        if (threadId) {
          const thread = await env.DB.prepare(
            'SELECT companion_id FROM threads WHERE id = ?'
          ).bind(threadId).first<{ companion_id: number }>();
          if (!thread) return json({ error: 'Thread not found' }, 404);
          if (thread.companion_id !== companionId) return json({ error: 'thread belongs to a different companion' }, 403);
        }
        const temporalContext = await buildTemporalContext(env.DB, companionId, threadId);
        const systemPrompt = await buildSystemPrompt(env.DB, companionId) + temporalContext;
        // Haven's enabled MCP servers ride along so the PC bridge can hand
        // Codex the SAME toolbelt the normal chat lane uses (replacing the
        // machine's own MCP config for the run). api_key goes to the user's
        // own authenticated daemon only — same trust boundary as the chat
        // lane, which sends it to those servers as a bearer anyway.
        const mcpRows = await env.DB.prepare(
          'SELECT name, url, api_key FROM mcp_servers WHERE enabled = 1 ORDER BY created_at ASC'
        ).all<{ name: string; url: string; api_key: string | null }>()
          .then((r) => r.results || [])
          .catch(() => []); // table may not exist on fresh instances
        const companionRow = await env.DB.prepare('SELECT name FROM companion WHERE id = ?')
          .bind(companionId).first<{ name: string }>();
        return json({ systemPrompt, companionId, companionName: companionRow?.name ?? null, mcpServers: mcpRows });
      }

      if (path === '/api/codex/messages' && request.method === 'POST') {
        const [codexEnabled, channelEnabled] = await Promise.all([
          isProviderEnabled(env.DB, 'codex'),
          getSettingValue(env.DB, 'codex_channel_enabled'),
        ]);
        if (!codexEnabled || channelEnabled !== 'true') return new Response('Not found', { status: 404 });

        const companionId = getCompanionId(request);
        const body = await request.json() as {
          threadId?: string | null;
          role?: string;
          content?: string;
          model?: string;
        };
        if (body.role !== 'user' && body.role !== 'companion') return json({ error: 'role must be user or companion' }, 400);
        if (typeof body.content !== 'string' || !body.content.trim()) return json({ error: 'content required' }, 400);

        let activeThreadId = body.threadId || null;
        if (!activeThreadId) {
          if (body.role !== 'user') return json({ error: 'threadId required for companion messages' }, 400);
          activeThreadId = crypto.randomUUID();
          await env.DB.prepare(
            'INSERT INTO threads (id, companion_id, title, last_message_at) VALUES (?, ?, ?, datetime("now"))'
          ).bind(activeThreadId, companionId, body.content.substring(0, 50)).run();
        } else {
          const thread = await env.DB.prepare(
            'SELECT companion_id FROM threads WHERE id = ?'
          ).bind(activeThreadId).first<{ companion_id: number }>();
          if (!thread) return json({ error: 'Thread not found' }, 404);
          if (thread.companion_id !== companionId) return json({ error: 'thread belongs to a different companion' }, 403);
        }

        const id = crypto.randomUUID();
        await env.DB.prepare(
          'INSERT INTO messages (id, thread_id, role, content, model) VALUES (?, ?, ?, ?, ?)'
        ).bind(id, activeThreadId, body.role, body.content, body.model || null).run();
        await env.DB.prepare(
          'UPDATE threads SET last_message_at = datetime("now") WHERE id = ?'
        ).bind(activeThreadId).run();
        return json({ id, threadId: activeThreadId });
      }

      // ---- Chat (SSE streaming) ----
      if (path === '/api/chat' && request.method === 'POST') {
        const body = await request.json() as any;
        let { message, threadId, model = 'google/gemma-4-31b-it:free', provider = 'openrouter', image, thinking = false } = body;
        const webSearch = body.web_search === true;

        if (!message) return json({ error: 'message required' }, 400);

        // Whitelist provider to prevent garbage input falling through to untested paths.
        const ALLOWED_PROVIDERS = ['openrouter', 'ollama', 'openai', 'anthropic', 'groq', 'xai', 'huggingface', 'moonshot'];
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

        // Load conversation history (latest 50, reversed back to chronological order)
        const history = await env.DB.prepare(
          'SELECT role, content FROM messages WHERE thread_id = ? ORDER BY created_at DESC LIMIT 50'
        ).bind(activeThreadId).all<{ role: string; content: string }>();

        // Temporal awareness: compute gap since user's previous message
        const temporalContext = await buildTemporalContext(env.DB, chatCompanionId, activeThreadId, userMsgId);

        // Build system prompt (scoped to active companion)
        let systemPrompt = await buildSystemPrompt(env.DB, chatCompanionId) + temporalContext;

        // Per-model settings (temperature, system prompt addition)
        let cfgTemperature: number | undefined;
        const cacheVal = provider === 'anthropic' ? (await getSettingValue(env.DB, 'anthropic_cache')) : null;
        const cfgCache = cacheVal === 'true' || cacheVal === '5min' || cacheVal === '1h';
        const cfgCacheTtl = cacheVal === '1h' ? '1h' : undefined;
        const cfgRaw = await getSettingValue(env.DB, `model_cfg:${provider}:${model}`);
        if (cfgRaw) {
          try {
            const cfg = JSON.parse(cfgRaw);
            if (typeof cfg.temperature === 'number') cfgTemperature = cfg.temperature;
            if (cfg.systemPromptAddition) systemPrompt += `\n\n## Additional Instructions\n${cfg.systemPromptAddition}`;
          } catch {}
        }

        // Assemble messages
        const historyMessages = (history.results || []).reverse().map(m => ({
          role: m.role === 'companion' ? 'assistant' : m.role,
          content: m.content,
        }));

        // If the latest message has an image, make it multimodal (vision).
        // Two provider-specific shapes: Ollama's native /api/chat rejects
        // OpenAI-style content arrays ("cannot unmarshal array into ...
        // string") — it wants content as a string with images in a sibling
        // `images` field. OpenAI/Anthropic use the array form. When the
        // selected Ollama model is text-only, also swap to a vision-capable
        // fallback (setting `ollama_vision_fallback`) so the image actually
        // gets seen instead of 400ing.
        if (image && historyMessages.length > 0) {
          const last = historyMessages[historyMessages.length - 1];
          if (last.role === 'user') {
            if (provider === 'ollama') {
              const VISION_RE = /vision|vl|-v\b|4o|gemini|claude-3|claude-opus|claude-sonnet-4|claude-haiku|llava|pixtral|gpt-4-turbo|gpt-4\.1|kimi/i;
              if (!VISION_RE.test(model)) {
                const fallback = await getSettingValue(env.DB, 'ollama_vision_fallback');
                if (fallback) {
                  console.log(`[CHAT] vision fallback: ${model} -> ${fallback}`);
                  model = fallback;
                } else {
                  console.log(`[CHAT] warning: image attached to text-only model ${model} and no ollama_vision_fallback set`);
                }
              }
              // Strip data URL prefix — Ollama wants raw base64 in `images`.
              const base64 = image.startsWith('data:') ? image.split(',', 2)[1] : image;
              (last as any).images = [base64];
              // content stays as the original string; no array wrapping.
            } else {
              (last as any).content = [
                { type: 'text', text: last.content },
                { type: 'image_url', image_url: { url: image } },
              ];
            }
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
              const chatUsage: UsageSink = {};

              // Send thread ID
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'thread', threadId: activeThreadId })}\n\n`));

              // Check for MCP tools
              const mcpTools = await loadMcpTools(env.DB);

              // Native tools (update_my_status, etc.) are always available, so
              // take the tool-calling path whenever we have ANY tool — MCP or
              // native. Only fall through to plain streaming when truly none
              // exist (e.g., someone ripped NATIVE_TOOLS out).
              if (mcpTools.length > 0 || NATIVE_TOOLS.length > 0 || webSearch) {
                // Non-streaming path with function calling
                try {
                  const toolResult = await inferenceWithTools(chatMessages, model, provider, env, mcpTools, chatCompanionId, thinking, cfgTemperature, cfgCache, cfgCacheTtl, webSearch);
                  fullResponse = toolResult.content;
                  Object.assign(chatUsage, toolResult.usage);
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
                  for await (const token of streamInference(chatMessages, model, provider, env, thinking, cfgTemperature, cfgCache, cfgCacheTtl, chatUsage)) {
                    fullResponse += token;
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'chunk', content: token })}\n\n`));
                  }
                }
              } else {
                // Stream tokens (no tools)
                for await (const token of streamInference(chatMessages, model, provider, env, thinking, cfgTemperature, cfgCache, cfgCacheTtl, chatUsage)) {
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

              // Token usage log (always on, best-effort, off the reply path).
              // exact when the provider reported usage; otherwise a labeled
              // char-based estimate from the prompt + reply text.
              ctx.waitUntil((async () => {
                try {
                  const estIn = chatUsage.exact
                    ? ''
                    : chatMessages.map((m: any) => typeof m.content === 'string' ? m.content : '').join('\n');
                  await logUsage(env.DB, chatCompanionId, model, provider, chatUsage, 'chat', estIn, fullResponse);
                } catch (e) {
                  console.log(`[USAGE] chat log failed: ${e}`);
                }
              })());

              // Proactive memory (opt-in): bump the per-companion turn counter and,
              // every N turns, extract durable facts + maybe consolidate. Runs via
              // ctx.waitUntil so it survives after the stream closes without adding
              // any latency to this reply. Entirely best-effort.
              ctx.waitUntil((async () => {
                try {
                  if ((await getSettingValue(env.DB, 'proactive_memory_enabled')) !== 'true') return;
                  await env.DB.prepare(
                    `INSERT INTO memory_state (companion_id, msgs_since_extract) VALUES (?, 1)
                     ON CONFLICT(companion_id) DO UPDATE SET msgs_since_extract = msgs_since_extract + 1`
                  ).bind(chatCompanionId).run();
                  const st = await env.DB.prepare(
                    'SELECT msgs_since_extract FROM memory_state WHERE companion_id = ?'
                  ).bind(chatCompanionId).first<{ msgs_since_extract: number }>();
                  const threshold = await getNumberSetting(env.DB, 'memory_extract_every', 10);
                  if ((st?.msgs_since_extract ?? 0) < threshold) return;
                  // Cheap dedicated memory model, falling back to the chat model.
                  const memModel = (await getSettingValue(env.DB, 'memory_model')) || model;
                  const memProvider = (await getSettingValue(env.DB, 'memory_provider')) || provider;
                  // Reset the counter ONLY after extraction succeeds. Resetting
                  // first meant a transient LLM/JSON failure permanently skipped
                  // that batch (the "last 12 messages" window moved on before the
                  // next attempt). Now a failure leaves the counter over threshold
                  // so it retries on the very next turn. (audit 2026-07-12 #2)
                  await runExtraction(env, env.DB, chatCompanionId, activeThreadId, memModel, memProvider);
                  await env.DB.prepare(
                    'UPDATE memory_state SET msgs_since_extract = 0 WHERE companion_id = ?'
                  ).bind(chatCompanionId).run();
                  await maybeConsolidate(env, env.DB, chatCompanionId, memModel, memProvider);
                } catch (e) {
                  console.log(`[MEMORY] background pass failed: ${e}`);
                }
              })());

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
          'SELECT * FROM threads WHERE companion_id = ? ORDER BY last_message_at DESC LIMIT 200'
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
        const [companion, identityCount, threadCount] = await Promise.all([
          env.DB.prepare('SELECT * FROM companion WHERE id = ?').bind(cid).first(),
          env.DB.prepare('SELECT COUNT(*) as cnt FROM identity WHERE companion_id = ?').bind(cid).first<{ cnt: number }>(),
          env.DB.prepare('SELECT COUNT(*) as cnt FROM threads WHERE companion_id = ?').bind(cid).first<{ cnt: number }>(),
        ]);
        const base = companion || { id: cid, name: 'Companion' };
        return json({ ...base, has_identity: (identityCount?.cnt ?? 0) > 0, has_threads: (threadCount?.cnt ?? 0) > 0 });
      }

      if (path === '/api/companion' && request.method === 'PUT') {
        const cid = getCompanionId(request);
        const { name, avatar_url } = await request.json() as any;
        const existing = await env.DB.prepare('SELECT id FROM companion WHERE id = ?').bind(cid).first();
        if (existing) {
          await env.DB.prepare(
            'UPDATE companion SET name = ?, avatar_url = ? WHERE id = ?'
          ).bind(name, avatar_url || null, cid).run();
        } else {
          await env.DB.prepare(
            'INSERT INTO companion (id, name, avatar_url) VALUES (?, ?, ?)'
          ).bind(cid, name, avatar_url || null).run();
        }
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

      // Edit a memory (partial — only the fields provided are changed). Scoped to
      // the companion so you can only edit that companion's own memories.
      if (path === '/api/memories' && request.method === 'PUT') {
        const cid = getCompanionId(request);
        const { id, content, memory_type, emotional_weight } = await request.json() as any;
        if (!id) return json({ error: 'id required' }, 400);
        const upd = await env.DB.prepare(
          `UPDATE memories SET content = COALESCE(?, content),
             memory_type = COALESCE(?, memory_type),
             emotional_weight = COALESCE(?, emotional_weight)
           WHERE id = ? AND companion_id = ?`
        ).bind(content ?? null, memory_type ?? null, emotional_weight ?? null, id, cid).run();
        // Don't report success on a no-op: a wrong/stale id or another
        // companion's row matches nothing but looked identical to a real edit.
        if (upd.meta.changes === 0) return json({ error: 'Memory not found' }, 404);
        return json({ success: true });
      }

      // Delete a memory (id via ?id= query param). Scoped to the companion.
      if (path === '/api/memories' && request.method === 'DELETE') {
        const cid = getCompanionId(request);
        const id = new URL(request.url).searchParams.get('id');
        if (!id) return json({ error: 'id required' }, 400);
        const del = await env.DB.prepare(
          'DELETE FROM memories WHERE id = ? AND companion_id = ?'
        ).bind(id, cid).run();
        if (del.meta.changes === 0) return json({ error: 'Memory not found' }, 404);
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
        'openrouter_key', 'ollama_url', 'ollama_key', 'ollama_vision_fallback',
        'anthropic_key', 'openai_key', 'groq_key', 'xai_key', 'huggingface_key', 'moonshot_key',
        'anthropic_cache',
        'custom_key', 'custom_base_url',
        'companion_status', 'companion_presence',
        'user_status', 'user_presence',
        'mcp_tool_limit',
        'giphy_key',
        'openrouter_enabled', 'ollama_enabled', 'custom_enabled',
        'timezone',
        'usage_prices',
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

      // ---- Token usage / cost ----
      // Per-companion token totals over rolling windows + estimated USD cost
      // using the merged price table (built-in defaults + user overrides).
      if (path === '/api/usage' && request.method === 'GET') {
        const cid = getCompanionId(request);
        let userPrices: Record<string, Price> = {};
        try {
          const raw = await getSettingValue(env.DB, 'usage_prices');
          if (raw) userPrices = JSON.parse(raw);
        } catch { /* malformed — ignore, use defaults */ }
        const merged = { ...DEFAULT_PRICES, ...userPrices };

        const rows = await env.DB.prepare(
          `SELECT model, provider,
             SUM(input_tokens) AS in_all, SUM(output_tokens) AS out_all, MIN(exact) AS min_exact,
             SUM(CASE WHEN created_at >= datetime('now','-1 day')  THEN input_tokens  ELSE 0 END) AS in_day,
             SUM(CASE WHEN created_at >= datetime('now','-1 day')  THEN output_tokens ELSE 0 END) AS out_day,
             SUM(CASE WHEN created_at >= datetime('now','-7 days')  THEN input_tokens  ELSE 0 END) AS in_week,
             SUM(CASE WHEN created_at >= datetime('now','-7 days')  THEN output_tokens ELSE 0 END) AS out_week,
             SUM(CASE WHEN created_at >= datetime('now','-30 days') THEN input_tokens  ELSE 0 END) AS in_month,
             SUM(CASE WHEN created_at >= datetime('now','-30 days') THEN output_tokens ELSE 0 END) AS out_month
           FROM usage_log WHERE companion_id = ? GROUP BY model, provider`
        ).bind(cid).all<any>();

        const blank = () => ({ input: 0, output: 0, cost: 0 });
        const totals: Record<string, { input: number; output: number; cost: number }> = {
          day: blank(), week: blank(), month: blank(), all: blank(),
        };
        const byModel: Array<{ model: string; provider: string; input: number; output: number; cost: number; estimated: boolean }> = [];
        for (const r of (rows.results || [])) {
          const p = priceFor(r.model || '', merged);
          const costOf = (inp: number, out: number) => (inp / 1e6) * p.in + (out / 1e6) * p.out;
          const add = (bucket: { input: number; output: number; cost: number }, inp: number, out: number) => {
            bucket.input += inp; bucket.output += out; bucket.cost += costOf(inp, out);
          };
          add(totals.day, r.in_day || 0, r.out_day || 0);
          add(totals.week, r.in_week || 0, r.out_week || 0);
          add(totals.month, r.in_month || 0, r.out_month || 0);
          add(totals.all, r.in_all || 0, r.out_all || 0);
          byModel.push({
            model: r.model || '(unknown)', provider: r.provider || '',
            input: r.in_all || 0, output: r.out_all || 0, cost: costOf(r.in_all || 0, r.out_all || 0),
            estimated: r.min_exact === 0,
          });
        }
        byModel.sort((a, b) => b.cost - a.cost);
        return json({ totals, byModel, prices: merged });
      }

      // ---- User Preferences (synced across devices) ----
      if (path === '/api/preferences' && request.method === 'GET') {
        const rows = await env.DB.prepare('SELECT key, value FROM user_preferences').all<{ key: string; value: string }>();
        const obj: Record<string, string> = {};
        for (const row of (rows.results || [])) obj[row.key] = row.value;
        return json(obj);
      }

      if (path === '/api/preferences' && request.method === 'PUT') {
        const body = await request.json() as Record<string, string>;
        const ALLOWED_PREF_KEYS = new Set([
          'user-name', 'user-avatar', 'user-status',
          'font-size', 'font-family', 'text-color', 'wallpaper',
          'tts-mode', 'thinking', 'fav-models', 'setup-done',
        ]);
        const stmts: D1PreparedStatement[] = [];
        for (const [key, value] of Object.entries(body)) {
          if (!ALLOWED_PREF_KEYS.has(key)) continue;
          if (value === '' || value === null || value === undefined) {
            stmts.push(env.DB.prepare('DELETE FROM user_preferences WHERE key = ?').bind(key));
          } else {
            stmts.push(env.DB.prepare(
              'INSERT INTO user_preferences (key, value, updated_at) VALUES (?, ?, datetime(\'now\')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime(\'now\')'
            ).bind(key, value));
          }
        }
        if (stmts.length > 0) await env.DB.batch(stmts);
        return json({ success: true });
      }

      // ---- Model Settings (per-model temperature, notes, system prompt addition) ----
      if (path === '/api/model-settings' && request.method === 'GET') {
        const p = url.searchParams.get('provider') || '';
        const m = url.searchParams.get('model') || '';
        if (!p || !m) return json({});
        const val = await getSettingValue(env.DB, `model_cfg:${p}:${m}`);
        try { return json(val ? JSON.parse(val) : {}); } catch { return json({}); }
      }

      if (path === '/api/model-settings' && request.method === 'PUT') {
        const body = await request.json() as any;
        const { provider: p, model: m, settings } = body;
        if (!p || !m || !settings) return json({ error: 'provider, model, settings required' }, 400);
        const key = `model_cfg:${p}:${m}`;
        await env.DB.prepare(
          'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
        ).bind(key, JSON.stringify(settings)).run();
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
        const models: Array<{ id: string; name: string; provider: string; tier: string; description?: string; context_length?: number; supports_tools?: boolean; supports_vision?: boolean; supports_thinking?: boolean }> = [];
        // Per-provider toggles suppress that provider's models from the
        // picker entirely when disabled.
        const [orEnabled, ollamaEnabled, customEnabled, codexEnabled, codexChannelEnabled, codexModels] = await Promise.all([
          isProviderEnabled(env.DB, 'openrouter'),
          isProviderEnabled(env.DB, 'ollama'),
          isProviderEnabled(env.DB, 'custom'),
          isProviderEnabled(env.DB, 'codex'),
          getSettingValue(env.DB, 'codex_channel_enabled'),
          getSettingValue(env.DB, 'codex_models'),
        ]);
        if (codexEnabled && codexChannelEnabled === 'true') {
          models.push({ id: 'codex', name: 'Codex (your PC)', provider: 'codex', tier: 'local' });
          for (const model of (codexModels || '').split(',').map((name) => name.trim()).filter(Boolean)) {
            models.push({ id: `codex:${model}`, name: `Codex — ${model}`, provider: 'codex', tier: 'local' });
          }
        }
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
              const sp = Array.isArray(m.supported_parameters) ? m.supported_parameters : [];
              const supportsTools = sp.length > 0 ? sp.includes('tools') : undefined;
              const supportsThinking = sp.length > 0 ? sp.includes('reasoning') : undefined;
              const modality = m.architecture?.modality || '';
              const supportsVision = modality.includes('image') || modality.includes('multimodal') || undefined;
              models.push({
                id: m.id,
                name: m.name || m.id,
                provider: 'openrouter',
                tier: isFree ? 'free' : 'paid',
                description: m.description || undefined,
                context_length: m.context_length || undefined,
                supports_tools: supportsTools,
                supports_vision: supportsVision === true ? true : undefined,
                supports_thinking: supportsThinking === true ? true : undefined,
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
                { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', provider: 'anthropic', tier: 'included', context_length: 1000000 },
                { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', provider: 'anthropic', tier: 'included', context_length: 1000000 },
                { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', provider: 'anthropic', tier: 'included', context_length: 1000000 },
                { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', provider: 'anthropic', tier: 'included', context_length: 1000000 },
                { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', provider: 'anthropic', tier: 'included', context_length: 200000 },
                { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', provider: 'anthropic', tier: 'included', context_length: 200000 },
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

        // Add Moonshot models if key is configured
        const moonshotKey = await getSettingValue(env.DB, 'moonshot_key');
        if (moonshotKey) {
          try {
            const res = await fetch('https://api.moonshot.cn/v1/models', {
              headers: { 'Authorization': `Bearer ${moonshotKey}` },
            });
            const data = await res.json() as any;
            for (const m of (data.data || [])) {
              models.push({ id: m.id, name: m.id, provider: 'moonshot', tier: 'included', context_length: m.context_length || undefined });
            }
          } catch {
            models.push(
              { id: 'moonshot-v1-8k', name: 'Moonshot v1 8K', provider: 'moonshot', tier: 'included', context_length: 8000 },
              { id: 'moonshot-v1-32k', name: 'Moonshot v1 32K', provider: 'moonshot', tier: 'included', context_length: 32000 },
              { id: 'moonshot-v1-128k', name: 'Moonshot v1 128K', provider: 'moonshot', tier: 'included', context_length: 128000 },
            );
          }
        }

        const VISION_PATTERNS = /vision|vl|-v\b|4o|gemini|claude-3|claude-opus|claude-sonnet-4|claude-haiku|llava|pixtral|gpt-4-turbo|gpt-4\.1|kimi/i;
        const THINKING_PATTERNS = /thinking|reasoner|deepseek-r1|qwq|o1-|o3-|o4-|kimi.*thinking|claude-opus/i;
        const TOOLS_PATTERNS = /gpt-4|gpt-3\.5|claude|gemini|command-r|mistral-large|mistral-medium|llama-3|qwen|deepseek-v|glm/i;
        for (const m of models) {
          if (m.supports_vision === undefined) m.supports_vision = VISION_PATTERNS.test(m.id) || undefined;
          if (m.supports_thinking === undefined) m.supports_thinking = THINKING_PATTERNS.test(m.id) || undefined;
          if (m.supports_tools === undefined) m.supports_tools = TOOLS_PATTERNS.test(m.id) || undefined;
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
        const fileEntry = formData.get('file');
        // Runtime type-guard, not a bare cast: a text field named "file" is a
        // string, not a File — `.size`/`.name`/`.stream()` would then throw a
        // raw 500 instead of a clean 400.
        if (!fileEntry || typeof fileEntry === 'string') return json({ error: 'No file provided' }, 400);
        const file = fileEntry as File;
        if (file.size > 20 * 1024 * 1024) return json({ error: 'File too large (max 20MB)' }, 413);

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

      // ---- Custom Emoji & Stickers ----
      if (path === '/api/custom-media' && request.method === 'POST') {
        const formData = await request.formData();
        const file = formData.get('file') as unknown as File;
        const name = (formData.get('name') as string || '').trim();
        const mediaType = (formData.get('type') as string || '').trim();
        if (!file || !name || !mediaType) return json({ error: 'file, name, type required' }, 400);
        if (mediaType !== 'emoji' && mediaType !== 'sticker') return json({ error: 'type must be emoji or sticker' }, 400);
        const maxSize = mediaType === 'emoji' ? 256 * 1024 : 512 * 1024;
        if (file.size > maxSize) return json({ error: `File too large (max ${maxSize / 1024}KB)` }, 413);
        const ext = file.name.split('.').pop() || 'bin';
        const r2Key = `${mediaType}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
        await env.FILES.put(r2Key, file.stream(), { httpMetadata: { contentType: file.type } });
        const result = await env.DB.prepare(
          'INSERT INTO custom_media (name, type, r2_key, content_type) VALUES (?, ?, ?, ?)'
        ).bind(name, mediaType, r2Key, file.type || null).run();
        return json({ id: result.meta.last_row_id, name, type: mediaType, url: `/api/files/${r2Key}` });
      }

      if (path === '/api/custom-media' && request.method === 'GET') {
        const mediaType = url.searchParams.get('type') || '';
        const query = mediaType
          ? env.DB.prepare('SELECT id, name, type, r2_key FROM custom_media WHERE type = ? ORDER BY added_at DESC').bind(mediaType)
          : env.DB.prepare('SELECT id, name, type, r2_key FROM custom_media ORDER BY added_at DESC');
        const rows = await query.all<{ id: number; name: string; type: string; r2_key: string }>();
        const items = (rows.results || []).map(r => ({ id: r.id, name: r.name, type: r.type, url: `/api/files/${r.r2_key}` }));
        return json(items);
      }

      if (path.startsWith('/api/custom-media/') && request.method === 'DELETE') {
        const id = parseInt(path.split('/').pop() || '');
        if (isNaN(id)) return json({ error: 'invalid id' }, 400);
        const row = await env.DB.prepare('SELECT r2_key FROM custom_media WHERE id = ?').bind(id).first<{ r2_key: string }>();
        if (row) {
          await env.FILES.delete(row.r2_key);
          await env.DB.prepare('DELETE FROM custom_media WHERE id = ?').bind(id).run();
        }
        return json({ success: true });
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
        const memoryState = await env.DB.prepare('SELECT * FROM memory_state ORDER BY companion_id').all();
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

        const settings = await env.DB.prepare('SELECT key, value FROM settings WHERE key != ?').bind('auth_token').all();
        const mcpServers = await env.DB.prepare('SELECT name, url, api_key, enabled FROM mcp_servers ORDER BY created_at ASC').all();

        const exported = {
          haven_version: '1.8.4',
          exported_at: new Date().toISOString(),
          companions: companions.results || [],
          identity: identity.results || [],
          threads: threadData,
          memories: memories.results || [],
          memory_state: memoryState.results || [],
          people: people.results || [],
          important_dates: dates.results || [],
          companion_files: files.results || [],
          settings: settings.results || [],
          mcp_servers: mcpServers.results || [],
        };

        return new Response(JSON.stringify(exported, null, 2), {
          headers: {
            'Content-Type': 'application/json',
            'Content-Disposition': `attachment; filename="haven-export-${new Date().toISOString().split('T')[0]}.json"`,
            ..._cors,
          },
        });
      }

      // ---- Full Import (restore from backup) ----
      if (path === '/api/import/full' && request.method === 'POST') {
        const bundle = await request.json() as any;
        if (!bundle?.companions) return json({ error: 'Invalid backup — missing companions' }, 400);
        const errors: string[] = [];
        let imported = 0;

        for (const c of (bundle.companions || [])) {
          try {
            await env.DB.prepare('INSERT OR REPLACE INTO companion (id, name, avatar_url, created_at) VALUES (?, ?, ?, ?)').bind(c.id, c.name, c.avatar_url || null, c.created_at || new Date().toISOString()).run();
            imported++;
          } catch (e: any) { errors.push(`companion ${c.name}: ${e.message}`); }
        }
        for (const row of (bundle.identity || [])) {
          try {
            await env.DB.prepare('INSERT OR REPLACE INTO identity (id, companion_id, content, identity_type, priority, pinned, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(row.id, row.companion_id || 1, row.content, row.identity_type, row.priority || 5, row.pinned || 0, row.created_at || new Date().toISOString()).run();
          } catch (e: any) { errors.push(`identity: ${e.message}`); }
        }
        for (const t of (bundle.threads || [])) {
          try {
            await env.DB.prepare('INSERT OR REPLACE INTO threads (id, companion_id, title, last_message_at, created_at) VALUES (?, ?, ?, ?, ?)').bind(t.id, t.companion_id || 1, t.title, t.last_message_at, t.created_at || new Date().toISOString()).run();
            for (const m of (t.messages || [])) {
              const mid = crypto.randomUUID();
              await env.DB.prepare('INSERT OR IGNORE INTO messages (id, thread_id, role, content, model, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(mid, t.id, m.role, m.content, m.model || null, m.created_at || new Date().toISOString()).run();
            }
          } catch (e: any) { errors.push(`thread: ${e.message}`); }
        }
        for (const row of (bundle.memories || [])) {
          try {
            await env.DB.prepare('INSERT OR REPLACE INTO memories (id, companion_id, content, memory_type, emotional_weight, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(row.id, row.companion_id || 1, row.content, row.memory_type || 'core', row.emotional_weight || 5, row.created_at || new Date().toISOString()).run();
          } catch (e: any) { errors.push(`memory: ${e.message}`); }
        }
        for (const row of (bundle.people || [])) {
          try {
            await env.DB.prepare('INSERT OR REPLACE INTO people (id, companion_id, name, category, content, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(row.id, row.companion_id || 1, row.name, row.category || 'friend', row.content, row.created_at || new Date().toISOString()).run();
          } catch (e: any) { errors.push(`people: ${e.message}`); }
        }
        for (const row of (bundle.important_dates || [])) {
          try {
            await env.DB.prepare('INSERT OR REPLACE INTO important_dates (id, companion_id, date_name, actual_date, date_type, recurring, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(row.id, row.companion_id || 1, row.date_name, row.actual_date, row.date_type || 'event', row.recurring || 0, row.created_at || new Date().toISOString()).run();
          } catch (e: any) { errors.push(`date: ${e.message}`); }
        }
        for (const s of (bundle.settings || [])) {
          try {
            await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind(s.key, s.value).run();
          } catch (e: any) { errors.push(`setting: ${e.message}`); }
        }
        for (const s of (bundle.mcp_servers || [])) {
          try {
            await env.DB.prepare('INSERT INTO mcp_servers (name, url, api_key, enabled) VALUES (?, ?, ?, ?)').bind(s.name, s.url, s.api_key || null, s.enabled ?? 1).run();
          } catch (e: any) { errors.push(`mcp: ${e.message}`); }
        }

        return json({ success: true, companions_imported: imported, errors: errors.length > 0 ? errors : undefined });
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
