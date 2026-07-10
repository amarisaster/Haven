import { useEffect, useState } from 'react';
import type { Memory } from '../lib/api';
import { getMemories, addMemory, updateMemory, deleteMemory } from '../lib/api';

function formatWhen(dateStr?: string): string {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return 'today';
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// Companion memories — facts/preferences/events the companion has stored,
// either manually added here or auto-saved by proactive extraction/
// consolidation during chat. Mirrors FilesPanel's structure/styling.
export default function MemoriesPanel() {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newContent, setNewContent] = useState('');
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);

  const reload = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getMemories();
      setMemories(Array.isArray(data) ? data : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load memories');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { reload(); }, []);

  const onAdd = async () => {
    const content = newContent.trim();
    if (!content) return;
    setAdding(true);
    setError(null);
    try {
      await addMemory({ content });
      setNewContent('');
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Add failed');
    } finally {
      setAdding(false);
    }
  };

  const startEdit = (m: Memory) => {
    setEditingId(m.id);
    setEditContent(m.content);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditContent('');
  };

  const saveEdit = async (id: number) => {
    const content = editContent.trim();
    if (!content) return;
    setSaving(true);
    setError(null);
    try {
      await updateMemory({ id, content });
      setEditingId(null);
      setEditContent('');
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: number) => {
    if (!confirm('Delete this memory? This cannot be undone.')) return;
    try {
      await deleteMemory(id);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    }
  };

  return (
    <div>
      <p style={{ fontSize: '11px', color: 'var(--haven-text-muted)', marginBottom: '12px', lineHeight: '1.5' }}>
        Facts, preferences, and events the companion remembers. "auto" entries were saved automatically during chat — everything else was added here.
      </p>

      <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
        <input
          type="text"
          value={newContent}
          onChange={e => setNewContent(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') onAdd(); }}
          placeholder="Add a memory..."
          disabled={adding}
          style={{
            flex: 1, padding: '10px', borderRadius: '8px',
            background: 'var(--haven-card)', border: '1px solid var(--haven-border)',
            color: 'var(--haven-text)', fontSize: '13px',
          }}
        />
        <button
          onClick={onAdd}
          disabled={adding || !newContent.trim()}
          style={{
            padding: '10px 14px', borderRadius: '8px',
            background: 'var(--haven-card)', border: '1px dashed var(--haven-border)',
            color: 'var(--haven-text-secondary)', fontSize: '13px',
            cursor: adding || !newContent.trim() ? 'default' : 'pointer',
            opacity: adding || !newContent.trim() ? 0.6 : 1,
            whiteSpace: 'nowrap',
          }}
        >
          {adding ? 'Adding…' : '+ Add memory'}
        </button>
      </div>

      {error && (
        <p style={{ fontSize: '12px', color: '#f87171', marginBottom: '8px' }}>{error}</p>
      )}

      {loading ? (
        <p style={{ fontSize: '12px', color: 'var(--haven-text-muted)' }}>Loading…</p>
      ) : memories.length === 0 ? (
        <p style={{ fontSize: '12px', color: 'var(--haven-text-muted)' }}>No memories yet.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {memories.map(m => (
            <div
              key={m.id}
              style={{
                display: 'flex', alignItems: 'flex-start', gap: '8px',
                padding: '8px 10px', borderRadius: '8px',
                background: 'var(--haven-card)',
                border: '1px solid var(--haven-border)',
              }}
            >
              <span style={{ fontSize: '16px', flexShrink: 0 }}>🧠</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                {editingId === m.id ? (
                  <div>
                    <textarea
                      value={editContent}
                      onChange={e => setEditContent(e.target.value)}
                      rows={2}
                      style={{
                        width: '100%', padding: '6px 8px', borderRadius: '6px',
                        background: 'var(--haven-bg)', border: '1px solid var(--haven-border)',
                        color: 'var(--haven-text)', fontSize: '12px', resize: 'vertical',
                        marginBottom: '6px',
                      }}
                    />
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <button
                        onClick={() => saveEdit(m.id)}
                        disabled={saving || !editContent.trim()}
                        style={{
                          background: 'transparent', border: 'none', cursor: 'pointer',
                          color: 'var(--haven-text-secondary)', fontSize: '11px', padding: '2px 4px',
                        }}
                      >
                        {saving ? 'Saving…' : 'Save'}
                      </button>
                      <button
                        onClick={cancelEdit}
                        style={{
                          background: 'transparent', border: 'none', cursor: 'pointer',
                          color: 'var(--haven-text-muted)', fontSize: '11px', padding: '2px 4px',
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div style={{ fontSize: '12px', color: 'var(--haven-text)', lineHeight: '1.4' }}>
                      {m.content}
                      {(m.source === 'extracted' || m.source === 'consolidated') && (
                        <span style={{
                          marginLeft: '6px', fontSize: '9px', fontWeight: 600,
                          color: 'var(--haven-text-muted)', border: '1px solid var(--haven-border)',
                          borderRadius: '4px', padding: '1px 4px', verticalAlign: 'middle',
                        }}>
                          auto
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: '10px', color: 'var(--haven-text-muted)', marginTop: '2px' }}>
                      {[
                        m.memory_type,
                        `weight ${m.emotional_weight}`,
                        formatWhen(m.created_at),
                      ].filter(Boolean).join(' · ')}
                    </div>
                  </>
                )}
              </div>
              {editingId !== m.id && (
                <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                  <button
                    onClick={() => startEdit(m)}
                    style={{
                      background: 'transparent', border: 'none', cursor: 'pointer',
                      color: 'var(--haven-text-muted)', fontSize: '12px', padding: '4px 6px',
                    }}
                    title="Edit"
                    aria-label="Edit memory"
                  >
                    ✎
                  </button>
                  <button
                    onClick={() => remove(m.id)}
                    style={{
                      background: 'transparent', border: 'none', cursor: 'pointer',
                      color: 'var(--haven-text-muted)', fontSize: '14px', padding: '4px 6px',
                    }}
                    title="Delete"
                    aria-label="Delete memory"
                  >
                    ×
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
