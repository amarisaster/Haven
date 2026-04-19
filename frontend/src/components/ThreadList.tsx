import { useState, useEffect } from 'react';
import type { Thread } from '../lib/types';
import { getThreads, deleteThread, renameThread } from '../lib/api';
import CompanionSwitcher from './CompanionSwitcher';

interface ThreadListProps {
  companionName: string;
  companionAvatar: string;
  onSelectThread: (id: string) => void;
  onNewThread: () => void;
  onOpenSettings: () => void;
  onOpenImport: () => void;
  // v1.7 multi-companion — optional so older callers keep compiling.
  onSwitchCompanion?: (companionId: number) => void;
  onBackToGrid?: () => void;
  activeCompanionId?: number;
}

function formatTime(dateStr: string | null): string {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  const now = new Date();
  const diff = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
  if (diff === 0) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return date.toLocaleDateString([], { weekday: 'short' });
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export default function ThreadList({
  companionName, companionAvatar, onSelectThread, onNewThread, onOpenSettings, onOpenImport,
  onSwitchCompanion, onBackToGrid, activeCompanionId,
}: ThreadListProps) {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);

  // Dismiss the row menu when tapping anywhere else.
  useEffect(() => {
    if (!menuOpenId) return;
    const close = () => setMenuOpenId(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [menuOpenId]);

  const loadThreads = async () => {
    try {
      const data = await getThreads();
      setThreads(data);
    } catch {} finally {
      setLoading(false);
    }
  };

  // Reload threads when the active companion changes — the hook we're tied
  // to is activeCompanionId, which bumps whenever the switcher fires.
  useEffect(() => { loadThreads(); }, [activeCompanionId]);

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!confirm('Delete this thread?')) return;
    await deleteThread(id);
    loadThreads();
  };

  const startEdit = (e: React.MouseEvent, t: Thread) => {
    e.stopPropagation();
    setEditingId(t.id);
    setEditingTitle(t.title || '');
  };

  const commitEdit = async () => {
    if (!editingId) return;
    const title = editingTitle.trim();
    if (title) {
      try {
        await renameThread(editingId, title);
      } catch { /* silent — local list still shows old title which is fine */ }
    }
    setEditingId(null);
    setEditingTitle('');
    loadThreads();
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditingTitle('');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{
        display: 'flex', flexDirection: 'column', gap: '8px',
        padding: '16px 20px 12px', borderBottom: '1px solid var(--haven-border)',
        background: 'var(--haven-surface)',
      }}>
        {/* Companion switcher (v1.7) — only renders when there's >1 companion */}
        {onSwitchCompanion && onBackToGrid && activeCompanionId !== undefined && (
          <CompanionSwitcher
            activeId={activeCompanionId}
            onSwitch={onSwitchCompanion}
            onBackToGrid={onBackToGrid}
          />
        )}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div
          style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: onBackToGrid ? 'pointer' : 'default' }}
          onClick={onBackToGrid}
          title={onBackToGrid ? 'Back to companions' : undefined}
        >
          {companionAvatar ? (
            <img src={companionAvatar} alt="" style={{ width: '36px', height: '36px', borderRadius: '50%', objectFit: 'cover' }} />
          ) : (
            <div style={{
              width: '36px', height: '36px', borderRadius: '50%',
              background: 'var(--haven-accent)', display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'white', fontSize: '16px', fontWeight: 600,
            }}>
              {companionName.charAt(0)}
            </div>
          )}
          <div>
            <div style={{ fontSize: '16px', fontWeight: 600, color: 'var(--haven-text)' }}>{companionName}</div>
            <div style={{ fontSize: '11px', color: '#4ade80', display: 'flex', alignItems: 'center', gap: '4px' }}>
              <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#4ade80', display: 'inline-block' }} />
              online
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            onClick={onOpenImport}
            style={{
              width: '36px', height: '36px', borderRadius: '50%',
              background: 'transparent', border: 'none', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'var(--haven-text-muted)',
            }}
            title="Import conversations"
          >
            <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
            </svg>
          </button>
          <button
            onClick={onOpenSettings}
            style={{
              width: '36px', height: '36px', borderRadius: '50%',
              background: 'transparent', border: 'none', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'var(--haven-text-muted)',
            }}
            title="Settings"
          >
            <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>
        </div>
        </div>
      </div>

      {/* Thread list */}
      <div className="hide-scrollbar" style={{ flex: 1, overflowY: 'auto' }}>
        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '40px' }}>
            <div style={{
              width: '24px', height: '24px', border: '2px solid var(--haven-accent)',
              borderTopColor: 'transparent', borderRadius: '50%',
              animation: 'spin 0.8s linear infinite',
            }} />
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          </div>
        ) : threads.length === 0 ? (
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            justifyContent: 'center', height: '100%', padding: '40px', textAlign: 'center',
          }}>
            <div style={{ fontSize: '48px', marginBottom: '16px' }}>💬</div>
            <p style={{ fontSize: '15px', color: 'var(--haven-text)', marginBottom: '4px' }}>No conversations yet</p>
            <p style={{ fontSize: '12px', color: 'var(--haven-text-muted)', marginBottom: '20px' }}>Start a new conversation with {companionName}</p>
          </div>
        ) : (
          threads.map(thread => {
            const isEditing = editingId === thread.id;
            return (
              <div
                key={thread.id}
                onClick={() => { if (!isEditing) onSelectThread(thread.id); }}
                style={{
                  display: 'flex', alignItems: 'center', gap: '12px', width: '100%',
                  padding: '14px 20px', background: 'transparent',
                  borderBottom: '1px solid var(--haven-border)', cursor: isEditing ? 'default' : 'pointer',
                  textAlign: 'left',
                }}
              >
                {/* Avatar */}
                {companionAvatar ? (
                  <img src={companionAvatar} alt="" style={{ width: '44px', height: '44px', borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
                ) : (
                  <div style={{
                    width: '44px', height: '44px', borderRadius: '50%', flexShrink: 0,
                    background: 'var(--haven-accent)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    color: 'white', fontSize: '18px', fontWeight: 600,
                  }}>
                    {companionName.charAt(0)}
                  </div>
                )}
                {/* Thread info */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2px' }}>
                    {isEditing ? (
                      <input
                        autoFocus
                        value={editingTitle}
                        onChange={(e) => setEditingTitle(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { e.preventDefault(); commitEdit(); }
                          else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
                        }}
                        onBlur={commitEdit}
                        style={{
                          flex: 1, fontSize: '14px', fontWeight: 500,
                          background: 'var(--haven-card)', border: '1px solid var(--haven-accent)',
                          borderRadius: '6px', padding: '4px 8px', color: 'var(--haven-text)',
                          outline: 'none', minWidth: 0,
                        }}
                      />
                    ) : (
                      <>
                        <span style={{ fontSize: '14px', fontWeight: 500, color: 'var(--haven-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {thread.title || 'New conversation'}
                        </span>
                        <span style={{ fontSize: '11px', color: 'var(--haven-text-muted)', flexShrink: 0, marginLeft: '8px' }}>
                          {formatTime(thread.last_message_at)}
                        </span>
                      </>
                    )}
                  </div>
                  {!isEditing && (
                    <div style={{ fontSize: '12px', color: 'var(--haven-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      Tap to continue...
                    </div>
                  )}
                </div>
                {/* Per-row overflow menu — holds rename + delete behind a
                    single ⋯ button so the thread list stays clean. Matches
                    the chat-header pattern. */}
                {!isEditing && (
                  <div style={{ position: 'relative', flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setMenuOpenId(menuOpenId === thread.id ? null : thread.id);
                      }}
                      style={{
                        background: 'transparent', border: 'none', cursor: 'pointer',
                        color: 'var(--haven-text-muted)', opacity: 0.6, padding: '6px',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}
                      title="More"
                      aria-label="Thread actions"
                    >
                      <svg width="18" height="18" fill="currentColor" viewBox="0 0 24 24">
                        <circle cx="5" cy="12" r="1.6" />
                        <circle cx="12" cy="12" r="1.6" />
                        <circle cx="19" cy="12" r="1.6" />
                      </svg>
                    </button>
                    {menuOpenId === thread.id && (
                      <div
                        style={{
                          position: 'absolute', top: '100%', right: 0, marginTop: '4px',
                          minWidth: '140px', zIndex: 10,
                          background: 'var(--haven-surface)',
                          border: '1px solid var(--haven-border)', borderRadius: '8px',
                          boxShadow: '0 4px 12px rgba(0,0,0,0.3)', padding: '4px',
                        }}
                      >
                        <button
                          onClick={(e) => { e.stopPropagation(); setMenuOpenId(null); startEdit(e, thread); }}
                          style={{
                            width: '100%', padding: '8px 12px', background: 'transparent',
                            border: 'none', color: 'var(--haven-text)', fontSize: '13px',
                            cursor: 'pointer', textAlign: 'left', borderRadius: '6px',
                          }}
                        >Rename</button>
                        <button
                          onClick={(e) => { e.stopPropagation(); setMenuOpenId(null); handleDelete(e, thread.id); }}
                          style={{
                            width: '100%', padding: '8px 12px', background: 'transparent',
                            border: 'none', color: '#f87171', fontSize: '13px',
                            cursor: 'pointer', textAlign: 'left', borderRadius: '6px',
                          }}
                        >Delete</button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* New message FAB */}
      <button
        onClick={onNewThread}
        style={{
          position: 'fixed', bottom: '24px', right: '24px',
          width: '56px', height: '56px', borderRadius: '50%',
          background: 'var(--haven-accent)', border: 'none', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
          transition: 'transform 0.2s',
        }}
        title="New conversation"
      >
        <svg width="24" height="24" fill="none" stroke="white" viewBox="0 0 24 24" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
        </svg>
      </button>
    </div>
  );
}
