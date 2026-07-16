const TERMINAL_KINDS = new Set(['done', 'error']);
const APPROVED_DECISIONS = new Set(['approve', 'approved', 'allow', 'allowed', 'yes']);

type RelayRole = 'client' | 'bridge';
type Envelope = { type?: string; requestId?: unknown; payload?: any; lastSeq?: unknown; [key: string]: any };
type RelayEvent = Envelope & { type: 'event'; requestId: string; seq: number; payload: { kind: string; data: unknown } };
type Status = 'running' | 'paused' | 'completed' | 'cancelled';
type RequestState = {
  requestId: string;
  run: unknown;
  status: Status;
  nextSeq: number;
  buffer: RelayEvent[];
  deferred: Array<{ kind: string; data: unknown }>;
  pendingApproval: { actionId: string; seq: number } | null;
  resolvedApprovals: Set<string>;
  lastSendError: unknown;
  updatedAt: number;
};
type SerializedRequestState = Omit<RequestState, 'resolvedApprovals' | 'lastSendError'> & {
  resolvedApprovals: string[];
  lastSendError: null;
};
type SessionState = {
  requestId: string;
  status: Status;
  lastSeq: number;
  bufferedFrom: number | undefined;
  bufferedTo: number | undefined;
  pendingApproval: { actionId: string; seq: number } | null;
  deferredCount: number;
};
type HandleResult = {
  accepted: boolean;
  duplicate?: boolean;
  reason?: string;
  replayed?: number;
  approved?: boolean;
  flushed?: number;
  event?: RelayEvent;
  state?: SessionState;
};

function requestIdOf(envelope?: Envelope): unknown {
  return envelope?.requestId ?? envelope?.payload?.requestId;
}

function actionIdOf(value: any): string | undefined {
  const candidate = value?.actionId ?? value?.action_id ?? value?.id;
  return candidate === undefined || candidate === null ? undefined : String(candidate);
}

function isApproved(decision: unknown): boolean {
  if (decision === true) return true;
  return typeof decision === 'string' && APPROVED_DECISIONS.has(decision.trim().toLowerCase());
}

/**
 * Transport-independent state machine for one bridge connection.
 * Runs are registered by handle({type: 'run', ...}); producers then feed
 * normalized output through pushEvent().
 */
export class BridgeSession {
  private readonly send: (envelope: Envelope) => void;
  private readonly bufferSize: number;
  private readonly requests = new Map<string, RequestState>();

  constructor({ send, bufferSize = 500 }: { send?: (envelope: Envelope) => void; bufferSize?: number } = {}) {
    if (typeof send !== 'function') throw new TypeError('send must be a function.');
    if (!Number.isInteger(bufferSize) || bufferSize <= 0) {
      throw new TypeError('bufferSize must be a positive integer.');
    }

    this.send = send;
    this.bufferSize = bufferSize;
  }

  handle(envelope: Envelope): HandleResult {
    if (!envelope || typeof envelope !== 'object') {
      throw new TypeError('envelope must be an object.');
    }

    const requestId = requestIdOf(envelope);
    if (requestId === undefined || requestId === null || requestId === '') {
      throw new TypeError('envelope.requestId is required.');
    }

    switch (envelope.type) {
      case 'run':
        return this.#run(String(requestId), envelope.payload);
      case 'resume':
        return this.#resume(String(requestId), envelope.payload?.lastSeq ?? envelope.lastSeq);
      case 'approve':
        return this.#approve(String(requestId), envelope.payload ?? envelope);
      case 'cancel':
        return this.#cancel(String(requestId));
      default:
        throw new TypeError(`Unsupported envelope type: ${envelope.type}`);
    }
  }

  pushEvent(requestId: unknown, kind: string, data: unknown = {}): RelayEvent | null {
    const state = this.requests.get(String(requestId));
    if (!state) throw new Error(`Unknown requestId: ${requestId}`);
    if (state.status === 'completed' || state.status === 'cancelled') return null;
    if (typeof kind !== 'string' || !kind) throw new TypeError('kind must be a non-empty string.');

    if (state.status === 'paused') {
      state.deferred.push({ kind, data });
      this.#touch(state);
      return null;
    }

    return this.#emit(state, kind, data);
  }

  getState(requestId: unknown): SessionState | undefined {
    const state = this.requests.get(String(requestId));
    if (!state) return undefined;
    return {
      requestId: state.requestId,
      status: state.status,
      lastSeq: state.nextSeq - 1,
      bufferedFrom: state.buffer[0]?.seq,
      bufferedTo: state.buffer.at(-1)?.seq,
      pendingApproval: state.pendingApproval
        ? { actionId: state.pendingApproval.actionId, seq: state.pendingApproval.seq }
        : null,
      deferredCount: state.deferred.length,
    };
  }

  serialize(requestId: unknown): SerializedRequestState | undefined {
    const state = this.requests.get(String(requestId));
    if (!state) return undefined;
    return {
      ...state,
      resolvedApprovals: [...state.resolvedApprovals],
      // Transport errors are not durable state and may not be structured-cloneable.
      lastSendError: null,
    };
  }

  hydrate(states: Iterable<SerializedRequestState>): void {
    for (const stored of states) {
      this.requests.set(stored.requestId, {
        ...stored,
        resolvedApprovals: new Set(stored.resolvedApprovals),
        lastSendError: null,
      });
    }
  }

  #touch(state: RequestState): void {
    let latest = 0;
    for (const request of this.requests.values()) latest = Math.max(latest, request.updatedAt);
    state.updatedAt = Math.max(Date.now(), latest + 1);
  }

  #run(requestId: string, payload: unknown): HandleResult {
    const existing = this.requests.get(requestId);
    if (existing) {
      return { accepted: false, duplicate: true, state: this.getState(requestId) };
    }

    this.requests.set(requestId, {
      requestId,
      run: payload,
      status: 'running',
      nextSeq: 1,
      buffer: [],
      deferred: [],
      pendingApproval: null,
      resolvedApprovals: new Set(),
      lastSendError: null,
      updatedAt: 0,
    });
    this.#touch(this.requests.get(requestId)!);
    return { accepted: true, duplicate: false, state: this.getState(requestId) };
  }

  #resume(requestId: string, lastSeqValue: unknown): HandleResult {
    const state = this.requests.get(requestId);
    if (!state) return { accepted: false, reason: 'unknown_request', replayed: 0 };

    const parsed = Number(lastSeqValue ?? 0);
    const lastSeq = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
    let replayed = 0;
    for (const event of state.buffer) {
      if (event.seq <= lastSeq) continue;
      this.#deliver(state, event);
      replayed += 1;
    }
    return { accepted: true, replayed, state: this.getState(requestId) };
  }

  #approve(requestId: string, payload: any): HandleResult {
    const state = this.requests.get(requestId);
    if (!state) return { accepted: false, reason: 'unknown_request' };

    const suppliedActionId = actionIdOf(payload);
    const pending = state.pendingApproval;
    if (!pending) {
      const duplicate = suppliedActionId
        ? state.resolvedApprovals.has(suppliedActionId)
        : state.resolvedApprovals.size > 0;
      return { accepted: false, duplicate, reason: duplicate ? 'duplicate' : 'not_paused' };
    }
    if (suppliedActionId && suppliedActionId !== pending.actionId) {
      return { accepted: false, reason: 'wrong_action' };
    }

    state.resolvedApprovals.add(pending.actionId);
    state.pendingApproval = null;
    state.status = 'running';
    this.#touch(state);

    if (!isApproved(payload?.decision)) {
      state.deferred.length = 0;
      const event = this.#emit(state, 'error', {
        message: 'Command approval denied.',
        denied: true,
        actionId: pending.actionId,
      });
      return { accepted: true, approved: false, event };
    }

    const flushed = this.#flushDeferred(state);
    return { accepted: true, approved: true, flushed, state: this.getState(requestId) };
  }

  #cancel(requestId: string): HandleResult {
    const state = this.requests.get(requestId);
    if (!state) return { accepted: false, reason: 'unknown_request' };
    if (state.status === 'completed' || state.status === 'cancelled') {
      return { accepted: false, duplicate: true, state: this.getState(requestId) };
    }

    state.deferred.length = 0;
    state.pendingApproval = null;
    state.status = 'running';
    this.#touch(state);
    const event = this.#emit(state, 'done', { cancelled: true });
    state.status = 'cancelled';
    return { accepted: true, event, state: this.getState(requestId) };
  }

  #flushDeferred(state: RequestState): number {
    let flushed = 0;
    while (state.deferred.length > 0 && state.status === 'running') {
      const next = state.deferred.shift()!;
      this.#emit(state, next.kind, next.data);
      flushed += 1;
    }
    return flushed;
  }

  #emit(state: RequestState, kind: string, data: unknown): RelayEvent {
    const seq = state.nextSeq++;
    const approvalActionId = kind === 'command_approval'
      ? actionIdOf(data) ?? `approval:${seq}`
      : undefined;
    const eventData = approvalActionId && (!data || typeof data !== 'object')
      ? { value: data, actionId: approvalActionId }
      : approvalActionId
        ? { ...(data as object), actionId: approvalActionId }
        : data;
    const event: RelayEvent = {
      requestId: state.requestId,
      type: 'event',
      seq,
      payload: { kind, data: eventData },
    };

    state.buffer.push(event);
    if (state.buffer.length > this.bufferSize) state.buffer.shift();
    this.#deliver(state, event);

    if (kind === 'command_approval') {
      state.pendingApproval = { actionId: approvalActionId!, seq };
      state.status = 'paused';
    } else if (TERMINAL_KINDS.has(kind)) {
      state.pendingApproval = null;
      state.deferred.length = 0;
      state.status = 'completed';
    }
    this.#touch(state);
    return event;
  }

  #deliver(state: RequestState, envelope: Envelope): boolean {
    try {
      this.send(envelope);
      state.lastSendError = null;
      return true;
    } catch (error) {
      // Buffering happens before delivery. A throwing/offline transport must
      // not destroy replay state; resume can deliver the event later.
      state.lastSendError = error;
      return false;
    }
  }
}

export const OFFLINE_MESSAGE = 'Your PC is offline — open the Codex app';
const OPEN = 1;

function eventKindOf(envelope: Envelope): string {
  return envelope?.payload?.kind ?? envelope?.kind;
}

function eventDataOf(envelope: Envelope): unknown {
  if (envelope?.payload && Object.hasOwn(envelope.payload, 'data')) {
    return envelope.payload.data;
  }
  return envelope?.data ?? {};
}

export class CodexRelay {
  private readonly ctx: DurableObjectState;
  private readonly env: unknown;
  private readonly session: BridgeSession;

  constructor(ctx: DurableObjectState, env: unknown) {
    this.ctx = ctx;
    this.env = env;
    this.session = new BridgeSession({
      send: (envelope) => this.#sendClient(envelope),
    });
    this.ctx.blockConcurrencyWhile(async () => {
      const stored = await this.ctx.storage.list<SerializedRequestState>({ prefix: 'req:' });
      this.session.hydrate(stored.values());
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 });
    }

    const role = request.headers.get('X-Codex-Relay-Role');
    if (role !== 'client' && role !== 'bridge') {
      return new Response('Missing or invalid relay role', { status: 400 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const previous = role === 'client' ? this.#client() : this.#bridge();
    if (previous) {
      try {
        previous.close(1012, `${role} connection replaced`);
      } catch {
        // The previous peer may already have closed.
      }
    }
    server.serializeAttachment({ role });
    this.ctx.acceptWebSocket(server, [role]);

    if (role === 'bridge') {
      this.#sendPresence(true);
    } else {
      this.#sendPresence(this.#isOpen(this.#bridge()));
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const role = this.#role(socket);
    if (!role) return;
    await this.#onMessage(role, socket, message);
  }

  webSocketClose(socket: WebSocket, _code: number, _reason: string, _wasClean: boolean): void {
    if (this.#role(socket) === 'bridge') this.#sendPresence(false);
  }

  webSocketError(socket: WebSocket, _error: unknown): void {
    try {
      socket.close(1011, 'WebSocket error');
    } catch {
      if (this.#role(socket) === 'bridge') this.#sendPresence(false);
    }
  }

  async #onMessage(role: RelayRole, socket: WebSocket, data: unknown): Promise<void> {
    let envelope: Envelope | undefined;
    try {
      if (typeof data !== 'string') {
        throw new TypeError('Binary WebSocket messages are not supported.');
      }
      envelope = JSON.parse(data);
      if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
        throw new TypeError('Envelope must be a JSON object.');
      }

      if (role === 'client') {
        await this.#handleClientEnvelope(envelope);
      } else {
        await this.#handleBridgeEnvelope(envelope);
      }
    } catch (error) {
      this.#sendSocket(socket, {
        type: 'error',
        requestId: requestIdOf(envelope),
        payload: {
          code: 'invalid_envelope',
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  async #handleClientEnvelope(envelope: Envelope): Promise<void> {
    const requestId = requestIdOf(envelope);

    if (envelope.type === 'run' && !this.#isOpen(this.#bridge())) {
      this.#sendClient({
        type: 'error',
        requestId,
        payload: { code: 'bridge_offline', message: OFFLINE_MESSAGE },
      });
      return;
    }

    const result = this.session.handle(envelope);
    if (envelope.type === 'run' || envelope.type === 'approve' || envelope.type === 'cancel') {
      await this.#persist(String(requestId));
    }

    switch (envelope.type) {
      case 'resume':
        return;
      case 'run':
      case 'approve':
      case 'cancel':
        if (!result.accepted) return;
        if (!this.#sendBridge(envelope) && envelope.type === 'run') {
          this.session.pushEvent(String(requestId), 'error', {
            code: 'bridge_offline',
            message: OFFLINE_MESSAGE,
          });
          await this.#persist(String(requestId));
        }
        return;
      default:
        // BridgeSession.handle supplies the canonical unsupported-type error.
        return;
    }
  }

  async #handleBridgeEnvelope(envelope: Envelope): Promise<void> {
    if (envelope.type !== 'event') {
      throw new TypeError(`Unsupported bridge envelope type: ${envelope.type}`);
    }

    const requestId = requestIdOf(envelope);
    if (requestId === undefined || requestId === null || requestId === '') {
      throw new TypeError('envelope.requestId is required.');
    }

    this.session.pushEvent(String(requestId), eventKindOf(envelope), eventDataOf(envelope));
    await this.#persist(String(requestId));
  }

  async #persist(requestId: string): Promise<void> {
    const serialized = this.session.serialize(requestId);
    if (!serialized) return;
    await this.ctx.storage.put(`req:${requestId}`, serialized);

    const stored = await this.ctx.storage.list<SerializedRequestState>({ prefix: 'req:' });
    if (stored.size <= 20) return;
    const oldest = [...stored.entries()]
      .sort(([, left], [, right]) => left.updatedAt - right.updatedAt)
      .slice(0, stored.size - 20)
      .map(([key]) => key);
    await this.ctx.storage.delete(oldest);
  }

  #sendPresence(online: boolean): boolean {
    const client = this.#client();
    if (!this.#isOpen(client)) return false;
    return this.#sendSocket(client!, { type: 'presence', online });
  }

  #sendClient(envelope: Envelope): void {
    const client = this.#client();
    if (!this.#isOpen(client)) {
      throw new Error('Client WebSocket is offline.');
    }
    if (!this.#sendSocket(client!, envelope)) {
      throw new Error('Client WebSocket send failed.');
    }
  }

  #sendBridge(envelope: Envelope): boolean {
    const bridge = this.#bridge();
    if (!this.#isOpen(bridge)) return false;
    return this.#sendSocket(bridge!, envelope);
  }

  #sendSocket(socket: WebSocket, envelope: Envelope): boolean {
    try {
      socket.send(JSON.stringify(envelope));
      return true;
    } catch {
      return false;
    }
  }

  #isOpen(socket: WebSocket | null): boolean {
    return socket?.readyState === OPEN;
  }

  #client(): WebSocket | null {
    return this.ctx.getWebSockets('client')[0] ?? null;
  }

  #bridge(): WebSocket | null {
    return this.ctx.getWebSockets('bridge')[0] ?? null;
  }

  #role(socket: WebSocket): RelayRole | null {
    const role = socket.deserializeAttachment()?.role;
    return role === 'client' || role === 'bridge' ? role : null;
  }
}

export default BridgeSession;
