-- Haven — D1 Schema
-- Multi-companion since v1.7.0 (identity / threads / memories / people /
-- important_dates / companion_files are scoped per-companion; settings and
-- mcp_servers remain global per-user).

-- Companions (multiple per Haven instance as of v1.7.0; archived_at hides
-- without deleting — archived companions are not shown in the switcher
-- but all their data is preserved).
CREATE TABLE IF NOT EXISTS companion (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL DEFAULT 'Companion',
    avatar_url TEXT,
    archived_at TEXT DEFAULT NULL,
    created_at TEXT DEFAULT (datetime('now'))
);

-- Identity fragments (the CI)
CREATE TABLE IF NOT EXISTS identity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    companion_id INTEGER NOT NULL DEFAULT 1 REFERENCES companion(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    identity_type TEXT NOT NULL DEFAULT 'trait' CHECK (identity_type IN (
        'anchor', 'voice', 'trait', 'boundary', 'value', 'dynamic', 'backstory', 'personality'
    )),
    priority INTEGER DEFAULT 5,
    pinned INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_identity_companion ON identity(companion_id, pinned, priority);

-- Threads (conversations)
CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY,
    companion_id INTEGER NOT NULL DEFAULT 1 REFERENCES companion(id) ON DELETE CASCADE,
    title TEXT,
    last_message_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_threads_companion ON threads(companion_id, last_message_at DESC);

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
    companion_id INTEGER NOT NULL DEFAULT 1 REFERENCES companion(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    memory_type TEXT DEFAULT 'core' CHECK (memory_type IN ('core', 'pattern', 'moment', 'preference')),
    emotional_weight INTEGER DEFAULT 5 CHECK (emotional_weight >= 0 AND emotional_weight <= 10),
    created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_memories_companion ON memories(companion_id, created_at DESC);

-- People
CREATE TABLE IF NOT EXISTS people (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    companion_id INTEGER NOT NULL DEFAULT 1 REFERENCES companion(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    category TEXT DEFAULT 'friend',
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_people_companion ON people(companion_id);

-- Important dates
CREATE TABLE IF NOT EXISTS important_dates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    companion_id INTEGER NOT NULL DEFAULT 1 REFERENCES companion(id) ON DELETE CASCADE,
    date_name TEXT NOT NULL,
    actual_date TEXT NOT NULL,
    date_type TEXT DEFAULT 'event',
    recurring INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_important_dates_companion ON important_dates(companion_id);

-- Companion project files (attached PDFs / text / code — loaded into the
-- system prompt as "Project Files" when chatting with this companion).
CREATE TABLE IF NOT EXISTS companion_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    companion_id INTEGER NOT NULL REFERENCES companion(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    r2_key TEXT NOT NULL,
    file_size INTEGER,
    file_type TEXT,
    extracted_text TEXT,
    added_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_companion_files_companion ON companion_files(companion_id, added_at DESC);

-- Settings (key-value store — GLOBAL per-user, not per-companion. API keys
-- and model prefs live here and are shared across all companions.)
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- MCP Servers (GLOBAL — tools are shared across all companions in v1.7.0)
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

-- Seed default companion (id=1 is the default used by DEFAULT constraint on
-- all scoped tables, so existing single-companion installs keep working).
INSERT OR IGNORE INTO companion (id, name) VALUES (1, 'Companion');
