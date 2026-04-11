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

  return prompt;
}

async function getSettingValue(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>();
  return row?.value || null;
}

async function* streamInference(
  messages: Array<{ role: string; content: string }>,
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
  } else if (customBaseUrl && customKey && ['openai', 'anthropic', 'groq', 'xai'].includes(detectedProvider || '')) {
    url = `${customBaseUrl}/chat/completions`;
    headers['Authorization'] = `Bearer ${customKey}`;
  } else {
    url = 'https://openrouter.ai/api/v1/chat/completions';
    headers['Authorization'] = `Bearer ${openrouterKey}`;
    headers['HTTP-Referer'] = 'https://haven.pages.dev';
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
// API Routes
// ============================================================

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

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
        const { message, threadId, model = 'stepfun/step-3.5-flash:free', provider = 'openrouter' } = body;

        if (!message) return json({ error: 'message required' }, 400);

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
        const chatMessages = [
          { role: 'system', content: systemPrompt },
          ...(history.results || []).map(m => ({
            role: m.role === 'companion' ? 'assistant' : m.role,
            content: m.content,
          })),
        ];

        // Stream response
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          async start(controller) {
            try {
              let fullResponse = '';

              // Send thread ID
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'thread', threadId: activeThreadId })}\n\n`));

              // Stream tokens
              for await (const token of streamInference(chatMessages, model, provider, env)) {
                fullResponse += token;
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'chunk', content: token })}\n\n`));
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

      // ---- Companion ----
      if (path === '/api/companion' && request.method === 'GET') {
        const companion = await env.DB.prepare('SELECT * FROM companion WHERE id = 1').first();
        return json(companion || { id: 1, name: 'Companion' });
      }

      if (path === '/api/companion' && request.method === 'PUT') {
        const { name, avatar_url } = await request.json() as any;
        await env.DB.prepare(
          'UPDATE companion SET name = ?, avatar_url = ? WHERE id = 1'
        ).bind(name, avatar_url || null).run();
        return json({ success: true });
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
      if (path === '/api/settings' && request.method === 'GET') {
        const settings = await env.DB.prepare('SELECT * FROM settings').all();
        const obj: Record<string, string> = {};
        for (const row of (settings.results || []) as Array<{ key: string; value: string }>) {
          obj[row.key] = row.value;
        }
        return json(obj);
      }

      if (path === '/api/settings' && request.method === 'PUT') {
        const body = await request.json() as Record<string, string>;
        for (const [key, value] of Object.entries(body)) {
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
            // Only show free models by default — users add paid models through their own OpenRouter key
            if (isFree) {
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

      return json({ error: 'Not found' }, 404);

    } catch (err) {
      return json({ error: String(err) }, 500);
    }
  },
};
