/**
 * Haven API client — talks to the worker
 */

import type { Thread, Message, Companion, CompanionFile, Identity, ModelInfo } from './types';

// Resolved per-call so SetupWizard/Settings changes to localStorage take effect
// without a page reload. On native APKs this is the only way the user can
// point the app at their own Worker.
export function apiBase(): string {
  return localStorage.getItem('haven-api-url') || import.meta.env.VITE_API_URL || '';
}

// The currently-active companion. All per-companion API calls scope by this
// via the `X-Companion-Id` header. Defaults to 1 (the seed companion) so
// single-companion installs keep working exactly like pre-v1.7.
export function activeCompanionId(): number {
  const raw = localStorage.getItem('haven-active-companion-id');
  const n = raw ? Number(raw) : 1;
  return Number.isFinite(n) && n > 0 ? n : 1;
}

export function setActiveCompanionId(id: number): void {
  if (Number.isFinite(id) && id > 0) {
    localStorage.setItem('haven-active-companion-id', String(id));
  }
}

// Builds the default headers sent on every API call. The X-Companion-Id
// tells the worker which companion's scoped data to return (or which to
// attribute new rows to).
function scopedHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    'X-Companion-Id': String(activeCompanionId()),
    ...(extra || {}),
  };
}

async function parseJson<T>(res: Response, path: string): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    const head = text.trimStart().slice(0, 20).toLowerCase();
    if (head.startsWith('<!doctype') || head.startsWith('<html')) {
      throw new Error(
        `Worker didn't return JSON for ${path}. Check your Haven Worker URL in Settings — ` +
        `requests are hitting the app shell instead of the API.`
      );
    }
    throw new Error(`Invalid JSON response from ${path}`);
  }
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, { headers: scopedHeaders() });
  return parseJson<T>(res, path);
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, {
    method: 'POST',
    headers: scopedHeaders({ 'Content-Type': 'application/json' }),
    body: body ? JSON.stringify(body) : undefined,
  });
  return parseJson<T>(res, path);
}

async function put<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, {
    method: 'PUT',
    headers: scopedHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  return parseJson<T>(res, path);
}

async function del(path: string): Promise<void> {
  await fetch(`${apiBase()}${path}`, { method: 'DELETE', headers: scopedHeaders() });
}

// Threads
export const getThreads = () => get<Thread[]>('/api/threads');
export const createThread = (title?: string) => post<{ id: string }>('/api/threads', { title });
export const deleteThread = (id: string) => del(`/api/threads/${id}`);
export const renameThread = (id: string, title: string) => put<{ success: boolean }>(`/api/threads/${id}`, { title });
export const deleteMessage = (id: string) => del(`/api/messages/${id}`);
export async function reactMessage(messageId: string, emoji: string): Promise<{ reactions: string[] }> {
  const res = await fetch(`${apiBase()}/api/messages/${messageId}/react`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-Companion-Id': String(activeCompanionId()) },
    body: JSON.stringify({ emoji }),
  });
  return res.json();
}

// Messages
export const getMessages = (threadId: string) => get<Message[]>(`/api/messages/${threadId}`);

// Companion (singular — operates on the active companion via X-Companion-Id)
export const getCompanion = () => get<Companion>('/api/companion');
export const updateCompanion = (data: Partial<Companion>) => put('/api/companion', data);

// Companions (plural — v1.7 multi-companion CRUD)
export const listCompanions = () => get<Companion[]>('/api/companions');
export const listArchivedCompanions = () => get<Companion[]>('/api/companions/archived');
export const createCompanion = (data: { name: string; avatar_url?: string | null }) =>
  post<{ success: boolean; id: number }>('/api/companions', data);
export const updateCompanionById = (id: number, data: Partial<Companion>) =>
  put(`/api/companions/${id}`, data);
export const archiveCompanion = (id: number) =>
  post<{ success: boolean }>(`/api/companions/${id}/archive`);
export const restoreCompanion = (id: number) =>
  post<{ success: boolean }>(`/api/companions/${id}/restore`);

// Companion files
export const listCompanionFiles = (id: number) =>
  get<CompanionFile[]>(`/api/companions/${id}/files`);
export const deleteCompanionFile = (companionId: number, fileId: number) =>
  del(`/api/companions/${companionId}/files/${fileId}`);
export async function uploadCompanionFile(
  companionId: number,
  file: File,
  extractedText?: string,
): Promise<{ success: boolean; id: number; r2_key: string }> {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(`File too large (${Math.round(file.size / 1024 / 1024)}MB). Max 20MB.`);
  }
  const form = new FormData();
  form.append('file', file);
  if (extractedText) form.append('extracted_text', extractedText);
  const res = await fetch(`${apiBase()}/api/companions/${companionId}/files`, {
    method: 'POST',
    headers: scopedHeaders(), // no Content-Type — browser sets multipart boundary
    body: form,
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => '');
    throw new Error(`Upload failed (${res.status}): ${msg.slice(0, 120)}`);
  }
  return res.json();
}

// Companion export / import
export function exportCompanionUrl(companionId: number): string {
  return `${apiBase()}/api/companions/${companionId}/export`;
}
export const importCompanion = (bundle: unknown) =>
  post<{ success: boolean; id: number }>('/api/companions/import', bundle);

// Identity
export const getIdentity = () => get<Identity[]>('/api/identity');
export const addIdentity = (data: Partial<Identity>) => post('/api/identity', data);
export const deleteIdentity = (id: number) => del(`/api/identity/${id}`);

// Memories
export const getMemories = () => get<Array<{ id: number; content: string; memory_type: string; emotional_weight: number }>>('/api/memories');
export const addMemory = (data: { content: string; memory_type?: string; emotional_weight?: number }) => post('/api/memories', data);

// Models
export const getModels = () => get<ModelInfo[]>('/api/models');

// Settings
export const getSettings = () => get<Record<string, string>>('/api/settings');
export const updateSettings = (data: Record<string, string>) => put('/api/settings', data);

// Status
export const getCompanionStatus = () => get<{ custom_status: string | null; presence: string }>('/api/status');
export const setCompanionStatus = (data: { custom_status?: string; presence?: string }) => put('/api/status', data);

// User Status
export const getUserStatus = () => get<{ custom_status: string | null; presence: string }>('/api/user-status');
export const setUserStatus = (data: { custom_status?: string; presence?: string }) => put<{ success: boolean }>('/api/user-status', data);

// Storage
export const getStorageUsage = () => get<{ chat: { count: number; bytes: number }; project: { count: number; bytes: number } }>('/api/storage');
export const clearChatFiles = () => del('/api/storage/chat-files');

// File upload
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20 MB cap — R2 / Workers pay-as-you-go

export async function uploadFile(file: File): Promise<{ key: string; url: string }> {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(`File too large (${Math.round(file.size / 1024 / 1024)}MB). Max 20MB.`);
  }
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`${apiBase()}/api/upload`, {
    method: 'POST',
    headers: scopedHeaders(), // no Content-Type — browser sets multipart boundary
    body: form,
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => '');
    throw new Error(`Upload failed (${res.status}): ${msg.slice(0, 120)}`);
  }
  return res.json();
}

// Export
export function exportThreadUrl(threadId: string): string {
  return `${apiBase()}/api/export/thread/${threadId}`;
}

export function exportAllUrl(): string {
  return `${apiBase()}/api/export/all`;
}

// Chat (SSE stream)
export async function* sendChat(
  message: string,
  threadId: string | null,
  model: string,
  provider: string,
  image?: string,
  thinking?: boolean,
  signal?: AbortSignal,
): AsyncGenerator<{ type: string; content?: string; threadId?: string; model?: string; message?: string; results?: unknown[]; emoji?: string; notice?: string; user_message_id?: string; companion_message_id?: string }> {
  const res = await fetch(`${apiBase()}/api/chat`, {
    method: 'POST',
    headers: scopedHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ message, threadId, model, provider, ...(image ? { image } : {}), ...(thinking ? { thinking: true } : {}) }),
    signal,
  });

  if (!res.ok || !res.body) throw new Error(`Chat failed: ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') return;
      try {
        yield JSON.parse(data);
      } catch {}
    }
  }
}
