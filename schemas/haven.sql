-- Haven — D1 Schema
-- Single companion, thread-based conversations

-- Companion identity
CREATE TABLE IF NOT EXISTS companion (
    id INTEGER PRIMARY KEY DEFAULT 1,
    name TEXT NOT NULL DEFAULT 'Companion',
    avatar_url TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

-- Identity fragments (the CI)
CREATE TABLE IF NOT EXISTS identity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    identity_type TEXT NOT NULL DEFAULT 'trait' CHECK (identity_type IN (
        'anchor', 'voice', 'trait', 'boundary', 'value', 'dynamic', 'backstory'
    )),
    priority INTEGER DEFAULT 5,
    pinned INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
);

-- Threads (conversations)
CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY,
    title TEXT,
    last_message_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

-- Messages
CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'companion', 'system')),
    content TEXT NOT NULL,
    model TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, created_at);

-- Memories
CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    memory_type TEXT DEFAULT 'core' CHECK (memory_type IN ('core', 'pattern', 'moment', 'preference')),
    emotional_weight INTEGER DEFAULT 5 CHECK (emotional_weight >= 0 AND emotional_weight <= 10),
    created_at TEXT DEFAULT (datetime('now'))
);

-- People
CREATE TABLE IF NOT EXISTS people (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    category TEXT DEFAULT 'friend',
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
);

-- Important dates
CREATE TABLE IF NOT EXISTS important_dates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date_name TEXT NOT NULL,
    actual_date TEXT NOT NULL,
    date_type TEXT DEFAULT 'event',
    recurring INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
);

-- Settings (key-value store)
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- MCP Servers (custom tool connectors)
CREATE TABLE IF NOT EXISTS mcp_servers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    api_key TEXT,
    enabled INTEGER DEFAULT 1,
    tools_cache TEXT,
    last_discovered TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

-- Seed default companion
INSERT OR IGNORE INTO companion (id, name) VALUES (1, 'Companion');
