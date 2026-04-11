/**
 * Haven API client — talks to the worker
 */

import type { Thread, Message, Companion, Identity, ModelInfo } from './types';

const API = localStorage.getItem('haven-api-url') || import.meta.env.VITE_API_URL || '';

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`);
  return res.json();
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

async function put<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function del(path: string): Promise<void> {
  await fetch(`${API}${path}`, { method: 'DELETE' });
}

// Threads
export const getThreads = () => get<Thread[]>('/api/threads');
export const createThread = (title?: string) => post<{ id: string }>('/api/threads', { title });
export const deleteThread = (id: string) => del(`/api/threads/${id}`);

// Messages
export const getMessages = (threadId: string) => get<Message[]>(`/api/messages/${threadId}`);

// Companion
export const getCompanion = () => get<Companion>('/api/companion');
export const updateCompanion = (data: Partial<Companion>) => put('/api/companion', data);

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

// File upload
export async function uploadFile(file: File): Promise<{ key: string; url: string }> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`${API}/api/upload`, { method: 'POST', body: form });
  return res.json();
}

// Export
export function exportThreadUrl(threadId: string): string {
  return `${API}/api/export/thread/${threadId}`;
}

export function exportAllUrl(): string {
  return `${API}/api/export/all`;
}

// Chat (SSE stream)
export async function* sendChat(
  message: string,
  threadId: string | null,
  model: string,
  provider: string,
  image?: string,
): AsyncGenerator<{ type: string; content?: string; threadId?: string; model?: string; message?: string }> {
  const res = await fetch(`${API}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, threadId, model, provider, ...(image ? { image } : {}) }),
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
