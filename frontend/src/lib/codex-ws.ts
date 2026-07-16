import { apiBase, getAuthToken } from './api';
import type { StreamEvent } from './types';

type CodexPayload = {
  requestId: string;
  [key: string]: unknown;
};

type RelayEnvelope = {
  type?: string;
  requestId?: string;
  seq?: number;
  online?: boolean;
  payload?: {
    kind?: string;
    code?: string;
    message?: string;
    data?: unknown;
  };
};

type PendingRun = {
  requestId: string;
  lastSeq: number;
  sent: boolean;
  terminal: boolean;
  reactionEmitted: boolean;
  queue: StreamEvent[];
  waiters: Array<(event: StreamEvent) => void>;
};

type PresenceListener = (online: boolean) => void;

const pending = new Map<string, PendingRun>();
const presenceListeners = new Set<PresenceListener>();
let socket: WebSocket | null = null;
let connectPromise: Promise<WebSocket> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
let providerActive = false;
let presenceOnline = false;

function websocketUrl(): string {
  const base = new URL(apiBase() || window.location.origin, window.location.origin);
  const url = new URL('/api/codex/ws', base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const token = getAuthToken();
  if (token) url.searchParams.set('token', token);
  return url.toString();
}

function publishPresence(online: boolean): void {
  presenceOnline = online;
  presenceListeners.forEach((listener) => listener(online));
}

function enqueue(run: PendingRun, event: StreamEvent): void {
  const waiter = run.waiters.shift();
  if (waiter) waiter(event);
  else run.queue.push(event);
}

function dataRecord(data: unknown): Record<string, unknown> {
  return data && typeof data === 'object' ? data as Record<string, unknown> : {};
}

function messageText(data: unknown): string {
  if (typeof data === 'string') return data;
  const record = dataRecord(data);
  for (const key of ['text', 'message', 'content', 'value']) {
    if (typeof record[key] === 'string') return record[key] as string;
  }
  return '';
}

function handleEnvelope(envelope: RelayEnvelope): void {
  if (envelope.type === 'presence') {
    const online = envelope.online === true;
    publishPresence(online);
    if (!online) {
      for (const run of pending.values()) {
        if (!run.terminal) enqueue(run, { type: 'notice', message: 'PC offline' });
      }
    }
    return;
  }

  const requestId = envelope.requestId;
  if (!requestId) return;
  const run = pending.get(requestId);
  if (!run || run.terminal) return;

  if (envelope.type === 'error') {
    const message = envelope.payload?.message || 'Codex relay error';
    run.terminal = true;
    enqueue(run, { type: 'error', message });
    return;
  }

  if (envelope.type !== 'event' || !envelope.payload?.kind) return;
  if (typeof envelope.seq === 'number') {
    if (envelope.seq <= run.lastSeq) return;
    run.lastSeq = envelope.seq;
  }

  const kind = envelope.payload.kind;
  const data = envelope.payload.data;
  if (kind === 'message') {
    const text = messageText(data);
    const reactionPattern = /\[react:\s*(.+?)\]/gi;
    let firstEmoji: string | undefined;
    const newline = text.match(/\r?\n/)?.[0] ?? '\n';
    const cleanText = text
      .split(/\r?\n/)
      .map((line) => {
        let hadReaction = false;
        const cleanLine = line.replace(reactionPattern, (_marker, emoji: string) => {
          hadReaction = true;
          if (firstEmoji === undefined) firstEmoji = emoji.trim();
          return '';
        });
        return hadReaction && cleanLine.trim() === '' ? null : cleanLine;
      })
      .filter((line): line is string => line !== null)
      .join(newline);

    if (firstEmoji !== undefined && !run.reactionEmitted) {
      run.reactionEmitted = true;
      enqueue(run, { type: 'reaction', emoji: firstEmoji });
    }
    if (cleanText.trim()) enqueue(run, { type: 'chunk', content: `${cleanText}\n` });
    return;
  }
  if (kind === 'file_change') {
    const record = dataRecord(data);
    const file = String(record.path ?? record.file ?? '');
    if (file) {
      enqueue(run, {
        type: 'file_change',
        file,
        changeType: String(record.changeType ?? record.change_type ?? 'update'),
        summary: typeof record.summary === 'string' ? record.summary : undefined,
      });
    }
    return;
  }
  if (kind === 'error') {
    const record = dataRecord(data);
    run.terminal = true;
    enqueue(run, { type: 'error', message: String(record.message ?? 'Codex run failed') });
    return;
  }
  if (kind === 'done') {
    run.terminal = true;
    enqueue(run, { type: 'complete', model: 'codex' });
  }
}

function scheduleReconnect(): void {
  if (!providerActive || reconnectTimer || socket?.readyState === WebSocket.OPEN) return;
  const delay = Math.min(30_000, 500 * (2 ** reconnectAttempt));
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void ensureConnected().catch(() => scheduleReconnect());
  }, delay);
}

function ensureConnected(): Promise<WebSocket> {
  if (socket?.readyState === WebSocket.OPEN) return Promise.resolve(socket);
  if (connectPromise) return connectPromise;

  connectPromise = new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(websocketUrl());
    let opened = false;
    socket = ws;
    ws.addEventListener('open', () => {
      opened = true;
      reconnectAttempt = 0;
      connectPromise = null;
      for (const run of pending.values()) {
        if (run.sent && !run.terminal) {
          ws.send(JSON.stringify({ type: 'resume', requestId: run.requestId, lastSeq: run.lastSeq }));
        }
      }
      resolve(ws);
    }, { once: true });
    ws.addEventListener('message', (event) => {
      try { handleEnvelope(JSON.parse(String(event.data))); } catch { /* ignore malformed relay frames */ }
    });
    ws.addEventListener('close', () => {
      if (socket === ws) socket = null;
      connectPromise = null;
      publishPresence(false);
      scheduleReconnect();
      if (!opened) reject(new Error('Unable to connect to the Codex relay'));
    });
    ws.addEventListener('error', () => {
      if (ws.readyState !== WebSocket.OPEN) reject(new Error('Unable to connect to the Codex relay'));
    }, { once: true });
  });
  return connectPromise;
}

function nextEvent(run: PendingRun, signal?: AbortSignal): Promise<StreamEvent> {
  const queued = run.queue.shift();
  if (queued) return Promise.resolve(queued);
  return new Promise((resolve, reject) => {
    const wrapped = (event: StreamEvent) => {
      signal?.removeEventListener('abort', onAbort);
      resolve(event);
    };
    const onAbort = () => {
      const index = run.waiters.indexOf(wrapped);
      if (index >= 0) run.waiters.splice(index, 1);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    if (signal?.aborted) return onAbort();
    run.waiters.push(wrapped);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function setCodexProviderActive(active: boolean): void {
  providerActive = active;
  if (!active && reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  // Connect eagerly when the user picks Codex so the presence badge shows
  // live truth immediately, instead of last-known state until the first send.
  if (active) {
    void ensureConnected().catch(() => scheduleReconnect());
  }
}

export function subscribeCodexPresence(listener: PresenceListener): () => void {
  presenceListeners.add(listener);
  listener(presenceOnline);
  return () => presenceListeners.delete(listener);
}

export function cancelCodex(requestId: string): void {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'cancel', requestId }));
  }
}

export async function* sendChatCodex(payload: CodexPayload, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
  const requestId = payload.requestId || crypto.randomUUID();
  const run: PendingRun = {
    requestId,
    lastSeq: 0,
    sent: false,
    terminal: false,
    reactionEmitted: false,
    queue: [],
    waiters: [],
  };
  pending.set(requestId, run);

  try {
    const ws = await ensureConnected();
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    ws.send(JSON.stringify({ type: 'run', requestId, payload: { ...payload, requestId } }));
    run.sent = true;

    // Watchdog: if the relay loses the run (platform recycle) the stream can
    // go silent forever and the thread input stays locked. 6 minutes without
    // ANY event → surface an error and release the UI. The daemon's own
    // ceiling is 10 minutes, and real runs emit progress along the way.
    const INACTIVITY_MS = 6 * 60 * 1000;
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = Symbol('timeout');
      const winner = await Promise.race([
        nextEvent(run, signal),
        new Promise<typeof timedOut>((resolve) => { timer = setTimeout(() => resolve(timedOut), INACTIVITY_MS); }),
      ]).finally(() => clearTimeout(timer));
      if (winner === timedOut) {
        run.terminal = true;
        yield { type: 'error', message: 'Lost contact with your PC mid-run — it may still finish the work locally. Check the workspace or try again.' } as StreamEvent;
        return;
      }
      const event = winner as StreamEvent;
      yield event;
      if (event.type === 'complete' || event.type === 'error') return;
    }
  } finally {
    if (signal?.aborted && run.sent && !run.terminal) cancelCodex(requestId);
    pending.delete(requestId);
  }
}
