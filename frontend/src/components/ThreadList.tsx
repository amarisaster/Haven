import { useState, useEffect } from 'react';
import type { Thread } from '../lib/types';
import { getThreads, deleteThread } from '../lib/api';
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
          threads.map(thread => (
            <button
              key={thread.id}
              onClick={() => onSelectThread(thread.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: '12px', width: '100%',
                padding: '14px 20px', background: 'transparent', border: 'none',
                borderBottom: '1px solid var(--haven-border)', cursor: 'pointer',
                textAlign: 'left', position: 'relative',
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
                  <span style={{ fontSize: '14px', fontWeight: 500, color: 'var(--haven-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {thread.title || 'New conversation'}
                  </span>
                  <span style={{ fontSize: '11px', color: 'var(--haven-text-muted)', flexShrink: 0, marginLeft: '8px' }}>
                    {formatTime(thread.last_message_at)}
                  </span>
                </div>
                <div style={{ fontSize: '12px', color: 'var(--haven-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  Tap to continue...
                </div>
              </div>
              {/* Delete */}
              <button
                onClick={(e) => handleDelete(e, thread.id)}
                style={{
                  position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)',
                  background: 'transparent', border: 'none', cursor: 'pointer',
                  color: 'var(--haven-text-muted)', opacity: 0, padding: '4px',
                }}
                className="thread-delete-btn"
              >
                <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                </svg>
              </button>
            </button>
          ))
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
