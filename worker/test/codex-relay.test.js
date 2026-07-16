import { env, exports as workerExports } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const CLIENT_TOKEN = 'test-client-token';
const CONNECTOR_TOKEN = 'test-connector-token';
const sockets = new Set();

class Inbox {
  constructor(socket) {
    this.messages = [];
    this.waiters = [];
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      const waiter = this.waiters.shift();
      if (waiter) waiter(message);
      else this.messages.push(message);
    });
  }

  next() {
    if (this.messages.length > 0) return Promise.resolve(this.messages.shift());
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  expectNone(delay = 75) {
    if (this.messages.length > 0) return Promise.resolve(this.messages.shift());
    return new Promise((resolve) => {
      let settled = false;
      const waiter = (message) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(message);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        resolve(undefined);
      }, delay);
      this.waiters.push(waiter);
    });
  }
}

async function setSetting(key, value) {
  await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .bind(key, value).run();
}

async function deleteSetting(key) {
  await env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(key).run();
}

function request(path, headers = {}) {
  return workerExports.default.fetch(`https://haven.test${path}`, { headers });
}

async function connect(path, token, connectorHeader = false) {
  const headers = { Upgrade: 'websocket' };
  let route = path;
  if (connectorHeader) headers['X-Codex-Connector-Token'] = token;
  else route += `${route.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;

  const response = await request(route, headers);
  expect(response.status).toBe(101);
  expect(response.webSocket).toBeDefined();
  const inbox = new Inbox(response.webSocket);
  response.webSocket.accept();
  sockets.add(response.webSocket);
  return { socket: response.webSocket, inbox };
}

function send(socket, envelope) {
  socket.send(JSON.stringify(envelope));
}

async function connectPair() {
  const client = await connect('/api/codex/ws', CLIENT_TOKEN);
  expect(await client.inbox.next()).toEqual({ type: 'presence', online: false });
  const bridge = await connect('/api/codex/bridge', CONNECTOR_TOKEN, true);
  expect(await client.inbox.next()).toEqual({ type: 'presence', online: true });
  return { client, bridge };
}

function relayStub() {
  return env.CODEX_RELAY.get(env.CODEX_RELAY.idFromName('relay'));
}

async function waitForStoredState(requestId, predicate) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const stored = await runInDurableObject(relayStub(), (_instance, ctx) => (
      ctx.storage.get(`req:${requestId}`)
    ));
    if (stored && predicate(stored)) return stored;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for durable state: ${requestId}`);
}

beforeEach(async () => {
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)').run();
  await env.DB.prepare('DELETE FROM settings').run();
  await setSetting('auth_token', CLIENT_TOKEN);
  await setSetting('codex_connector_token', CONNECTOR_TOKEN);
  await setSetting('codex_channel_enabled', 'true');
});

afterEach(() => {
  for (const socket of sockets) {
    try { socket.close(1000, 'test complete'); } catch { /* Already closed. */ }
  }
  sockets.clear();
});

describe('CodexRelay Durable Object', () => {
  it('routes a run and delivers bridge events in sequence order', async () => {
    const { client, bridge } = await connectPair();
    const run = { type: 'run', requestId: 'run-1', payload: { prompt: 'hello' } };
    send(client.socket, run);
    expect(await bridge.inbox.next()).toEqual(run);

    send(bridge.socket, { type: 'event', requestId: 'run-1', payload: { kind: 'message', data: { text: 'one' } } });
    send(bridge.socket, { type: 'event', requestId: 'run-1', payload: { kind: 'file_change', data: { path: 'src/a.js' } } });
    send(bridge.socket, { type: 'event', requestId: 'run-1', payload: { kind: 'done', data: { ok: true } } });

    const events = [await client.inbox.next(), await client.inbox.next(), await client.inbox.next()];
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(events.map((event) => event.payload.kind)).toEqual(['message', 'file_change', 'done']);
  });

  it('buffers after a client drop and resumes with the exact suffix', async () => {
    const { client, bridge } = await connectPair();
    send(client.socket, { type: 'run', requestId: 'run-2', payload: { prompt: 'stream' } });
    await bridge.inbox.next();

    for (let seq = 1; seq <= 3; seq += 1) {
      send(bridge.socket, { type: 'event', requestId: 'run-2', payload: { kind: 'message', data: { value: seq } } });
      expect((await client.inbox.next()).seq).toBe(seq);
    }

    client.socket.close(1000, 'phone dropped');
    sockets.delete(client.socket);
    for (let seq = 4; seq <= 6; seq += 1) {
      send(bridge.socket, {
        type: 'event', requestId: 'run-2',
        payload: { kind: seq === 6 ? 'done' : 'message', data: { value: seq } },
      });
    }
    const persisted = await waitForStoredState('run-2', (state) => state.nextSeq === 7);
    expect(persisted.nextSeq).toBe(7);

    const reconnected = await connect('/api/codex/ws', CLIENT_TOKEN);
    expect(await reconnected.inbox.next()).toEqual({ type: 'presence', online: true });
    send(reconnected.socket, { type: 'resume', requestId: 'run-2', lastSeq: 3 });
    const suffix = [await reconnected.inbox.next(), await reconnected.inbox.next(), await reconnected.inbox.next()];
    expect(suffix.map((event) => event.seq)).toEqual([4, 5, 6]);
    expect(suffix.map((event) => event.payload.data.value)).toEqual([4, 5, 6]);
    expect(await reconnected.inbox.expectNone()).toBeUndefined();
  });

  it('publishes offline presence and rejects a new run', async () => {
    const { client, bridge } = await connectPair();
    bridge.socket.close(1000, 'PC offline');
    sockets.delete(bridge.socket);
    expect(await client.inbox.next()).toEqual({ type: 'presence', online: false });
    send(client.socket, { type: 'run', requestId: 'offline-run', payload: { prompt: 'no' } });
    expect(await client.inbox.next()).toEqual({
      type: 'error', requestId: 'offline-run',
      payload: { code: 'bridge_offline', message: 'Your PC is offline — open the Codex app' },
    });
  });

  it('holds output after command approval until approve', async () => {
    const { client, bridge } = await connectPair();
    send(client.socket, { type: 'run', requestId: 'approval-run', payload: {} });
    await bridge.inbox.next();
    send(bridge.socket, {
      type: 'event', requestId: 'approval-run',
      payload: { kind: 'command_approval', data: { actionId: 'action-1', command: 'npm test' } },
    });
    expect((await client.inbox.next()).payload.kind).toBe('command_approval');
    send(bridge.socket, {
      type: 'event', requestId: 'approval-run', payload: { kind: 'message', data: { text: 'held' } },
    });
    expect(await client.inbox.expectNone()).toBeUndefined();

    const approve = { type: 'approve', requestId: 'approval-run', payload: { actionId: 'action-1', decision: 'approve' } };
    send(client.socket, approve);
    const released = await client.inbox.next();
    expect(released.seq).toBe(2);
    expect(released.payload).toEqual({ kind: 'message', data: { text: 'held' } });
    expect(await bridge.inbox.next()).toEqual(approve);
  });

  it('makes duplicate run and approve commands idempotent', async () => {
    const { client, bridge } = await connectPair();
    const run = { type: 'run', requestId: 'dedupe-run', payload: { prompt: 'once' } };
    send(client.socket, run);
    send(client.socket, run);
    expect(await bridge.inbox.next()).toEqual(run);
    expect(await bridge.inbox.expectNone()).toBeUndefined();
    send(bridge.socket, {
      type: 'event', requestId: 'dedupe-run', payload: { kind: 'command_approval', data: { actionId: 'action-2' } },
    });
    await client.inbox.next();
    const approve = { type: 'approve', requestId: 'dedupe-run', payload: { actionId: 'action-2', decision: 'approve' } };
    send(client.socket, approve);
    send(client.socket, approve);
    expect(await bridge.inbox.next()).toEqual(approve);
    expect(await bridge.inbox.expectNone()).toBeUndefined();
  });

  it('keeps both routes invisible when the feature flag is missing', async () => {
    await deleteSetting('codex_channel_enabled');
    const client = await request(`/api/codex/ws?token=${CLIENT_TOKEN}`, { Upgrade: 'websocket' });
    const bridge = await request('/api/codex/bridge', { Upgrade: 'websocket', 'X-Codex-Connector-Token': CONNECTOR_TOKEN });
    expect(client.status).toBe(404);
    expect(bridge.status).toBe(404);
  });

  it('fails closed when the connector token setting is missing', async () => {
    await deleteSetting('codex_connector_token');
    const response = await request('/api/codex/bridge?token=anything', {
      Upgrade: 'websocket', 'X-Codex-Connector-Token': 'anything',
    });
    expect(response.status).toBe(401);
  });

  it('requires the correct client query token when Haven is secured', async () => {
    const absent = await request('/api/codex/ws', { Upgrade: 'websocket' });
    const wrong = await request('/api/codex/ws?token=wrong', { Upgrade: 'websocket' });
    expect(absent.status).toBe(401);
    expect(wrong.status).toBe(401);
    const correct = await connect('/api/codex/ws', CLIENT_TOKEN);
    expect(await correct.inbox.next()).toEqual({ type: 'presence', online: false });
  });

  it('commits request state to durable storage before instance loss', async () => {
    const { client, bridge } = await connectPair();
    send(client.socket, { type: 'run', requestId: 'durable-run', payload: { prompt: 'persist' } });
    await bridge.inbox.next();
    for (let seq = 1; seq <= 3; seq += 1) {
      send(bridge.socket, {
        type: 'event', requestId: 'durable-run',
        payload: { kind: 'message', data: { value: seq } },
      });
      expect((await client.inbox.next()).seq).toBe(seq);
    }

    const stored = await runInDurableObject(relayStub(), (_instance, ctx) => (
      ctx.storage.get('req:durable-run')
    ));
    expect(stored).toMatchObject({ requestId: 'durable-run', nextSeq: 4, status: 'running' });
    expect(stored.buffer.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(stored.resolvedApprovals).toEqual([]);
  });

  it('hydrates state after eviction and resumes the buffered suffix', async () => {
    const { client, bridge } = await connectPair();
    send(client.socket, { type: 'run', requestId: 'evicted-run', payload: { prompt: 'resume' } });
    await bridge.inbox.next();
    for (let seq = 1; seq <= 4; seq += 1) {
      send(bridge.socket, {
        type: 'event', requestId: 'evicted-run',
        payload: { kind: seq === 4 ? 'done' : 'message', data: { value: seq } },
      });
      expect((await client.inbox.next()).seq).toBe(seq);
    }

    await evictDurableObject(relayStub());
    send(client.socket, { type: 'resume', requestId: 'evicted-run', lastSeq: 2 });
    const suffix = [await client.inbox.next(), await client.inbox.next()];
    expect(suffix.map((event) => event.seq)).toEqual([3, 4]);
    expect(suffix.map((event) => event.payload.data.value)).toEqual([3, 4]);
    expect(await client.inbox.expectNone()).toBeUndefined();
  });

  it('keeps only the 20 most recent terminal requests in durable storage', async () => {
    const { client, bridge } = await connectPair();
    for (let index = 0; index < 21; index += 1) {
      const requestId = `cap-${String(index).padStart(2, '0')}`;
      send(client.socket, { type: 'run', requestId, payload: {} });
      expect((await bridge.inbox.next()).requestId).toBe(requestId);
      send(bridge.socket, {
        type: 'event', requestId,
        payload: { kind: 'done', data: { index } },
      });
      expect((await client.inbox.next()).requestId).toBe(requestId);
    }

    const keys = await runInDurableObject(relayStub(), async (_instance, ctx) => (
      [...(await ctx.storage.list({ prefix: 'req:' })).keys()]
    ));
    expect(keys).toHaveLength(20);
    expect(keys).not.toContain('req:cap-00');
    expect(keys).toContain('req:cap-20');
  });
});
