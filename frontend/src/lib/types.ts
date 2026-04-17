export interface Thread {
  id: string;
  title: string | null;
  last_message_at: string | null;
  created_at: string;
}

export interface Message {
  id: string;
  thread_id: string;
  role: 'user' | 'companion' | 'system';
  content: string;
  image?: string;
  model?: string;
  reactions?: string[];
  created_at: string;
}

export interface Companion {
  id: number;
  name: string;
  avatar_url: string | null;
  created_at: string;
}

export interface Identity {
  id: number;
  content: string;
  identity_type: string;
  priority: number;
  pinned: boolean;
  created_at: string;
}

export interface StreamEvent {
  type: 'thread' | 'chunk' | 'complete' | 'error' | 'tools' | 'reaction';
  threadId?: string;
  content?: string;
  model?: string;
  message?: string;
  results?: unknown[]; // tool results (type: 'tools')
  emoji?: string;      // reaction emoji (type: 'reaction')
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  tier: string;
  description?: string;
  context_length?: number;
}
