import { env, exports as workerExports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';

const TOKEN = 'branch-test-token';

function request(path, companionId = 1, init = {}) {
  return workerExports.default.fetch(`https://haven.test${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'X-Companion-Id': String(companionId),
      ...(init.headers || {}),
    },
  });
}

beforeEach(async () => {
  const schema = [
    'CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)',
    `CREATE TABLE IF NOT EXISTS companion (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, avatar_url TEXT,
      archived_at TEXT, created_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY, companion_id INTEGER NOT NULL DEFAULT 1,
      title TEXT, ephemeral INTEGER NOT NULL DEFAULT 0,
      last_message_at TEXT, created_at TEXT DEFAULT (datetime('now')),
      summary TEXT, summary_upto TEXT, summary_msg_count INTEGER DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL,
      role TEXT NOT NULL, content TEXT NOT NULL, model TEXT,
      reactions TEXT, created_at TEXT DEFAULT (datetime('now'))
    )`,
  ];
  for (const statement of schema) await env.DB.prepare(statement).run();
  await env.DB.prepare('DELETE FROM messages').run();
  await env.DB.prepare('DELETE FROM threads').run();
  await env.DB.prepare('DELETE FROM companion').run();
  await env.DB.prepare('DELETE FROM settings').run();
  await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').bind('auth_token', TOKEN).run();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO companion (id, name) VALUES (?, ?)').bind(1, 'Rian'),
    env.DB.prepare('INSERT INTO companion (id, name) VALUES (?, ?)').bind(2, 'Other'),
    env.DB.prepare(
      `INSERT INTO threads
       (id, companion_id, title, ephemeral, last_message_at, summary, summary_upto, summary_msg_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind('source', 1, 'Moonlit road', 1, '2026-10-12 00:00:03', 'Earlier memory', '2026-10-12 00:00:01', 1),
    env.DB.prepare(
      'INSERT INTO messages (id, thread_id, role, content, model, reactions, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind('m1', 'source', 'user', 'First', null, '["❤️"]', '2026-10-12 00:00:01'),
    env.DB.prepare(
      'INSERT INTO messages (id, thread_id, role, content, model, reactions, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind('m2', 'source', 'companion', 'Second', 'kimi-k2.6', null, '2026-10-12 00:00:02'),
    env.DB.prepare(
      'INSERT INTO messages (id, thread_id, role, content, model, reactions, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind('m3', 'source', 'user', 'Must stay only in source', null, null, '2026-10-12 00:00:03'),
  ]);
});

describe('thread branching', () => {
  it('copies the prefix into an independent private thread and preserves valid summary context', async () => {
    const response = await request('/api/threads/source/branch', 1, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId: 'm2' }),
    });
    expect(response.status).toBe(201);
    const branch = await response.json();
    expect(branch).toMatchObject({
      title: 'Moonlit road — branch',
      ephemeral: 1,
      copied_messages: 2,
      branched_from_message_id: 'm2',
    });

    const copied = await env.DB.prepare(
      'SELECT id, role, content, model, reactions, created_at FROM messages WHERE thread_id = ? ORDER BY created_at ASC, rowid ASC'
    ).bind(branch.id).all();
    expect(copied.results.map((row) => row.content)).toEqual(['First', 'Second']);
    expect(copied.results.map((row) => row.id)).not.toContain('m1');
    expect(copied.results[0].reactions).toBe('["❤️"]');
    expect(copied.results[1].model).toBe('kimi-k2.6');

    const thread = await env.DB.prepare(
      'SELECT companion_id, ephemeral, summary, summary_upto, summary_msg_count FROM threads WHERE id = ?'
    ).bind(branch.id).first();
    expect(thread).toMatchObject({
      companion_id: 1,
      ephemeral: 1,
      summary: 'Earlier memory',
      summary_upto: '2026-10-12 00:00:01',
      summary_msg_count: 1,
    });

    const sourceCount = await env.DB.prepare('SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?')
      .bind('source').first();
    expect(sourceCount.n).toBe(3);
  });

  it('does not leak a later compaction summary into an earlier branch', async () => {
    await env.DB.prepare(
      'UPDATE threads SET summary_upto = ?, summary_msg_count = ? WHERE id = ?'
    ).bind('2026-10-12 00:00:02', 2, 'source').run();

    const response = await request('/api/threads/source/branch', 1, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId: 'm1' }),
    });
    expect(response.status).toBe(201);
    const branch = await response.json();
    const thread = await env.DB.prepare(
      'SELECT summary, summary_upto, summary_msg_count FROM threads WHERE id = ?'
    ).bind(branch.id).first();
    expect(thread).toMatchObject({ summary: null, summary_upto: null, summary_msg_count: 0 });
  });

  it('branches by visible chronology even when imported rows were inserted later', async () => {
    await env.DB.prepare(
      'INSERT INTO messages (id, thread_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)'
    ).bind('imported', 'source', 'user', 'Imported earlier', '2026-10-11 23:59:59').run();

    const response = await request('/api/threads/source/branch', 1, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId: 'm2' }),
    });
    expect(response.status).toBe(201);
    const branch = await response.json();
    expect(branch.copied_messages).toBe(3);
    const copied = await env.DB.prepare(
      'SELECT content FROM messages WHERE thread_id = ? ORDER BY created_at ASC, rowid ASC'
    ).bind(branch.id).all();
    expect(copied.results.map((row) => row.content)).toEqual(['Imported earlier', 'First', 'Second']);
  });

  it('rejects cross-companion branching and mismatched branch points', async () => {
    const forbidden = await request('/api/threads/source/branch', 2, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId: 'm2' }),
    });
    expect(forbidden.status).toBe(403);

    const missing = await request('/api/threads/source/branch', 1, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId: 'not-in-source' }),
    });
    expect(missing.status).toBe(404);
  });
});
