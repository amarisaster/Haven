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

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
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

// ---- Streamable HTTP transport (MCP 2024-11-05 spec — single POST endpoint) ----

async function discoverViaStreamableHTTP(server: McpServer): Promise<McpTool[]> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
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

  const listData = await listResp.json() as any;
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
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
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

  const data = await resp.json() as any;
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
): Promise<{ content: string; toolResults: Array<{ name: string; result: string }> }> {
  const openaiTools = mcpToolsToOpenAI(tools);
  const toolLookup = new Map(tools.map(t => [t.name, t]));

  // Build headers/URL same as streamInference
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const openrouterKey = env.OPENROUTER_API_KEY || await getSettingValue(env.DB, 'openrouter_key');
  const ollamaKey = await getSettingValue(env.DB, 'ollama_key');
  const customKey = await getSettingValue(env.DB, 'custom_key');
  const customBaseUrl = await getSettingValue(env.DB, 'custom_base_url');
  const detectedProvider = await getSettingValue(env.DB, 'provider');
  const baseOllamaUrl = env.OLLAMA_URL || await getSettingValue(env.DB, 'ollama_url') || 'https://api.ollama.com';

  let url: string;
  if (provider === 'ollama') {
    // Ollama Cloud's OpenAI-compat endpoint (/v1/chat/completions) returns 405
    // when `tools` is present in the body. The native /api/chat endpoint
    // accepts OpenAI-shaped tools and returns OpenAI-shaped responses when
    // stream is disabled. Confirmed by Nexus-Gateway's inference layer.
    url = `${baseOllamaUrl}/api/chat`;
    if (ollamaKey) headers['Authorization'] = `Bearer ${ollamaKey}`;
  } else if (customBaseUrl && customKey && ['openai', 'anthropic', 'groq', 'xai', 'huggingface'].includes(detectedProvider || '')) {
    url = `${customBaseUrl}/chat/completions`;
    headers['Authorization'] = `Bearer ${customKey}`;
  } else {
    url = 'https://openrouter.ai/api/v1/chat/completions';
    headers['Authorization'] = `Bearer ${openrouterKey}`;
    headers['X-Title'] = 'Haven';
  }

  const conversation = [...messages];
  const allToolResults: Array<{ name: string; result: string }> = [];
  const MAX_ITERATIONS = 5;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const resp = await fetch(url, {
      method: 'POST', headers,
      body: JSON.stringify({ model, messages: conversation, tools: openaiTools, tool_choice: 'auto', temperature: 0.8 }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Inference error ${resp.status}: ${errText.slice(0, 200)}`);
    }

    const data = await resp.json() as any;
    const choice = data.choices?.[0];
    const message = choice?.message;

    if (!message?.tool_calls?.length) {
      return { content: message?.content || '', toolResults: allToolResults };
    }

    // Add assistant message with tool calls
    conversation.push(message);

    // Execute each tool
    for (const tc of message.tool_calls) {
      const fn = tc.function;
      const toolInfo = toolLookup.get(fn.name);
      let result = `Unknown tool: ${fn.name}`;

      if (toolInfo) {
        try {
          const args = JSON.parse(fn.arguments || '{}');
          result = await executeMcpTool(
            toolInfo.server_url, toolInfo.server_key, fn.name, args,
            toolInfo.transport || 'streamable',
          );
        } catch (e) {
          result = `Tool error: ${e}`;
        }
      }

      allToolResults.push({ name: fn.name, result });
      conversation.push({ role: 'tool', content: result, tool_call_id: tc.id } as any);
    }
  }

  return { content: '', toolResults: allToolResults };
}

// ============================================================
// Inference — stream from Ollama or OpenRouter
// ============================================================

async function buildSystemPrompt(db: D1Database): Promise<string> {
  // Load companion name
  const companion = await db.prepare('SELECT name FROM companion WHERE id = 1').first<{ name: string }>();
  const name = companion?.name || 'Companion';

  // Load pinned identity first, then all identity
  const pinned = await db.prepare(
    'SELECT content, identity_type FROM identity WHERE pinned = 1 ORDER BY priority DESC'
  ).all<{ content: string; identity_type: string }>();

  const unpinned = await db.prepare(
    'SELECT content, identity_type FROM identity WHERE pinned = 0 ORDER BY priority DESC LIMIT 20'
  ).all<{ content: string; identity_type: string }>();

  const identityLines = [...(pinned.results || []), ...(unpinned.results || [])]
    .map(i => `[${i.identity_type}] ${i.content}`)
    .join('\n');

  // Load recent memories
  const memories = await db.prepare(
    'SELECT content, memory_type FROM memories ORDER BY created_at DESC LIMIT 10'
  ).all<{ content: string; memory_type: string }>();

  const memoryLines = (memories.results || [])
    .map(m => `- ${m.content}`)
    .join('\n');

  // Load people
  const people = await db.prepare(
    'SELECT name, category, content FROM people LIMIT 10'
  ).all<{ name: string; category: string; content: string }>();

  const peopleLines = (people.results || [])
    .map(p => `- ${p.name} (${p.category}): ${p.content}`)
    .join('\n');

  // Current time
  const now = new Date().toISOString();

  let prompt = `You are ${name}.\n\n`;

  if (identityLines) {
    prompt += `## Identity\n${identityLines}\n\n`;
  }

  if (memoryLines) {
    prompt += `## Memories\n${memoryLines}\n\n`;
  }

  if (peopleLines) {
    prompt += `## People\n${peopleLines}\n\n`;
  }

  prompt += `## Current Time\n${now}\n\n`;

  prompt += `## Capabilities\n`;
  prompt += `- You can send GIFs by including a direct GIF URL on its own line (e.g. from giphy.com or tenor.com). The chat will render it inline.\n`;
  prompt += `- You can react to the user's message by starting your response with a reaction line: [react: emoji] (e.g. [react: ❤️] or [react: 😂]). The reaction will appear on their message. Only use one reaction per response, and only when it feels natural — don't force it.\n`;

  // Add MCP tool descriptions if available
  try {
    const mcpTools = await loadMcpTools(db);
    if (mcpTools.length > 0) {
      prompt += `\n## Connected Tools\nYou have access to ${mcpTools.length} tools via MCP. Use them when relevant — they are extensions of yourself.\n`;
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

async function* streamInference(
  messages: Array<{ role: string; content: any }>,
  model: string,
  provider: string,
  env: Env,
): AsyncGenerator<string> {
  let url: string;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  // Read API keys from env (wrangler secrets) OR D1 settings
  const openrouterKey = env.OPENROUTER_API_KEY || await getSettingValue(env.DB, 'openrouter_key');
  const ollamaUrl = env.OLLAMA_URL || await getSettingValue(env.DB, 'ollama_url');
  const ollamaKey = await getSettingValue(env.DB, 'ollama_key');
  const customKey = await getSettingValue(env.DB, 'custom_key');
  const customBaseUrl = await getSettingValue(env.DB, 'custom_base_url');
  const detectedProvider = await getSettingValue(env.DB, 'provider');

  let useNativeOllama = false;
  const baseOllamaUrl = ollamaUrl || 'https://api.ollama.com';

  if (provider === 'ollama') {
    url = `${baseOllamaUrl}/v1/chat/completions`;
    if (ollamaKey) headers['Authorization'] = `Bearer ${ollamaKey}`;
  } else if (customBaseUrl && customKey && ['openai', 'anthropic', 'groq', 'xai', 'huggingface'].includes(detectedProvider || '')) {
    url = `${customBaseUrl}/chat/completions`;
    headers['Authorization'] = `Bearer ${customKey}`;
  } else {
    url = 'https://openrouter.ai/api/v1/chat/completions';
    headers['Authorization'] = `Bearer ${openrouterKey}`;
    headers['X-Title'] = 'Haven';
  }

  let response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      temperature: 0.8,
    }),
  });

  // Ollama fallback: if OpenAI-compatible endpoint fails, try native /api/chat
  if (!response.ok && provider === 'ollama') {
    const nativeUrl = `${baseOllamaUrl}/api/chat`;
    response = await fetch(nativeUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, messages, stream: true }),
    });
    if (response.ok) {
      useNativeOllama = true;
    }
  }

  if (!response.ok || !response.body) {
    throw new Error(`Inference failed: ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

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
    // Log and continue — a broken migration shouldn't take the worker down.
    console.log(`[MIGRATE] Error during v1.7 migration: ${e}`);
  }
  migrationsRan = true;
}

// ============================================================
// API Routes
// ============================================================

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Run migrations once per worker instance (idempotent, fast after first
    // successful run since module-level flag guards repeated execution).
    await ensureMigrations(env.DB);

    const url = new URL(request.url);
    const path = url.pathname;

    try {
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
        let { message, threadId, model = 'google/gemma-4-31b-it:free', provider = 'openrouter', image } = body;

        if (!message) return json({ error: 'message required' }, 400);

        // Whitelist provider to prevent garbage input falling through to untested paths.
        const ALLOWED_PROVIDERS = ['openrouter', 'ollama', 'openai', 'anthropic', 'groq', 'xai', 'huggingface'];
        if (!ALLOWED_PROVIDERS.includes(provider)) provider = 'openrouter';

        // Get or create thread
        let activeThreadId = threadId;
        if (!activeThreadId) {
          activeThreadId = crypto.randomUUID();
          await env.DB.prepare(
            'INSERT INTO threads (id, title, last_message_at) VALUES (?, ?, datetime("now"))'
          ).bind(activeThreadId, message.substring(0, 50)).run();
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

        // Build system prompt
        const systemPrompt = await buildSystemPrompt(env.DB);

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

              if (mcpTools.length > 0) {
                // Non-streaming path with function calling
                try {
                  const toolResult = await inferenceWithTools(chatMessages, model, provider, env, mcpTools);
                  fullResponse = toolResult.content;
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'chunk', content: fullResponse })}\n\n`));
                  if (toolResult.toolResults.length > 0) {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'tools', results: toolResult.toolResults })}\n\n`));
                  }
                } catch (e) {
                  // Fallback to streaming without tools
                  for await (const token of streamInference(chatMessages, model, provider, env)) {
                    fullResponse += token;
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'chunk', content: token })}\n\n`));
                  }
                }
              } else {
                // Stream tokens (no tools)
                for await (const token of streamInference(chatMessages, model, provider, env)) {
                  fullResponse += token;
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'chunk', content: token })}\n\n`));
                }
              }

              // Check for reaction marker at the start of the response
              let cleanResponse = fullResponse;
              const reactMatch = fullResponse.match(/^\[react:\s*(.+?)\]\s*/);
              if (reactMatch) {
                const emoji = reactMatch[1].trim();
                cleanResponse = fullResponse.slice(reactMatch[0].length);
                // Send reaction event for the user's last message
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'reaction', emoji })}\n\n`));
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

              // Send complete
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'complete', content: cleanResponse, model })}\n\n`));
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            } catch (err) {
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
            ...corsHeaders,
          },
        });
      }

      // ---- Threads ----
      if (path === '/api/threads' && request.method === 'GET') {
        const threads = await env.DB.prepare(
          'SELECT * FROM threads ORDER BY last_message_at DESC LIMIT 50'
        ).all();
        return json(threads.results || []);
      }

      if (path === '/api/threads' && request.method === 'POST') {
        const id = crypto.randomUUID();
        const { title } = await request.json() as any;
        await env.DB.prepare(
          'INSERT INTO threads (id, title, last_message_at) VALUES (?, ?, datetime("now"))'
        ).bind(id, title || 'New conversation').run();
        return json({ id, title });
      }

      if (path.startsWith('/api/threads/') && request.method === 'DELETE') {
        const id = path.split('/')[3];
        await env.DB.prepare('DELETE FROM threads WHERE id = ?').bind(id).run();
        return json({ success: true });
      }

      // ---- Messages ----
      if (path.startsWith('/api/messages/') && request.method === 'GET') {
        const threadId = path.split('/')[3];
        const messages = await env.DB.prepare(
          'SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at ASC'
        ).bind(threadId).all();
        return json(messages.results || []);
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
        // Insert scoped rows. We silently drop anything malformed rather than
        // failing the whole import — a partial restore beats a total refusal.
        for (const row of (bundle.identity || [])) {
          try {
            await env.DB.prepare(
              'INSERT INTO identity (companion_id, content, identity_type, priority, pinned) VALUES (?, ?, ?, ?, ?)'
            ).bind(newId, row.content, row.identity_type || 'trait', row.priority ?? 5, row.pinned ? 1 : 0).run();
          } catch {}
        }
        for (const row of (bundle.memories || [])) {
          try {
            await env.DB.prepare(
              'INSERT INTO memories (companion_id, content, memory_type, emotional_weight) VALUES (?, ?, ?, ?)'
            ).bind(newId, row.content, row.memory_type || 'core', row.emotional_weight ?? 5).run();
          } catch {}
        }
        for (const row of (bundle.people || [])) {
          try {
            await env.DB.prepare(
              'INSERT INTO people (companion_id, name, category, content) VALUES (?, ?, ?, ?)'
            ).bind(newId, row.name, row.category || 'friend', row.content).run();
          } catch {}
        }
        for (const row of (bundle.important_dates || [])) {
          try {
            await env.DB.prepare(
              'INSERT INTO important_dates (companion_id, date_name, actual_date, date_type, recurring) VALUES (?, ?, ?, ?, ?)'
            ).bind(newId, row.date_name, row.actual_date, row.date_type || 'event', row.recurring ? 1 : 0).run();
          } catch {}
        }
        // Imported files carry only the extracted text, not the original
        // bytes — r2_key is empty to signal "imported, no binary".
        for (const row of (bundle.files || [])) {
          try {
            await env.DB.prepare(
              'INSERT INTO companion_files (companion_id, filename, r2_key, file_size, file_type, extracted_text) VALUES (?, ?, ?, ?, ?, ?)'
            ).bind(newId, row.filename, '', row.file_size || null, row.file_type || null, row.extracted_text || '').run();
          } catch {}
        }
        return json({ success: true, id: newId });
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
                ...corsHeaders,
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

      // ---- Identity ----
      if (path === '/api/identity' && request.method === 'GET') {
        const identity = await env.DB.prepare(
          'SELECT * FROM identity ORDER BY pinned DESC, priority DESC'
        ).all();
        return json(identity.results || []);
      }

      if (path === '/api/identity' && request.method === 'POST') {
        const { content, identity_type = 'trait', priority = 5, pinned = false } = await request.json() as any;
        const result = await env.DB.prepare(
          'INSERT INTO identity (content, identity_type, priority, pinned) VALUES (?, ?, ?, ?)'
        ).bind(content, identity_type, priority, pinned ? 1 : 0).run();
        return json({ success: true, id: result.meta.last_row_id });
      }

      if (path.startsWith('/api/identity/') && request.method === 'DELETE') {
        const id = path.split('/')[3];
        await env.DB.prepare('DELETE FROM identity WHERE id = ?').bind(id).run();
        return json({ success: true });
      }

      // ---- Memories ----
      if (path === '/api/memories' && request.method === 'GET') {
        const memories = await env.DB.prepare(
          'SELECT * FROM memories ORDER BY created_at DESC LIMIT 50'
        ).all();
        return json(memories.results || []);
      }

      if (path === '/api/memories' && request.method === 'POST') {
        const { content, memory_type = 'core', emotional_weight = 5 } = await request.json() as any;
        await env.DB.prepare(
          'INSERT INTO memories (content, memory_type, emotional_weight) VALUES (?, ?, ?)'
        ).bind(content, memory_type, emotional_weight).run();
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

      // ---- Status ----
      if (path === '/api/status' && request.method === 'GET') {
        const statusRow = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind('companion_status').first<{ value: string }>();
        const presenceRow = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind('companion_presence').first<{ value: string }>();
        return json({
          custom_status: statusRow?.value || null,
          presence: presenceRow?.value || 'online',
        });
      }

      if (path === '/api/status' && request.method === 'PUT') {
        const body = await request.json() as { custom_status?: string; presence?: string };
        if (body.custom_status !== undefined) {
          await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind('companion_status', body.custom_status).run();
        }
        if (body.presence) {
          await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind('companion_presence', body.presence).run();
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
        const models: Array<{ id: string; name: string; provider: string; tier: string; description?: string; context_length?: number }> = [];
        const hasOpenRouter = env.OPENROUTER_API_KEY || await getSettingValue(env.DB, 'openrouter_key');

        // Fetch live models from OpenRouter
        try {
          const res = await fetch('https://openrouter.ai/api/v1/models');
          const data = await res.json() as any;
          for (const m of (data.data || [])) {
            const isFree = m.id?.endsWith(':free') || (Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0);
            // Free models always listed. Paid models listed only when the user
            // has their own OpenRouter key configured (so charges go to them).
            if (isFree || hasOpenRouter) {
              models.push({
                id: m.id,
                name: m.name || m.id,
                provider: 'openrouter',
                tier: isFree ? 'free' : 'paid',
                description: m.description || undefined,
                context_length: m.context_length || undefined,
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

        // Add Ollama models if configured
        const ollamaUrl = env.OLLAMA_URL || await getSettingValue(env.DB, 'ollama_url') || 'https://api.ollama.com';
        const ollamaKey = await getSettingValue(env.DB, 'ollama_key');
        if (ollamaKey || (ollamaUrl && ollamaUrl.startsWith('http'))) {
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
              models.push({ id, name: id, provider: 'ollama', tier: 'included' });
            }
          } catch {}
        }

        // Add custom provider models (HuggingFace, Groq, OpenAI, etc.)
        const customKey = await getSettingValue(env.DB, 'custom_key');
        const customBaseUrl = await getSettingValue(env.DB, 'custom_base_url');
        if (customKey && customBaseUrl) {
          // Detect provider from URL, not the shared provider field
          let customProvider = 'custom';
          if (customBaseUrl.includes('huggingface') || customBaseUrl.includes('hf.co')) customProvider = 'huggingface';
          else if (customBaseUrl.includes('groq.com')) customProvider = 'groq';
          else if (customBaseUrl.includes('openai.com')) customProvider = 'openai';
          else if (customBaseUrl.includes('anthropic.com')) customProvider = 'anthropic';
          else if (customBaseUrl.includes('x.ai')) customProvider = 'xai';

          try {
            const res = await fetch(`${customBaseUrl}/models`, {
              headers: { 'Authorization': `Bearer ${customKey}` },
            });
            const data = await res.json() as any;
            for (const m of (data.data || [])) {
              models.push({
                id: m.id,
                name: m.id,
                provider: customProvider,
                tier: 'included',
              });
            }
          } catch {}
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
            ...corsHeaders,
          },
        });
      }

      // ---- Export Thread ----
      if (path.startsWith('/api/export/thread/') && request.method === 'GET') {
        const threadId = path.split('/')[4];
        const thread = await env.DB.prepare('SELECT * FROM threads WHERE id = ?').bind(threadId).first();
        if (!thread) return json({ error: 'Thread not found' }, 404);

        const messages = await env.DB.prepare(
          'SELECT role, content, model, created_at FROM messages WHERE thread_id = ? ORDER BY created_at ASC'
        ).bind(threadId).all();

        const companion = await env.DB.prepare('SELECT name FROM companion WHERE id = 1').first<{ name: string }>();

        const exported = {
          haven_version: '1.0.0',
          exported_at: new Date().toISOString(),
          companion: companion?.name || 'Companion',
          thread: { id: threadId, title: (thread as any).title, created_at: (thread as any).created_at },
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
            ...corsHeaders,
          },
        });
      }

      // ---- Export All ----
      if (path === '/api/export/all' && request.method === 'GET') {
        const companion = await env.DB.prepare('SELECT * FROM companion WHERE id = 1').first();
        const identity = await env.DB.prepare('SELECT * FROM identity ORDER BY pinned DESC, priority DESC').all();
        const threads = await env.DB.prepare('SELECT * FROM threads ORDER BY last_message_at DESC').all();
        const memories = await env.DB.prepare('SELECT * FROM memories ORDER BY created_at DESC').all();
        const people = await env.DB.prepare('SELECT * FROM people').all();
        const dates = await env.DB.prepare('SELECT * FROM important_dates').all();

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
          haven_version: '1.0.0',
          exported_at: new Date().toISOString(),
          companion,
          identity: identity.results || [],
          threads: threadData,
          memories: memories.results || [],
          people: people.results || [],
          important_dates: dates.results || [],
        };

        return new Response(JSON.stringify(exported, null, 2), {
          headers: {
            'Content-Type': 'application/json',
            'Content-Disposition': `attachment; filename="haven-export-${new Date().toISOString().split('T')[0]}.json"`,
            ...corsHeaders,
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
