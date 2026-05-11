import { useState, useEffect } from 'react';
import type { Thread } from '../lib/types';
import { getThreads, createThread, deleteThread } from '../lib/api';
import { deleteWallpaper } from '../lib/wallpaper-store';

interface SidebarProps {
  activeThreadId: string | null;
  onSelectThread: (id: string) => void;
  onNewThread: (id: string) => void;
  isOpen: boolean;
  onClose: () => void;
  companionName: string;
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

export default function Sidebar({ activeThreadId, onSelectThread, onNewThread, isOpen, onClose, companionName }: SidebarProps) {
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

  useEffect(() => { loadThreads(); }, []);

  const handleNew = async () => {
    const result = await createThread();
    if (result?.id) {
      onNewThread(result.id);
      loadThreads();
    }
  };

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!confirm('Delete this thread?')) return;
    await deleteThread(id);
    deleteWallpaper(`wp-${id}`).catch(() => {});
    loadThreads();
  };

  return (
    <>
      {/* Mobile overlay */}
      {isOpen && (
        <div className="fixed inset-0 bg-black/50 z-40 lg:hidden" onClick={onClose} />
      )}

      <aside className={`
        fixed lg:relative top-0 left-0 h-full z-50
        w-72 bg-[var(--haven-surface)] border-r border-[var(--haven-border)]
        flex flex-col transition-transform duration-200
        ${isOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
      `}>
        {/* Header */}
        <div className="p-4 border-b border-[var(--haven-border)]">
          <div className="flex items-center justify-between mb-3">
            <h1 className="text-sm font-semibold text-[var(--haven-text)]">{companionName}</h1>
            <button onClick={onClose} className="lg:hidden text-[var(--haven-text-muted)]">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <button
            onClick={handleNew}
            className="w-full py-2 text-xs font-medium bg-[var(--haven-accent)] text-white rounded-lg hover:opacity-90 transition-opacity"
          >
            + New Thread
          </button>
        </div>

        {/* Thread list */}
        <div className="flex-1 overflow-y-auto hide-scrollbar">
          {loading ? (
            <div className="flex justify-center py-8">
              <div className="w-5 h-5 border-2 border-[var(--haven-accent)] border-t-transparent rounded-full animate-spin" />
            </div>
          ) : threads.length === 0 ? (
            <p className="text-center text-xs text-[var(--haven-text-muted)] py-8">No threads yet</p>
          ) : (
            threads.map(thread => (
              <button
                key={thread.id}
                onClick={() => { onSelectThread(thread.id); onClose(); }}
                className={`w-full text-left px-4 py-3 border-b border-[var(--haven-border)] hover:bg-[var(--haven-card)] transition-colors group ${
                  activeThreadId === thread.id ? 'bg-[var(--haven-card)]' : ''
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm text-[var(--haven-text)] truncate flex-1">
                    {thread.title || 'New conversation'}
                  </span>
                  <span className="text-[10px] text-[var(--haven-text-muted)] ml-2 shrink-0">
                    {formatTime(thread.last_message_at)}
                  </span>
                </div>
                {/* Delete on hover */}
                <button
                  onClick={(e) => handleDelete(e, thread.id)}
                  className="hidden group-hover:block absolute right-2 top-1/2 -translate-y-1/2 text-[var(--haven-text-muted)] hover:text-red-400"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                  </svg>
                </button>
              </button>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="p-3 border-t border-[var(--haven-border)]">
          <a href="/settings" className="flex items-center gap-2 text-xs text-[var(--haven-text-muted)] hover:text-[var(--haven-text-secondary)]">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            Settings
          </a>
        </div>
      </aside>
    </>
  );
}
