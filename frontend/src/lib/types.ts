export interface Thread {
  id: string;
  title: string | null;
  last_message_at: string | null;
  created_at: string;
}

export interface ToolCallRecord {
  name: string;   // e.g. "store_memory", "wren_diary_store"
  server?: string; // which MCP server it came from, if known
  ok?: boolean;   // whether the call succeeded
}

export interface Message {
  id: string;
  thread_id: string;
  role: 'user' | 'companion' | 'system';
  content: string;
  image?: string;
  model?: string;
  reactions?: string[];
  tool_calls?: ToolCallRecord[];
  notice?: string; // soft banner — e.g. "tools unavailable for this response"
  created_at: string;
}

export interface Companion {
  id: number;
  name: string;
  avatar_url: string | null;
  archived_at?: string | null;
  created_at: string;
  has_identity?: boolean;
  has_threads?: boolean;
}

export interface CompanionFile {
  id: number;
  filename: string;
  file_size: number | null;
  file_type: string | null;
  text_length?: number;
  added_at: string;
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
  supports_tools?: boolean; // undefined = unknown; true/false = confirmed
}
