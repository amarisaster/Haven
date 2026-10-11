import { env, exports as workerExports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';

const TOKEN = 'stt-test-token';

function request(path, init = {}) {
  return workerExports.default.fetch(`https://haven.test${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'X-Companion-Id': '1',
      ...(init.headers || {}),
    },
  });
}

beforeEach(async () => {
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)').run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS mcp_servers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    api_key TEXT,
    enabled INTEGER DEFAULT 1,
    tools_cache TEXT,
    last_discovered TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`).run();
  await env.DB.prepare('DELETE FROM settings').run();
  await env.DB.prepare('DELETE FROM mcp_servers').run();
  await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').bind('auth_token', TOKEN).run();
});

describe('optional Attune STT', () => {
  it('stays disabled when no credential is configured', async () => {
    await env.DB.prepare('INSERT INTO mcp_servers (name, url, enabled) VALUES (?, ?, 1)')
      .bind('Attune', 'https://attune.example/mcp').run();
    const response = await request('/api/stt/status');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ attune: false });
  });

  it('detects Attune token authentication in the documented MCP URL', async () => {
    await env.DB.prepare('INSERT INTO mcp_servers (name, url, enabled) VALUES (?, ?, 1)')
      .bind('Attune', 'https://attune.example/mcp?k=secret').run();
    const response = await request('/api/stt/status');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ attune: true });
  });

  it('rejects a transcription request without audio before contacting Attune', async () => {
    const response = await request('/api/stt', { method: 'POST', body: new FormData() });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'No audio provided' });
  });
});
